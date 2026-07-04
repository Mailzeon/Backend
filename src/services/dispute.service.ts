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

  // FIX: Previously this only updated the Dispute document's status —
  // the underlying Order stayed stuck on 'under_review' forever, which is
  // exactly the bug reported (order stuck under_review days after the
  // admin had already resolved the dispute).
  //
  // Now, resolving OR rejecting a dispute both close out the order by
  // marking it 'completed' and releasing the worker's pending earnings.
  // There is currently no refund/clawback mechanism in this platform
  // (no real payment gateway is integrated), so both outcomes end the
  // same way on the order side — the distinction between "resolved" and
  // "rejected" is preserved on the Dispute record itself for admin
  // record-keeping and reflected in the notification wording sent out.
  async resolve(id: string, status: 'resolved' | 'rejected', adminNote?: string): Promise<IDispute> {
    const dispute = await Dispute.findByIdAndUpdate(
      id,
      { status, adminNote, resolvedAt: new Date() },
      { new: true }
    ).populate('orderId', 'serviceName status workerId customerId amount workerEarning completedAt');

    if (!dispute) throwErr('Dispute not found.', 404);

    const order = await Order.findById(dispute!.orderId);

    // Only act if the order is still stuck under review — avoids double-processing
    // if this dispute is somehow resolved more than once.
    if (order && order.status === 'under_review' && order.workerId) {
      order.status      = 'completed';
      order.completedAt = new Date();
      await order.save();

      const workerId   = order.workerId.toString();
      const customerId = order.customerId.toString();

      await walletService.releaseFromPending(
        workerId,
        order.workerEarning,
        order._id,
        `Earned: Order #${order._id.toString().slice(-6).toUpperCase()} (dispute ${status})`
      );

      const workerMsg = status === 'resolved'
        ? `Your dispute for Order #${order._id.toString().slice(-6).toUpperCase()} was resolved. Your earnings have been released.`
        : `The dispute for Order #${order._id.toString().slice(-6).toUpperCase()} was reviewed and rejected. Your earnings have been released.`;

      const customerMsg = status === 'resolved'
        ? 'Your dispute has been resolved by the admin. The order is now marked complete.'
        : 'Your dispute was reviewed and rejected by the admin. The order has been marked complete.';

      await Promise.all([
        Notification.create({
          userId: workerId, title: '✅ Dispute Closed — Order Completed',
          message: workerMsg, type: 'dispute', orderId: order._id, isRead: false, createdAt: new Date(),
        }),
        Notification.create({
          userId: customerId, title: 'Dispute Update', message: customerMsg,
          type: 'dispute', orderId: order._id, isRead: false, createdAt: new Date(),
        }),
      ]);

      emitToUser(workerId,   EVENTS.ORDER_COMPLETED, { orderId: order._id });
      emitToUser(customerId, EVENTS.ORDER_COMPLETED, { orderId: order._id });

      workerLevelService.recalculate(workerId).catch(err =>
        console.error('[WorkerLevel] Recalculate error after dispute resolve:', err)
      );
    }

    return dispute!;
  },
};
