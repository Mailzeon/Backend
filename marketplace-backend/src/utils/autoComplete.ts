import { Order } from '../models/Order.model';
import { Wallet } from '../models/Wallet.model';
import { Transaction } from '../models/Transaction.model';
import { Notification } from '../models/Notification.model';
import { emitToUser, EVENTS } from '../socket/events';

/**
 * Auto-complete job — runs every 5 minutes.
 *
 * BUG FIX: Previously only checked 'credentials_submitted'.
 * Must also check 'verification_pending' — customer may have requested a code
 * but not responded. After 24h, order should still auto-complete.
 */
export const runAutoCompleteJob = async (): Promise<void> => {
  try {
    const now = new Date();
    const expiredOrders = await Order.find({
      status: { $in: ['credentials_submitted', 'verification_pending'] },  // ← Fixed
      autoCompleteAt: { $lte: now },
    });

    if (expiredOrders.length === 0) return;
    console.log(`⚡ Auto-completing ${expiredOrders.length} order(s)...`);

    for (const order of expiredOrders) {
      order.status      = 'completed';
      order.completedAt = now;
      await order.save();

      if (!order.workerId) continue;

      const workerId   = order.workerId.toString();
      const customerId = order.customerId.toString();

      // Release pending earnings → available balance
      await Wallet.findOneAndUpdate(
        { userId: order.workerId },
        { $inc: { balance: order.workerEarning, pendingBalance: -order.workerEarning, totalEarned: order.workerEarning } }
      );

      await Transaction.findOneAndUpdate(
        { userId: order.workerId, orderId: order._id, status: 'pending', type: 'credit' },
        { status: 'completed', description: `Order #${order._id.toString().slice(-6).toUpperCase()} auto-completed` }
      );

      const workerNotif = await Notification.create({
        userId:  order.workerId,
        title:   `₹${order.workerEarning} Credited (Auto)`,
        message: `Order #${order._id.toString().slice(-6).toUpperCase()} was auto-completed. Earnings released.`,
        type:    'order',
        orderId: order._id,
        isRead:  false,
      });
      emitToUser(workerId, EVENTS.ORDER_COMPLETED, { orderId: order._id, notification: workerNotif });

      const customerNotif = await Notification.create({
        userId:  order.customerId,
        title:   '✅ Order Auto-Completed',
        message: 'Your order has been automatically marked complete. We hope everything went well!',
        type:    'order',
        orderId: order._id,
        isRead:  false,
      });
      emitToUser(customerId, EVENTS.ORDER_COMPLETED, { orderId: order._id, notification: customerNotif });
    }
  } catch (error) {
    console.error('[AutoComplete] Job error:', error);
  }
};

export const startAutoCompleteJob = (): void => {
  const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
  console.log('🤖 Auto-complete job started (interval: 5 min)');
  // Run once immediately on startup to catch anything missed during downtime
  runAutoCompleteJob();
  setInterval(runAutoCompleteJob, INTERVAL_MS);
};
