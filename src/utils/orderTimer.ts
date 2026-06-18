/**
 * In-process timer map for the 10-minute credential submission window.
 * When a worker accepts an order, we start a timer. If it expires before
 * credentials are submitted, the order is returned to the marketplace.
 *
 * Note: On Render free tier, the server sleeps — timers are lost on restart.
 * A production upgrade would use a persistent job queue (Bull/Redis).
 * For now, we also run a DB-level cleanup in autoComplete.ts as a safety net.
 */

import { Order } from '../models/Order.model';
import { Wallet } from '../models/Wallet.model';
import { notificationService } from '../services/notification.service';
import { emitToMarketplace, EVENTS } from '../socket/events';

const timers = new Map<string, NodeJS.Timeout>();

export const startOrderTimer = (
  orderId: string,
  workerId: string,
  customerId: string,
  minutes: number
): void => {
  clearOrderTimer(orderId); // Safety: clear any existing timer for this order

  const timeout = setTimeout(async () => {
    timers.delete(orderId);
    try {
      // Only cancel if still in 'accepted' state (worker hasn't submitted yet)
      const order = await Order.findOneAndUpdate(
        { _id: orderId, status: 'accepted', workerId },
        { status: 'pending', workerId: null, acceptedAt: null, timerExpiresAt: null },
        { new: true }
      );

      if (!order) return; // Already progressed past accepted — do nothing

      // Re-broadcast to marketplace so other workers can see it
      emitToMarketplace(EVENTS.NEW_ORDER, {
        orderId:   order._id,
        serviceName: order.serviceName,
        amount:    order.amount,
        workerEarning: order.workerEarning,
        createdAt: order.createdAt,
      });

      await notificationService.create({
        userId:  workerId,
        title:   '⚠️ Order Timer Expired',
        message: 'You did not submit credentials within 10 minutes. The order has been returned to the marketplace.',
        type:    'order',
        orderId: order._id,
      });

      await notificationService.create({
        userId:  customerId,
        title:   'Worker Reassigned',
        message: 'The previous worker did not complete your order in time. It is now available for another worker.',
        type:    'order',
        orderId: order._id,
      });

    } catch (err) {
      console.error('[OrderTimer] Error on expiry:', err);
    }
  }, minutes * 60 * 1000);

  timers.set(orderId, timeout);
};

export const clearOrderTimer = (orderId: string): void => {
  const existing = timers.get(orderId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(orderId);
  }
};
