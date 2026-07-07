import { Dispute, IDispute } from '../models/Dispute.model';
import { Order } from '../models/Order.model';
import { User } from '../models/User.model';
import { Notification } from '../models/Notification.model';
import { walletService } from './wallet.service';
import { workerLevelService } from './workerLevel.service';
import { emitToUser, EVENTS } from '../socket/events';

const throwErr = (msg: string, code = 400): never => {
  throw Object.assign(new Error(msg), { statusCode: code });
};

export const disputeService = {
  async create(orderId: string, customerId: string, reason: string, description?: string): Promise<IDispute> {
    const order = await Order.findOne({ _id: orderId, customerId, status: 'under_review' });
    if (!order) throwErr('Order must first be reported (status: under_review) before creating a dispute.', 400);
    if (!order!.workerId) throwErr('No worker assigned to this order.', 400);

    const existing = await Dispute.findOne({ orderId });
    if (existing) throwErr('A dispute already exists for this order.', 409);

    const dispute = await Dispute.create({
      orderId, customerId, workerId: order!.workerId, reason, description,
    });

    const admins = await User.find({ role: 'admin' }).select('_id');
    if (admins.length > 0) {
      await Notification.insertMany(admins.map(a => ({
        userId:  a._id,
        title:   '🚨 New Dispute',
        message: `A customer raised a dispute for Order #${orderId.slice(-6).toUpperCase()}.`,
        type:    'dispute',
        orderId: order!._id,
        isRead:  false,
        createdAt: new Date(),
      })));
    }

    return dispute;
  },

  async getAll(): Promise<IDispute[]> {
    return Dispute.find()
      .populate('orderId', 'serviceName amount status')
      .populate('customerId', 'name email')
      .populate('workerId', 'name email')
      .sort({ createdAt: -1 });
  },

  async getMyDisputes(customerId: string): Promise<IDispute[]> {
    return Dispute.find({ customerId })
      .populate('orderId', 'serviceName status')
      .sort({ createdAt: -1 });
  },

  // REWRITTEN — makes the dispute system "logically real":
  //
  //   status: 'resolved'  → the dispute is upheld IN THE CUSTOMER'S FAVOR.
  //     Something genuinely went wrong (wrong password, bad account, etc).
  //     The order is CANCELLED. The worker's pending earnings for this
  //     order are REVERSED — they do not get paid. This also naturally
  //     lowers the worker's success rate (workerLevelService counts
  //     'cancelled' orders in the denominator but not the numerator).
  //
  //   status: 'rejected'  → the customer's claim is NOT upheld — the
  //     worker did their job correctly. The order COMPLETES normally and
  //     the worker's pending earnings are RELEASED as usual.
  //
  // Previously both actions did nothing to the order at all — it stayed
  // stuck on 'under_review' forever regardless of which button admin
  // clicked. That bug is fixed here, and the two outcomes now have
  // genuinely different, correct financial consequences.
  async resolve(id: string, status: 'resolved' | 'rejected', adminNote?: string): Promise<IDispute> {
    const dispute = await Dispute.findByIdAndUpdate(
      id,
      { status, adminNote, resolvedAt: new Date() },
      { new: true }
    ).populate('orderId', 'serviceName status workerId customerId amount workerEarning');

    if (!dispute) throwErr('Dispute not found.', 404);

    const order = await Order.findById(dispute!.orderId);

    // Only act if the order is still genuinely stuck under review —
    // prevents double-processing if a dispute somehow gets resolved twice.
    if (order && order.status === 'under_review' && order.workerId) {
      const workerId   = order.workerId.toString();
      const customerId = order.customerId.toString();
      const orderRef   = order._id.toString().slice(-6).toUpperCase();

      if (status === 'resolved') {
        // Customer's dispute is valid — cancel the order, don't pay the worker.
        order.status = 'cancelled';
        await order.save();

        await walletService.reversePendingEarnings(
          workerId, order.workerEarning, order._id,
          `Reversed: Order #${orderRef} (dispute upheld)`
        );

        await Promise.all([
          Notification.create({
            userId: workerId,
            title: 'Dispute Resolved — Order Cancelled',
            message: `The dispute for Order #${orderRef} was resolved in the customer's favor. Your pending earnings for this order have been reversed.`,
            type: 'dispute', orderId: order._id, isRead: false, createdAt: new Date(),
          }),
          Notification.create({
            userId: customerId,
            title: 'Dispute Resolved',
            message: 'Your dispute was resolved in your favor. The order has been cancelled.',
            type: 'dispute', orderId: order._id, isRead: false, createdAt: new Date(),
          }),
        ]);

        emitToUser(workerId,   EVENTS.ORDER_CANCELLED, { orderId: order._id });
        emitToUser(customerId, EVENTS.ORDER_CANCELLED, { orderId: order._id });

      } else {
        // Customer's claim rejected — worker did the job correctly, pay them.
        order.status      = 'completed';
        order.completedAt = new Date();
        await order.save();

        await walletService.releaseFromPending(
          workerId, order.workerEarning, order._id,
          `Earned: Order #${orderRef} (dispute rejected)`
        );

        await Promise.all([
          Notification.create({
            userId: workerId,
            title: '✅ Dispute Rejected — Order Completed',
            message: `The dispute for Order #${orderRef} was rejected. Your earnings have been released.`,
            type: 'dispute', orderId: order._id, isRead: false, createdAt: new Date(),
          }),
          Notification.create({
            userId: customerId,
            title: 'Dispute Rejected',
            message: 'Your dispute was reviewed and rejected. The order has been marked complete.',
            type: 'dispute', orderId: order._id, isRead: false, createdAt: new Date(),
          }),
        ]);

        emitToUser(workerId,   EVENTS.ORDER_COMPLETED, { orderId: order._id });
        emitToUser(customerId, EVENTS.ORDER_COMPLETED, { orderId: order._id });
      }

      workerLevelService.recalculate(workerId).catch(err =>
        console.error('[WorkerLevel] Recalculate error after dispute resolve:', err)
      );
    }

    return dispute!;
  },
};
