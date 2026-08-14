import { Dispute, IDispute } from '../models/Dispute.model';
import { Order } from '../models/Order.model';
import { User } from '../models/User.model';
import { Notification } from '../models/Notification.model';
import { Rating } from '../models/Rating.model';
import { WorkerLevelModel } from '../models/WorkerLevel.model';
import { walletService } from './wallet.service';
import { workerLevelService } from './workerLevel.service';
import { userService } from './user.service';
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

  // ── Admin: full context for one dispute — everything needed to judge it ───
  // without manually digging through the database. Deliberately a separate
  // (heavier) call from getAll() — the list view stays cheap, this only
  // runs when the admin actually opens the Review modal for one dispute.
  async getById(id: string) {
    const dispute = await Dispute.findById(id)
      .populate('orderId')   // full order doc (credentials, verificationCode, timestamps etc.)
      .populate('customerId', 'name email phone createdAt')
      .populate('workerId', 'name email phone level isOnline createdAt');
    if (!dispute) throwErr('Dispute not found.', 404);

    const order = dispute!.orderId as any;
    const customer = dispute!.customerId as any;
    const worker = dispute!.workerId as any;

    // Behaviour context — helps admin spot a customer who disputes every
    // order to farm free refunds, or a worker with a repeat pattern of
    // upheld complaints, rather than judging this one dispute in isolation.
    const [
      customerTotalOrders, customerTotalDisputesRaised, customerDisputesUpheld,
      workerLevelDoc, workerCompletedOrders, workerDisputesAgainst, workerDisputesUpheldAgainst,
      recentWorkerRatings,
    ] = await Promise.all([
      Order.countDocuments({ customerId: customer._id }),
      Dispute.countDocuments({ customerId: customer._id }),
      Dispute.countDocuments({ customerId: customer._id, status: 'resolved' }),
      WorkerLevelModel.findOne({ workerId: worker._id }).lean(),
      Order.countDocuments({ workerId: worker._id, status: 'completed' }),
      Dispute.countDocuments({ workerId: worker._id }),
      Dispute.countDocuments({ workerId: worker._id, status: 'resolved' }),
      Rating.find({ workerId: worker._id }).sort({ createdAt: -1 }).limit(5).select('rating createdAt orderId'),
    ]);

    return {
      dispute,
      order,
      customer: {
        ...customer.toObject(),
        totalOrders: customerTotalOrders,
        totalDisputesRaised: customerTotalDisputesRaised,
        disputesUpheld: customerDisputesUpheld,
      },
      worker: {
        ...worker.toObject(),
        completedOrders: workerCompletedOrders,
        totalDisputesAgainst: workerDisputesAgainst,
        disputesUpheldAgainst: workerDisputesUpheldAgainst,
        averageRating: workerLevelDoc?.averageRating ?? 0,
        successRate: workerLevelDoc?.successRate ?? 100,
        recentRatings: recentWorkerRatings,
      },
    };
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

        // NEW: instant wallet credit for the customer, replacing the old
        // "go request a UPI refund and wait for admin" flow — this dispute
        // is already adjudicated (upheld in the customer's favor), so
        // there's nothing left to manually review before crediting them.
        await walletService.creditRefund(
          customerId, order.amount, order._id,
          `Refund: Order #${orderRef} (dispute resolved in your favor)`
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
            title: '💰 Refund Credited',
            message: `Your dispute was resolved in your favor. ₹${order.amount} has been credited to your Mailzeon wallet — use it on your next order.`,
            type: 'dispute', orderId: order._id, isRead: false, createdAt: new Date(),
          }),
        ]);

        emitToUser(workerId,   EVENTS.ORDER_CANCELLED, { orderId: order._id });
        emitToUser(customerId, EVENTS.ORDER_CANCELLED, { orderId: order._id });

        // Penalty depends on WHAT was upheld:
        //   'wrong_password' — the worker already had a fair, explicit
        //     chance to fix this via the grace window (see
        //     utils/disputeGrace.ts / order.service.ts resubmitCredentials())
        //     before this dispute could ever have reached admin at all. A
        //     wrong_password dispute only ever gets HERE if that window was
        //     missed or blown a second time — so upholding it now means
        //     CONFIRMED theft (deliberately gave a wrong/fake password),
        //     not an honest mistake. Permanent ban, not just a strike.
        //   everything else — regular escalating strike, as before.
        if (dispute!.reason === 'wrong_password') {
          await userService.applyTheftPenalty(
            workerId, order._id.toString(), 'admin sided with customer', 'wrong_password_confirmed'
          ).catch(err =>
            console.error('[Dispute] Failed to apply theft penalty after resolve:', err)
          );
        } else {
          await userService.applyStrike(workerId).catch(err =>
            console.error('[Dispute] Failed to apply strike after resolve:', err)
          );
        }

      } else {
        order.status      = 'completed';
        order.completedAt = new Date();
        await order.save();

        await walletService.settleOrderEarnings(
          order, `Earned: Order #${orderRef} (dispute rejected)`
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
