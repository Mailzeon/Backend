import { Order, IOrder }        from '../models/Order.model';
import { Dispute }              from '../models/Dispute.model';
import { Notification }        from '../models/Notification.model';
import { User }                 from '../models/User.model';
import { Settings }             from '../models/Settings.model';
import { walletService }        from './wallet.service';
import { notificationService }  from './notification.service';
import { workerLevelService }   from './workerLevel.service';
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

/** Call this when admin changes a setting so the cache refreshes immediately. */
export const invalidateSettingsCache = (): void => {
  Object.keys(settingsCache).forEach(k => delete settingsCache[k]);
};

// FIX: New export — lets any logged-in user (customer/worker, even the public
// register page) read the CURRENT order price and worker earning values.
// This is what powers the dynamic ₹ amounts on the frontend instead of the
// old hardcoded ₹50 / ₹20 text that no longer matched admin-configured prices.
export const getPublicSettings = async (): Promise<{ orderPrice: number; workerEarning: number }> => {
  const [orderPrice, workerEarning] = await Promise.all([
    getSetting('orderPrice', '50'),
    getSetting('workerEarning', '20'),
  ]);
  return { orderPrice: parseInt(orderPrice), workerEarning: parseInt(workerEarning) };
};

export const orderService = {
  // ── Customer: create order ────────────────────────────────────────────────
  async createOrder(customerId: string, serviceName: string): Promise<IOrder> {
    const amount        = parseInt(await getSetting('orderPrice',    '50'));
    const workerEarning = parseInt(await getSetting('workerEarning', '20'));

    const order = await Order.create({
      customerId, serviceName: serviceName.trim(), amount, workerEarning,
    });

    emitToMarketplace(EVENTS.NEW_ORDER, {
      _id:          order._id,
      serviceName:  order.serviceName,
      amount:       order.amount,
      workerEarning: order.workerEarning,
      createdAt:    order.createdAt,
    });

    return order;
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
  async getMarketplaceOrders(): Promise<IOrder[]> {
    return Order.find({ status: 'pending', workerId: null })
      .sort({ createdAt: -1 })
      .select('-credentials')
      .lean() as Promise<IOrder[]>;
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
      message: 'The worker has submitted credentials for your order. Open your order to proceed.',
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
      delete safe.credentials;
      return safe as IOrder;
    }

    return order!;
  },

  async getCustomerOrders(customerId: string): Promise<IOrder[]> {
    return Order.find({ customerId })
      .sort({ createdAt: -1 })
      .select('-credentials')
      .lean() as Promise<IOrder[]>;
  },

  async getWorkerOrders(workerId: string): Promise<IOrder[]> {
    return Order.find({ workerId })
      .sort({ createdAt: -1 })
      .lean() as Promise<IOrder[]>;
  },
};
