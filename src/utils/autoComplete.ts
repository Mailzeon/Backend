import { Order }              from '../models/Order.model';
import { Wallet }             from '../models/Wallet.model';
import { Transaction }        from '../models/Transaction.model';
import { Notification }       from '../models/Notification.model';
import { workerLevelService } from '../services/workerLevel.service';
import { emitToUser, EVENTS } from '../socket/events';

/**
 * Auto-complete job — runs every 5 minutes.
 *
 * Handles orders that were not manually confirmed by the customer:
 *   - 'credentials_submitted' orders past their autoCompleteAt timestamp
 *   - 'verification_pending' orders past their autoCompleteAt timestamp
 *     (customer requested a code but never responded)
 *
 * After completing, releases worker earnings and recalculates worker level.
 */
export const runAutoCompleteJob = async (): Promise<void> => {
  try {
    const now = new Date();

    const expiredOrders = await Order.find({
      status:        { $in: ['credentials_submitted', 'verification_pending'] },
      autoCompleteAt: { $lte: now },
    });

    if (expiredOrders.length === 0) return;
    console.log(`⚡ Auto-completing ${expiredOrders.length} order(s)...`);

    for (const order of expiredOrders) {
      // 1. Mark order as completed
      order.status      = 'completed';
      order.completedAt = now;
      await order.save();

      if (!order.workerId) continue;

      const workerId   = order.workerId.toString();
      const customerId = order.customerId.toString();

      // 2. Release pending earnings → available balance
      await Wallet.findOneAndUpdate(
        { userId: order.workerId },
        {
          $inc: {
            balance:        order.workerEarning,
            pendingBalance: -order.workerEarning,
            totalEarned:    order.workerEarning,
          },
        }
      );

      await Transaction.findOneAndUpdate(
        { userId: order.workerId, orderId: order._id, status: 'pending', type: 'credit' },
        {
          status:      'completed',
          description: `Auto-completed: Order #${order._id.toString().slice(-6).toUpperCase()}`,
        }
      );

      // 3. Notify worker
      const workerNotif = await Notification.create({
        userId:    order.workerId,
        title:     `₹${order.workerEarning} Credited (Auto-completed)`,
        message:   `Order #${order._id.toString().slice(-6).toUpperCase()} was auto-completed after 24 hours. Earnings released.`,
        type:      'order',
        orderId:   order._id,
        isRead:    false,
        createdAt: now,
      });
      emitToUser(workerId, EVENTS.ORDER_COMPLETED, { orderId: order._id, notification: workerNotif });

      // 4. Notify customer
      const customerNotif = await Notification.create({
        userId:    order.customerId,
        title:     '✅ Order Auto-Completed',
        message:   'Your order was automatically marked complete. We hope everything went well!',
        type:      'order',
        orderId:   order._id,
        isRead:    false,
        createdAt: now,
      });
      emitToUser(customerId, EVENTS.ORDER_COMPLETED, { orderId: order._id, notification: customerNotif });

      // 5. FIX: Recalculate worker level after every auto-completion —
      // previously auto-completed orders never updated the worker's level.
      workerLevelService.recalculate(workerId).catch(err =>
        console.error(`[AutoComplete][WorkerLevel] Failed for worker ${workerId}:`, err)
      );
    }
  } catch (error) {
    console.error('[AutoComplete] Job error:', error);
  }
};

export const startAutoCompleteJob = (): void => {
  const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
  console.log('🤖 Auto-complete job started (interval: 5 min)');
  // Run immediately on startup to catch anything missed during downtime
  runAutoCompleteJob();
  setInterval(runAutoCompleteJob, INTERVAL_MS);
};
