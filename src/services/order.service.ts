import { Order, IOrder }        from '../models/Order.model';
import { Dispute }              from '../models/Dispute.model';
import { RefundRequest }        from '../models/RefundRequest.model';
import { Notification }        from '../models/Notification.model';
import { User }                 from '../models/User.model';
import { Settings }             from '../models/Settings.model';
import { walletService }        from './wallet.service';
import { notificationService }  from './notification.service';
import { workerLevelService }   from './workerLevel.service';
import { paymentService }       from './payment.service';
import { startOrderTimer, clearOrderTimer } from '../utils/orderTimer';
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
// amount. This is kept only for any leftover frontend calls; it now reports
// the *minimum* amount and current commission-implied worker share for a
// hypothetical minimum order, purely informational.
export const getPublicSettings = async (): Promise<{ minimumOrderAmount: number; platformCommissionRate: number }> => {
  const [minimumOrderAmount, platformCommissionRate] = await Promise.all([
    getSetting('minimumOrderAmount', '15'),
    getSetting('platformCommissionRate', '15'),
  ]);
  return {
    minimumOrderAmount: parseInt(minimumOrderAmount),
    platformCommissionRate: parseInt(platformCommissionRate),
  };
};

const generateRandomLocalPart = (): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'user';
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
};

export const orderService = {
  // ── Customer: create order ────────────────────────────────────────────────
  // REWORKED for Cashfree integration:
  //   1. Customer now sets their own `amount` (validated against the live
  //      minimumOrderAmount setting — Zod only enforces the absolute ₹15 floor).
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
    phone: string | undefined,
    customLocalPart?: string
  ): Promise<{ order: IOrder; paymentSessionId: string }> {
    const minAmount = parseInt(await getSetting('minimumOrderAmount', '15'));
    if (amount < minAmount) {
      throwErr(`Minimum order amount is ₹${minAmount}.`, 400);
    }

    const commissionPercent = parseInt(await getSetting('platformCommissionRate', '15'));
    const commissionRate    = commissionPercent / 100;

    // Round to 2 decimals to avoid floating-point cents (e.g. 33.333333...)
    const platformCommission = Math.round(amount * commissionRate * 100) / 100;
    const workerEarning      = Math.round((amount - platformCommission) * 100) / 100;

    const localPart = emailType === 'random'
      ? generateRandomLocalPart()
      : customLocalPart!.trim().toLowerCase();
    const requestedEmail = `${localPart}@${domain}`;

    const customer = await User.findById(customerId);
    if (!customer) throwErr('Customer not found.', 404);

    // Reuse saved phone, or save the newly provided one for next time.
    let finalPhone = customer!.phone;
    if (!finalPhone) {
      if (!phone) {
        throwErr('A phone number is required to process payment. Please provide one.', 400);
      }
      customer!.phone = phone;
      await customer!.save();
      finalPhone = phone;
    }

    const order = await Order.create({
      customerId,
      serviceName: serviceName.trim(),
      amount,
      workerEarning,
      platformCommission,
      commissionRate,
      requestedEmail,
      status: 'payment_pending',
      paymentStatus: 'pending',
    });

    try {
      const { paymentSessionId, cashfreeOrderId } = await paymentService.createCashfreeOrder(
        order._id.toString(),
        amount,
        customerId,
        customer!.email,
        finalPhone
      );

      order.cashfreeOrderId = cashfreeOrderId;
      await order.save();

      return { order, paymentSessionId };
    } catch (err) {
      // Cashfree order creation failed — don't leave our order stuck in
      // limbo forever; mark it failed so the customer can simply try again.
      order.status = 'payment_failed';
      order.paymentStatus = 'failed';
      await order.save();
      throw err;
    }
  },

  // ── Customer: cancel a pending (not yet accepted) order ───────────────────
  async cancelOrder(orderId: string, customerId: string): Promise<IOrder> {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, customerId, status: 'pending', workerId: null },
      { status: 'cancelled' },
      { new: true }
    );
    if (!order) {
      throwErr('Only pending orders (not yet accepted by a worker) can be cancelled.', 400);
    }
    return order!;
  },

  // ── Marketplace: orders available for workers ─────────────────────────────
  // FIX: also hides the customer's full `amount`/commission breakdown here —
  // this is the list workers browse BEFORE accepting, so the leak applied
  // even earlier than getOrder()/getWorkerOrders() below.
  async getMarketplaceOrders(): Promise<IOrder[]> {
    const orders = await Order.find({ status: 'pending', workerId: null })
      .sort({ createdAt: -1 })
      .select('-credentials -amount -platformCommission -commissionRate')
      .lean();
    return orders as unknown as IOrder[];
  },

  // ── Worker: atomically accept an order ───────────────────────────────────
  async acceptOrder(orderId: string, workerId: string, workerName: string): Promise<IOrder> {
    const timerMinutes = parseInt(await getSetting('orderTimerMinutes', '10'));
    const now          = new Date();
    const timerExpires = new Date(now.getTime() + timerMinutes * 60 * 1000);

    const order = await Order.findOneAndUpdate(
      { _id: orderId, status: 'pending', workerId: null },
      { status: 'accepted', workerId, acceptedAt: now, timerExpiresAt: timerExpires },
      { new: true }
    );

    if (!order) throwErr('This order is no longer available.', 409);

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
    return order!;
  },

  // ── Worker: submit credentials ────────────────────────────────────────────
  async submitCredentials(
    orderId: string,
    workerId: string,
    credentials: { email: string; password: string; notes?: string }
  ): Promise<IOrder> {
    const order = await Order.findOne({ _id: orderId, workerId, status: 'accepted' });
    if (!order) throwErr('Order not found or not in accepted state.', 404);

    if (order.requestedEmail && credentials.email.trim().toLowerCase() !== order.requestedEmail.toLowerCase()) {
      throwErr(`Submitted email must exactly match the requested email: ${order.requestedEmail}`, 400);
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
    return order!;
  },

  // ── Customer: request verification code ──────────────────────────────────
  async requestVerificationCode(orderId: string, customerId: string): Promise<IOrder> {
    const order = await Order.findOne({
      _id: orderId, customerId, status: 'credentials_submitted',
    });
    if (!order) throwErr('Order must be in "credentials_submitted" state to request a code.', 400);

    order!.status = 'verification_pending';
    await order!.save();

    const workerId = order!.workerId!.toString();
    await notificationService.create({
      userId:  workerId,
      title:   '⚡ Verification Code Requested',
      message: 'The customer needs a verification code. Please enter it now.',
      type:    'verification',
      orderId: order!._id,
    });

    emitToUser(workerId, EVENTS.CODE_REQUESTED, { orderId });
    return order!;
  },

  // ── Worker: submit verification code ─────────────────────────────────────
  async submitVerificationCode(orderId: string, workerId: string, code: string): Promise<IOrder> {
    const order = await Order.findOne({ _id: orderId, workerId, status: 'verification_pending' });
    if (!order) throwErr('Order not found or not in verification state.', 400);

    order!.verificationCode = code.trim();
    await order!.save();

    const customerId = order!.customerId.toString();
    await notificationService.create({
      userId:  customerId,
      title:   '✅ Verification Code Received',
      message: 'The worker has sent your verification code. Open your order to view it.',
      type:    'verification',
      orderId: order!._id,
    });

    emitToUser(customerId, EVENTS.CODE_RECEIVED, { orderId, code: code.trim() });
    return order!;
  },

  // ── Customer: request a NEW code ─────────────────────────────────────────
  async requestNewCode(orderId: string, customerId: string): Promise<IOrder> {
    const order = await Order.findOne({
      _id: orderId,
      customerId,
      status: 'verification_pending',
      workerId: { $ne: null },
    });
    if (!order) throwErr('Order not in verification state.', 400);

    await Order.findByIdAndUpdate(orderId, { $unset: { verificationCode: 1 } });
    order.verificationCode = undefined;

    const workerId = order.workerId!.toString();
    await notificationService.create({
      userId:  workerId,
      title:   '⚡ New Code Requested',
      message: 'The previous code expired. Please provide a new verification code.',
      type:    'verification',
      orderId: order._id,
    });

    emitToUser(workerId, EVENTS.NEW_CODE_REQUESTED, { orderId });
    return order;
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

    await walletService.releaseFromPending(
      workerId,
      order.workerEarning,
      order._id,
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

      if (safe.status === 'cancelled') {
        const dispute = await Dispute.findOne({ orderId: order!._id, status: 'resolved' });
        if (dispute) {
          const existingRefund = await RefundRequest.findOne({ orderId: order!._id });
          refundStatus   = existingRefund ? existingRefund.status : null;
          refundEligible = !existingRefund;
        }
      }

      return { ...safe, refundEligible, refundStatus } as unknown as IOrder;
    }

    // WORKER-FACING: strip the customer's full paid amount and commission
    // breakdown — a worker must only ever see `workerEarning` (their 85%
    // share), never the customer's full payment or platform's cut.
    if (role === 'worker') {
      const safe = order!.toObject();
      delete (safe as any).amount;
      delete (safe as any).platformCommission;
      delete (safe as any).commissionRate;
      return safe as unknown as IOrder;
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
    return orders as unknown as IOrder[];
  },
};
