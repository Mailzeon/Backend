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

  // status: 'resolved'  → dispute upheld IN THE CUSTOMER'S FAVOR. Order is
  //   CANCELLED, worker's pending earnings REVERSED (not paid), and the
  //   customer becomes eligible to request a refund of what they paid.
  // status: 'rejected'  → customer's claim NOT upheld. Order COMPLETES
  //   normally, worker's pending earnings RELEASED as usual.
  async resolve(id: string, status: 'resolved' | 'rejected', adminNote?: string): Promise<IDispute> {
    const dispute = await Dispute.findByIdAndUpdate(
      id,
      { status, adminNote, resolvedAt: new Date() },
      { new: true }
    ).populate('orderId', 'serviceName status workerId customerId amount workerEarning');

    if (!dispute) throwErr('Dispute not found.', 404);

    const order = await Order.findById(dispute!.orderId);

    if (order && order.status === 'under_review' && order.workerId) {
      const workerId   = order.workerId.toString();
      const customerId = order.customerId.toString();
      const orderRef   = order._id.toString().slice(-6).toUpperCase();

      if (status === 'resolved') {
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
            // NEW: mentions the refund option now available on the order page.
            message: `Your dispute was resolved in your favor and the order (₹${order.amount}) has been cancelled. You can now request a refund from the order page.`,
            type: 'dispute', orderId: order._id, isRead: false, createdAt: new Date(),
          }),
        ]);

        emitToUser(workerId,   EVENTS.ORDER_CANCELLED, { orderId: order._id });
        emitToUser(customerId, EVENTS.ORDER_CANCELLED, { orderId: order._id });

      } else {
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
