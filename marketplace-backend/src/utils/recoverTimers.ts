import { Order } from '../models/Order.model';
import { startOrderTimer } from './orderTimer';
import { notificationService } from '../services/notification.service';
import { emitToMarketplace, EVENTS } from '../socket/events';

/**
 * On Render free tier, the server restarts frequently.
 * In-memory setTimeout timers are lost on restart.
 * This function runs once on startup and:
 *   1. Finds 'accepted' orders where timer already expired → resets them to pending
 *   2. Finds 'accepted' orders where timer is still valid → restarts the timer
 */
export const recoverOrderTimers = async (): Promise<void> => {
  try {
    const now = new Date();

    // ── Expired timers: worker failed to submit, return to marketplace ───────
    const expired = await Order.find({
      status: 'accepted',
      timerExpiresAt: { $lte: now },
    });

    for (const order of expired) {
      const workerId   = order.workerId!.toString();
      const customerId = order.customerId.toString();

      await Order.findByIdAndUpdate(order._id, {
        status: 'pending', workerId: null, acceptedAt: null, timerExpiresAt: null,
      });

      emitToMarketplace(EVENTS.NEW_ORDER, {
        _id:          order._id,
        serviceName:  order.serviceName,
        amount:       order.amount,
        workerEarning: order.workerEarning,
        createdAt:    order.createdAt,
      });

      await notificationService.create({
        userId:  workerId,
        title:   '⚠️ Order Returned',
        message: 'A server restart occurred and your order timer expired. The order has been returned to the marketplace.',
        type:    'order',
        orderId: order._id,
      });

      await notificationService.create({
        userId:  customerId,
        title:   'Worker Reassigned',
        message: 'The worker could not complete your order in time. It is back in the marketplace.',
        type:    'order',
        orderId: order._id,
      });
    }

    // ── Active timers: restart the countdown for remaining time ──────────────
    const active = await Order.find({
      status: 'accepted',
      timerExpiresAt: { $gt: now },
    });

    for (const order of active) {
      const remainingMs  = order.timerExpiresAt!.getTime() - now.getTime();
      const remainingMin = Math.ceil(remainingMs / 60000);
      startOrderTimer(
        order._id.toString(),
        order.workerId!.toString(),
        order.customerId.toString(),
        remainingMin
      );
    }

    if (expired.length > 0 || active.length > 0) {
      console.log(`🔄 Timer recovery: ${expired.length} expired reset, ${active.length} active restarted`);
    }
  } catch (err) {
    console.error('[TimerRecovery] Error:', err);
  }
};
