import { Order, IOrder }        from '../models/Order.model';
import { Dispute }              from '../models/Dispute.model';
import { RefundRequest }        from '../models/RefundRequest.model';
import { Transaction }          from '../models/Transaction.model';
import { Wallet }               from '../models/Wallet.model';
import { Notification }        from '../models/Notification.model';
import { User }                 from '../models/User.model';
import { Settings }             from '../models/Settings.model';
import { walletService }        from './wallet.service';
import { notificationService }  from './notification.service';
import { workerLevelService }   from './workerLevel.service';
import { paymentService }       from './payment.service';
import { startOrderTimer, clearOrderTimer } from '../utils/orderTimer';
import { checkEmailExists } from '../utils/emailVerification';
import { isPermanentLock } from '../utils/permanentLock';
import { emitToUser, emitToMarketplace, EVENTS } from '../socket/events';

const throwErr = (msg: string, code = 400): never => {
  throw Object.assign(new Error(msg), { statusCode: code });
};

// ─── Settings cache (5-minute TTL) ───────────────────────────────────────────
const settingsCache: Record<string, { value: string; expiresAt: number }> = {};
const SETTINGS_TTL = 5 * 60 * 1000; // 5 minutes

const getSetting = async (key: string, fallback: string): Promise<string> => {
  const now = Date.now();
  if (settingsCache[key] && settingsCache[key].expiresAt > now) {
    return settingsCache[key].value;
  }
  const s = await Settings.findOne({ key }).lean();
  const value = s?.value ?? fallback;
  settingsCache[key] = { value, expiresAt: now + SETTINGS_TTL };
  return value;
};

export const invalidateSettingsCache = (): void => {
  Object.keys(settingsCache).forEach(k => delete settingsCache[k]);
};

// FIX: 'orderPrice'/'workerEarning' are gone — customer now sets their own
// amount. Expanded to include orderTimerMinutes/autoCompleteHours too — these
// were previously hardcoded ("10 minutes", "24 hours") in several frontend
// pages instead of being read from here, so admin changes to those settings
// never actually showed up anywhere outside the Settings page itself.
export const getPublicSettings = async (): Promise<{
  minimumOrderAmount: number;
  platformCommissionRate: number;
  orderTimerMinutes: number;
  autoCompleteHours: number;
}> => {
  const [minimumOrderAmount, platformCommissionRate, orderTimerMinutes, autoCompleteHours] = await Promise.all([
    getSetting('minimumOrderAmount', '15'),
    getSetting('platformCommissionRate', '15'),
    getSetting('orderTimerMinutes', '10'),
    getSetting('autoCompleteHours', '24'),
  ]);
  return {
    minimumOrderAmount: parseInt(minimumOrderAmount),
    platformCommissionRate: parseInt(platformCommissionRate),
    orderTimerMinutes: parseInt(orderTimerMinutes),
    autoCompleteHours: parseInt(autoCompleteHours),
  };
};

// ── Customer: pre-payment "Check" button ─────────────────────────────────────
// Called directly from the order-creation modal's Check button, BEFORE the
// customer sees a Pay button at all — so they never even reach payment on
// an address someone already owns. createOrder() below calls this same
// function again right before actually creating the order, as a second
// safety net for the case where the customer checked once, then waited a
// while (or someone else grabbed the address) before actually submitting.
export const checkEmailAvailability = async (
  domain: string,
  customLocalPart: string
): Promise<{ email: string; available: boolean; checked: boolean }> => {
  const email = `${customLocalPart.trim().toLowerCase()}@${domain}`;
  const result = await checkEmailExists(email);
  return {
    email,
    // 'unknown' (API down/misconfigured/timeout) is treated as available —
    // we never want a third-party outage to block genuine customers from
    // ordering. `checked` tells the frontend whether this was a real
    // verified answer or just a pass-through default, so it can show
    // "couldn't verify, proceeding anyway" instead of a false "Available!".
    available: result !== 'valid',
    checked: result !== 'unknown',
  };
};

export const orderService = {
  // ── Customer: create order ────────────────────────────────────────────────
  // REWORKED for Cashfree integration:
  //   1. Customer now sets their own `amount` — validated here against the
  //      LIVE minimumOrderAmount setting (Zod only enforces a bare ₹1
  //      sanity floor, not the real business minimum — see order.validator.ts).
  //   2. Commission (15%) is computed and LOCKED at creation time — later
  //      changes to platformCommissionRate never retroactively affect
  //      already-created orders.
  //   3. Phone number is required by Cashfree — reused from the customer's
  //      profile if already saved, otherwise the provided value is saved
  //      to their profile for next time.
  //   4. The order starts as 'payment_pending' — NOT visible in the
  //      marketplace — and a corresponding Cashfree order is created.
  //      It only becomes 'pending' (marketplace-visible) once
  //      paymentService confirms the payment succeeded (webhook or verify).
  async createOrder(
    customerId: string,
    serviceName: string,
    domain: string,
    emailType: 'random' | 'custom',
    amount: number,
    customLocalPart?: string,
    useWalletCredit?: boolean
  ): Promise<{ order: IOrder; paymentSessionId: string | null; paidWithWallet: boolean }> {
    const minAmount = parseInt(await getSetting('minimumOrderAmount', '15'));
    if (amount < minAmount) {
      throwErr(`Minimum order amount is ₹${minAmount}.`, 400);
    }

    const commissionPercent = parseInt(await getSetting('platformCommissionRate', '15'));
    const commissionRate    = commissionPercent / 100;

    // Round to 2 decimals to avoid floating-point cents (e.g. 33.333333...)
    const platformCommission = Math.round(amount * commissionRate * 100) / 100;
    const workerEarning      = Math.round((amount - platformCommission) * 100) / 100;

    // 'custom': requestedEmail is the exact address the worker must create.
    // 'random': requestedEmail stays unset — the worker submits ANY address
    // on `domain` (see submitCredentials() below), so no fake email needs
    // to be manufactured here at all.
    const requestedEmail = emailType === 'custom'
      ? `${customLocalPart!.trim().toLowerCase()}@${domain}`
      : undefined;

    // For custom requests, check up front that this exact address doesn't
    // already exist — two reasons: (1) saves the customer from paying for
    // an order nobody could ever fulfill, and (2) establishes a clean
    // baseline for the theft check later (see utils/orderTimer.ts
    // handleOrderTimerExpiry()) — if it's confirmed to NOT exist now, then
    // existing right after a worker abandons it is meaningful evidence,
    // not a false alarm from an address that was already taken before
    // this order ever existed.
    if (requestedEmail) {
      const preCheck = await checkEmailExists(requestedEmail);
      if (preCheck === 'valid') {
        throwErr(
          'This email address is already taken. Please choose a different name.',
          409
        );
      }
      // NOTE: 'unknown' (API misconfigured/down/timeout) is intentionally
      // allowed through — see checkEmailAvailability() above for why. The
      // frontend's "Check" button already gave the customer a chance to
      // verify up front; this is just the final safety net right before
      // the order is actually created.
    }

    const customer = await User.findById(customerId);
    if (!customer) throwErr('Customer not found.', 404);

    // Phone is now mandatory + verified at registration/profile level (see
    // auth.service.ts register() / user.routes.ts PUT /profile) — no more
    // collecting/saving it here as a fallback. Any customer without a
    // verified phone (pre-Phase-4 accounts that haven't added one yet)
    // gets stopped here with a clear message pointing them to their
    // profile, rather than silently failing later at the Cashfree step.
    if (!customer!.phoneVerified || !customer!.phone) {
      throwErr('Please add and verify a phone number in your profile before placing an order.', 400);
    }
    const finalPhone = customer!.phone!;

    // NEW: pay with wallet credit (from a previous refund) — applies as
    // much of the customer's balance as covers this order, up to the full
    // amount. If it fully covers the order, Cashfree is skipped entirely.
    // Otherwise the remainder goes through Cashfree as normal — e.g. ₹30
    // wallet credit on a ₹70 order means ₹30 is deducted now and the
    // customer only pays ₹40 via Cashfree.
    let walletAmountApplied = 0;
    if (useWalletCredit) {
      const wallet = await walletService.getBalance(customerId);
      const toApply = Math.min(wallet.balance, amount);
      if (toApply > 0) {
        // Atomic check-and-debit — the `balance: { $gte: toApply }` filter
        // means this simply fails to match (returns null) if another
        // request already spent the balance in the meantime (e.g. two
        // tabs open), same safety pattern as walletService.debit().
        const debited = await Wallet.findOneAndUpdate(
          { userId: customerId, balance: { $gte: toApply } },
          { $inc: { balance: -toApply } },
          { new: true }
        );
        if (debited) walletAmountApplied = toApply;
      }
    }

    const remainingAmount = Math.round((amount - walletAmountApplied) * 100) / 100;

    const order = await Order.create({
      customerId,
      serviceName: serviceName.trim(),
      amount,
      workerEarning,
      platformCommission,
      commissionRate,
      requestedEmail,
      domain,
      emailType,
      status: 'payment_pending',
      paymentStatus: 'pending',
      walletAmountApplied,
    });

    if (walletAmountApplied > 0) {
      const orderRef = order._id.toString().slice(-6).toUpperCase();
      await Transaction.create({
        userId: customerId, orderId: order._id, type: 'debit', amount: walletAmountApplied,
        status: 'completed',
        description: remainingAmount === 0
          ? `Wallet payment: Order #${orderRef}`
          : `Wallet credit applied: Order #${orderRef} (₹${remainingAmount} paid via Cashfree)`,
      });
    }

    if (remainingAmount === 0) {
      // Reuses the exact same idempotent transition + marketplace
      // broadcast + worker push-notification logic that a normal Cashfree
      // webhook triggers — no duplicated logic, no separate code path that
      // could drift out of sync with the "real" payment flow.
      await paymentService.confirmPaymentSuccess(order._id.toString());
      return { order, paymentSessionId: null, paidWithWallet: true };
    }

    try {
      const { paymentSessionId, cashfreeOrderId } = await paymentService.createCashfreeOrder(
        order._id.toString(),
        remainingAmount,
        customerId,
        customer!.email,
        finalPhone
      );

      order.cashfreeOrderId = cashfreeOrderId;
      await order.save();

      return { order, paymentSessionId, paidWithWallet: false };
    } catch (err) {
      // Cashfree order creation failed — don't leave our order stuck in
      // limbo forever; mark it failed so the customer can simply try again.
      order.status = 'payment_failed';
      order.paymentStatus = 'failed';
      await order.save();

      // Refund any wallet credit that was already deducted above — the
      // customer shouldn't lose real credit just because Cashfree's side
      // never even got created.
      if (walletAmountApplied > 0) {
        const orderRef = order._id.toString().slice(-6).toUpperCase();
        await walletService.creditRefund(
          customerId, walletAmountApplied, order._id,
          `Refund: Order #${orderRef} payment setup failed — wallet portion returned`
        );
      }

      throw err;
    }
  },

  // ── Customer: cancel a pending (not yet accepted) order ───────────────────
  // FIX: previously this only marked the order 'cancelled' with no way for
  // the customer to ever get their money back — Cashfree payment had
  // already succeeded by the time an order reaches 'pending', so real
  // money was stuck. Now credits the amount straight to their wallet,
  // usable immediately on their next order — no manual refund request needed.
  async cancelOrder(orderId: string, customerId: string): Promise<IOrder> {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, customerId, status: 'pending', workerId: null },
      { status: 'cancelled' },
      { new: true }
    );
    if (!order) {
      throwErr('Only pending orders (not yet accepted by a worker) can be cancelled.', 400);
    }

    const orderRef = order!._id.toString().slice(-6).toUpperCase();
    await walletService.creditRefund(
      customerId, order!.amount, order!._id,
      `Refund: Order #${orderRef} (cancelled before a worker accepted)`
    );
    await notificationService.create({
      userId: customerId,
      title: '💰 Refund Credited',
      message: `Order #${orderRef} was cancelled and ₹${order!.amount} has been credited to your Mailzeon wallet — use it on your next order.`,
      type: 'order',
      orderId: order!._id,
    });

    return order!;
  },

  // ── Marketplace: orders available for workers ─────────────────────────────
  // FIX: also hides the customer's full `amount`/commission breakdown here —
  // this is the list workers browse BEFORE accepting, so the leak applied
  // even earlier than getOrder()/getWorkerOrders() below.
  // Masks the local-part of a requested email so browsing (not-yet-accepted)
  // workers can't just go create the exact address themselves outside the
  // platform — they only learn the real address after formally accepting
  // the order. Domain stays fully visible (that's not sensitive — it's
  // literally the order's category), only the chosen name is hidden.
  // Fixed dot count (not proportional to the real length) on purpose — so
  // even the LENGTH of the local-part isn't something a browsing worker
  // could infer.
  maskRequestedEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return email;
    const visible = local.slice(0, 1);
    return `${visible}••••••@${domain}`;
  },

  // Worker-facing order responses must NEVER reveal that a referral
  // deduction happened — no tax rate, no raw/gross figure to compare
  // against, nothing. workerEarning is silently replaced with the net
  // amount so the order looks completely indistinguishable from one with
  // no referral involved at all. Only ever called on worker-facing paths —
  // admin/dispute views intentionally keep the real fields.
  applyReferralDeduction(orderObj: any): any {
    if (orderObj.referralTaxAmount) {
      orderObj.workerEarning = Math.round((orderObj.workerEarning - orderObj.referralTaxAmount) * 100) / 100;
    }
    delete orderObj.referralTaxAmount;
    delete orderObj.referralTaxRate;
    delete orderObj.referrerId;
    return orderObj;
  },

  async getMarketplaceOrders(workerId: string): Promise<IOrder[]> {
    const [orders, worker] = await Promise.all([
      Order.find({ status: 'pending', workerId: null })
        .sort({ createdAt: -1 })
        .select('-credentials -amount -platformCommission -commissionRate')
        .lean(),
      User.findById(workerId).select('referredBy').lean(),
    ]);

    // If THIS worker was referred, show every order's earning already net
    // of the referral tax they'll actually pay — completely silently, no
    // indication a deduction happened. A non-referred worker viewing the
    // exact same order sees the full, untaxed amount; nothing on the order
    // document itself changes here, this is purely a per-viewer display
    // adjustment.
    let taxRate = 0;
    if (worker?.referredBy) {
      taxRate = parseFloat(await getSetting('referralTaxRate', '3'));
    }

    const adjusted = orders.map(o => ({
      ...o,
      requestedEmail: o.requestedEmail ? orderService.maskRequestedEmail(o.requestedEmail) : o.requestedEmail,
      workerEarning: taxRate > 0
        ? Math.round(o.workerEarning * (1 - taxRate / 100) * 100) / 100
        : o.workerEarning,
    }));

    return adjusted as unknown as IOrder[];
  },

  // ── Worker: atomically accept an order ───────────────────────────────────
  async acceptOrder(orderId: string, workerId: string, workerName: string): Promise<IOrder> {
    // Dispute-strike lock — see user.service.ts applyStrike(). A locked
    // worker still sees this order in the marketplace, they just can't
    // take it until the lock expires.
    const worker = await User.findById(workerId).select('lockedUntil referredBy phone phoneVerified');
    if (worker?.lockedUntil && worker.lockedUntil > new Date()) {
      if (isPermanentLock(worker.lockedUntil)) {
        throwErr('Your account has been permanently banned and can no longer accept orders.', 403);
      }
      const msRemaining = worker.lockedUntil.getTime() - Date.now();
      const hoursRemaining = Math.ceil(msRemaining / (60 * 60 * 1000));
      const label = hoursRemaining >= 24
        ? `${Math.ceil(hoursRemaining / 24)} day(s)`
        : `${hoursRemaining} hour(s)`;
      throwErr(
        `Your account is locked for ${label} due to a dispute resolved against you. You can't accept orders until the lock ends.`,
        403
      );
    }

    // Phone is mandatory + verified before a worker can accept any order —
    // see auth.service.ts register() / user.routes.ts PUT /profile. Same
    // gate as the customer side in createOrder() above, applied here for
    // workers who signed up before this was required.
    if (!worker?.phoneVerified || !worker?.phone) {
      throwErr('Please add and verify a phone number in your profile before accepting orders.', 403);
    }

    const timerMinutes = parseInt(await getSetting('orderTimerMinutes', '10'));
    const now          = new Date();
    const timerExpires = new Date(now.getTime() + timerMinutes * 60 * 1000);

    const updateFields: Record<string, unknown> = {
      status: 'accepted', workerId, acceptedAt: now, timerExpiresAt: timerExpires,
    };

    // Referral tax — locked in NOW (at accept time), not derived later, so
    // it stays fixed at whatever rate applied the moment this worker took
    // the job even if the setting changes afterward. See wallet.service.ts
    // settleOrderEarnings() for where this actually gets paid out.
    if (worker?.referredBy) {
      const taxRate = parseFloat(await getSetting('referralTaxRate', '3'));
      updateFields.referralTaxRate = taxRate;
      updateFields.referrerId = worker.referredBy;
    }

    const order = await Order.findOneAndUpdate(
      { _id: orderId, status: 'pending', workerId: null },
      updateFields,
      { new: true }
    );

    if (!order) throwErr('This order is no longer available.', 409);

    // Needs order.workerEarning, which we only have AFTER the update above
    // resolves — a second small write, but only for referred workers.
    if (worker?.referredBy && order!.referralTaxRate) {
      order!.referralTaxAmount = Math.round(order!.workerEarning * (order!.referralTaxRate / 100) * 100) / 100;
      await order!.save();
    }

    const customerId = order!.customerId.toString();
    startOrderTimer(orderId, workerId, customerId, timerMinutes);

    await notificationService.create({
      userId:  customerId,
      title:   '🎉 Worker Assigned!',
      message: `A worker has accepted your order and will submit credentials within ${timerMinutes} minutes.`,
      type:    'order',
      orderId: order!._id,
    });

    emitToUser(customerId, EVENTS.ORDER_ACCEPTED, { orderId, workerName });
    return orderService.applyReferralDeduction(order!.toObject()) as unknown as IOrder;
  },

  // ── Worker: submit credentials ────────────────────────────────────────────
  async submitCredentials(
    orderId: string,
    workerId: string,
    credentials: { email: string; password: string; notes?: string },
    acknowledgedNoPhone: boolean
  ): Promise<IOrder> {
    if (!acknowledgedNoPhone) {
      throwErr('You must confirm this account has no phone number linked before submitting.', 400);
    }

    const order = await Order.findOne({ _id: orderId, workerId, status: 'accepted' });
    if (!order) throwErr('Order not found or not in accepted state.', 404);

    const submittedEmail = credentials.email.trim().toLowerCase();

    if (order.emailType === 'custom') {
      // Customer asked for one exact address — no substitutions allowed.
      if (order.requestedEmail && submittedEmail !== order.requestedEmail.toLowerCase()) {
        throwErr(`Submitted email must exactly match the requested email: ${order.requestedEmail}`, 400);
      }
    } else {
      // 'random' — any address works, old or newly created, as long as
      // it's actually on the domain the customer chose (e.g. they picked
      // Gmail, so a Yahoo address doesn't count even though "any" account
      // is otherwise fine).
      // Guard against legacy orders created before the domain field
      // existed — nothing to validate against, so just allow it through
      // rather than crashing on `undefined.toLowerCase()`.
      if (order.domain && !submittedEmail.endsWith(`@${order.domain.toLowerCase()}`)) {
        throwErr(`Submitted email must be a @${order.domain} address.`, 400);
      }
    }

    clearOrderTimer(orderId);

    const autoHours = parseInt(await getSetting('autoCompleteHours', '24'));
    const now       = new Date();
    const autoAt    = new Date(now.getTime() + autoHours * 60 * 60 * 1000);

    order!.status                 = 'credentials_submitted';
    order!.credentials            = credentials;
    order!.credentialsSubmittedAt = now;
    order!.autoCompleteAt         = autoAt;
    await order!.save();

    await walletService.moveToPending(
      workerId,
      order!.workerEarning,
      order!._id,
      `Pending: Order #${order!._id.toString().slice(-6).toUpperCase()}`
    );

    const customerId = order!.customerId.toString();
    await notificationService.create({
      userId:  customerId,
      title:   '✅ Credentials Ready!',
      message: 'The worker has submitted your account details. Open your order to view the password.',
      type:    'order',
      orderId: order!._id,
    });

    emitToUser(customerId, EVENTS.CREDENTIALS_READY, { orderId });
    return orderService.applyReferralDeduction(order!.toObject()) as unknown as IOrder;
  },

  // ── Customer: submit the verification number they see on their Google
  //    "new device" login screen — for the case where Google shows a
  //    "select this number on your other device" prompt. If Google instead
  //    just gives a plain code, the customer uses requestVerificationCode()
  //    below instead. Also used to RESUBMIT if the previous number expired
  //    (Google numbers are only valid ~1 minute).
  async submitVerificationNumber(orderId: string, customerId: string, number: string): Promise<IOrder> {
    const order = await Order.findOne({
      _id: orderId, customerId,
      status: { $in: ['credentials_submitted', 'verification_pending'] },
    });
    if (!order) throwErr('Order must have credentials submitted to send a verification number.', 400);

    order!.status = 'verification_pending';
    order!.verificationMethod = 'number';
    order!.verificationCode = number.trim();
    order!.verificationConfirmed = false;
    await order!.save();

    const workerId = order!.workerId!.toString();
    await notificationService.create({
      userId:  workerId,
      title:   '🔢 Verification Number Received',
      message: `Select "${number.trim()}" on your Google prompt for this account, then confirm in the app.`,
      type:    'verification',
      orderId: order!._id,
    });

    emitToUser(workerId, EVENTS.NUMBER_SUBMITTED, { orderId, number: number.trim() });
    return order!;
  },

  // ── Worker: confirm they selected the matching number on their own
  //    logged-in device's Google prompt. No code is typed here — the app
  //    is just relaying the customer's real-world confirmation status.
  async confirmVerificationNumber(orderId: string, workerId: string): Promise<IOrder> {
    const order = await Order.findOne({
      _id: orderId, workerId, status: 'verification_pending',
      verificationMethod: 'number', verificationCode: { $exists: true, $ne: null },
    });
    if (!order) throwErr('Order not found, not in verification state, or no number submitted yet.', 400);

    order!.verificationConfirmed = true;
    await order!.save();

    const customerId = order!.customerId.toString();
    await notificationService.create({
      userId:  customerId,
      title:   '✅ Worker Confirmed',
      message: 'The worker selected your number on their device. Try logging in now.',
      type:    'verification',
      orderId: order!._id,
    });

    emitToUser(customerId, EVENTS.NUMBER_CONFIRMED, { orderId });
    return orderService.applyReferralDeduction(order!.toObject()) as unknown as IOrder;
  },

  // ── Customer: request an actual CODE instead — for the case where Google
  //    doesn't show the "select a number" prompt and just gives/texts a
  //    plain code instead. The worker (who has access to the account, e.g.
  //    via an authenticator app or the recovery contact) sends that code
  //    back below.
  async requestVerificationCode(orderId: string, customerId: string): Promise<IOrder> {
    const order = await Order.findOne({
      _id: orderId, customerId,
      status: { $in: ['credentials_submitted', 'verification_pending'] },
    });
    if (!order) throwErr('Order must have credentials submitted to request a code.', 400);

    order!.status = 'verification_pending';
    order!.verificationMethod = 'code';
    order!.verificationCode = undefined;
    order!.verificationConfirmed = false;
    await order!.save();

    const workerId = order!.workerId!.toString();
    await notificationService.create({
      userId:  workerId,
      title:   '🔑 Verification Code Requested',
      message: 'The customer needs a login code for this account — check for it and send it in the app.',
      type:    'verification',
      orderId: order!._id,
    });

    emitToUser(workerId, EVENTS.CODE_REQUESTED, { orderId });
    return order!;
  },

  // ── Worker: send the actual code back to the customer ─────────────────
  async submitVerificationCode(orderId: string, workerId: string, code: string): Promise<IOrder> {
    const order = await Order.findOne({
      _id: orderId, workerId, status: 'verification_pending', verificationMethod: 'code',
    });
    if (!order) throwErr('Order not found, not in verification state, or no code was requested.', 400);

    order!.verificationCode = code.trim();
    await order!.save();

    const customerId = order!.customerId.toString();
    await notificationService.create({
      userId:  customerId,
      title:   '✅ Verification Code Received',
      message: 'The worker sent your login code. Open your order to view it.',
      type:    'verification',
      orderId: order!._id,
    });

    emitToUser(customerId, EVENTS.CODE_RECEIVED, { orderId, code: code.trim() });
    return orderService.applyReferralDeduction(order!.toObject()) as unknown as IOrder;
  },

  // ── Customer: confirm successful login ────────────────────────────────────
  async confirmSuccess(orderId: string, customerId: string): Promise<IOrder> {
    const order = await Order.findOne({
      _id: orderId,
      customerId,
      status: { $in: ['credentials_submitted', 'verification_pending', 'success_confirmed'] },
    });
    if (!order || !order.workerId) throwErr('Order not found or not eligible for confirmation.', 404);

    order.status      = 'completed';
    order.completedAt = new Date();
    await order.save();

    const workerId = order.workerId!.toString();

    await walletService.settleOrderEarnings(
      order,
      `Earned: Order #${order._id.toString().slice(-6).toUpperCase()}`
    );

    await Promise.all([
      notificationService.create({
        userId:  workerId,
        title:   `₹${order.workerEarning} Credited!`,
        message: `Your earnings for Order #${order._id.toString().slice(-6).toUpperCase()} have been released to your wallet.`,
        type:    'order',
        orderId: order._id,
      }),
      notificationService.create({
        userId:  customerId,
        title:   '🎉 Order Completed!',
        message: 'Your order has been completed successfully. Thank you!',
        type:    'order',
        orderId: order._id,
      }),
    ]);

    emitToUser(workerId,   EVENTS.ORDER_COMPLETED, { orderId });
    emitToUser(customerId, EVENTS.ORDER_COMPLETED, { orderId });

    workerLevelService.recalculate(workerId).catch(err =>
      console.error('[WorkerLevel] Recalculate error after confirmSuccess:', err)
    );

    return order;
  },

  // ── Customer: report problem ──────────────────────────────────────────────
  async reportProblem(
    orderId: string,
    customerId: string,
    reason: string = 'other',
    description?: string
  ): Promise<IOrder> {
    const order = await Order.findOne({
      _id: orderId,
      customerId,
      status: { $in: ['credentials_submitted', 'verification_pending'] },
    });
    if (!order) throwErr('This order cannot be disputed in its current state.', 400);
    if (!order.workerId) throwErr('No worker assigned to this order.', 400);

    order.status = 'under_review';
    await order.save();

    const existing = await Dispute.findOne({ orderId: order._id });
    if (!existing) {
      await Dispute.create({
        orderId:    order._id,
        customerId: order.customerId,
        workerId:   order.workerId,
        reason,
        description,
      });

      const admins = await User.find({ role: 'admin' }).select('_id');
      if (admins.length > 0) {
        await Notification.insertMany(admins.map(a => ({
          userId:    a._id,
          title:     '🚨 New Dispute',
          message:   `Customer raised a dispute for Order #${order._id.toString().slice(-6).toUpperCase()}.`,
          type:      'dispute',
          orderId:   order._id,
          isRead:    false,
          createdAt: new Date(),
        })));
      }
    }

    return order;
  },

  // ── Get single order (role-filtered) ─────────────────────────────────────
  async getOrder(orderId: string, userId: string, role: string): Promise<IOrder> {
    const order = await Order.findById(orderId);
    if (!order) throwErr('Order not found.', 404);

    const isCustomer = role === 'customer' && order!.customerId.toString() === userId;
    const isWorker   = role === 'worker'   && order!.workerId?.toString()  === userId;
    const isAdmin    = role === 'admin';

    if (!isCustomer && !isWorker && !isAdmin) throwErr('Access denied.', 403);

    if (role === 'customer') {
      const safe = order!.toObject();

      let refundEligible = false;
      let refundStatus: string | null = null;
      let walletCredited = false;

      if (safe.status === 'cancelled') {
        // NEW system (from this update onward): cancelOrder()/dispute
        // resolution/auto-cancel now credit the wallet instantly and log a
        // Transaction (type: 'credit') tagged to the order. Its presence
        // is exactly how we tell "this was auto-credited under the new
        // system" apart from "this is an old cancellation from before the
        // update" — old ones were refunded manually as real money outside
        // this flow and must NEVER retroactively show wallet-credit
        // messaging or get double-credited.
        const creditTxn = await Transaction.findOne({
          orderId: order!._id, userId: order!.customerId, type: 'credit',
        });

        if (creditTxn) {
          walletCredited = true;
        } else {
          // OLD system fallback — preserved exactly as-is for any order
          // cancelled before this update, so existing refund-request
          // history/state keeps working unchanged.
          if (!safe.workerId) {
            const existingRefund = await RefundRequest.findOne({ orderId: order!._id });
            refundStatus   = existingRefund ? existingRefund.status : null;
            refundEligible = !existingRefund;
          } else {
            const dispute = await Dispute.findOne({ orderId: order!._id, status: 'resolved' });
            if (dispute) {
              const existingRefund = await RefundRequest.findOne({ orderId: order!._id });
              refundStatus   = existingRefund ? existingRefund.status : null;
              refundEligible = !existingRefund;
            }
          }
        }
      }

      return { ...safe, refundEligible, refundStatus, walletCredited } as unknown as IOrder;
    }

    // WORKER-FACING: strip the customer's full paid amount and commission
    // breakdown — a worker must only ever see `workerEarning` (their 85%
    // share), never the customer's full payment or platform's cut.
    if (role === 'worker') {
      const safe = order!.toObject();
      delete (safe as any).amount;
      delete (safe as any).platformCommission;
      delete (safe as any).commissionRate;
      return orderService.applyReferralDeduction(safe) as unknown as IOrder;
    }

    return order!;
  },

  async getCustomerOrders(customerId: string): Promise<IOrder[]> {
    return Order.find({ customerId })
      .sort({ createdAt: -1 })
      .select('-credentials')
      .lean() as Promise<IOrder[]>;
  },

  // WORKER-FACING list — same amount-hiding rule as getOrder() above.
  async getWorkerOrders(workerId: string): Promise<IOrder[]> {
    const orders = await Order.find({ workerId })
      .sort({ createdAt: -1 })
      .select('-amount -platformCommission -commissionRate')
      .lean();
    const adjusted = orders.map(o => orderService.applyReferralDeduction(o));
    return adjusted as unknown as IOrder[];
  },
};
