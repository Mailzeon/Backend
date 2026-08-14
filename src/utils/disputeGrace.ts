/**
 * Grace window for "wrong password" disputes — see order.service.ts
 * reportProblem()/resubmitCredentials().
 *
 * When a customer disputes an order with reason 'wrong_password' for the
 * FIRST time, the dispute does NOT go to admin immediately. Instead the
 * worker gets one timed chance (wrongPasswordGraceMinutes setting) to
 * resubmit corrected credentials. Only if that window expires without a
 * resubmission does this actually become an admin-reviewable dispute —
 * and if admin then sides with the customer, it's treated as CONFIRMED
 * THEFT (permanent ban), not just a regular strike, since the worker had
 * a fair chance to fix an honest mistake and either didn't take it or
 * still couldn't produce a working password.
 *
 * Same in-process-timer + DB-cron-safety-net pattern as
 * utils/orderTimer.ts, for the same reason: Render's free tier can sleep/
 * restart, silently losing any in-memory setTimeout.
 */

import { Order } from '../models/Order.model';
import { Dispute } from '../models/Dispute.model';
import { User } from '../models/User.model';
import { notificationService } from '../services/notification.service';

const timers = new Map<string, NodeJS.Timeout>();

export function clearGraceTimer(orderId: string): void {
  const t = timers.get(orderId);
  if (t) { clearTimeout(t); timers.delete(orderId); }
}

export function scheduleGraceEscalation(orderId: string, msUntilDeadline: number): void {
  clearGraceTimer(orderId);
  const t = setTimeout(() => {
    timers.delete(orderId);
    escalateWrongPasswordGrace(orderId).catch(err =>
      console.error(`[DisputeGrace] Failed to escalate order ${orderId}:`, err)
    );
  }, Math.max(0, msUntilDeadline));
  timers.set(orderId, t);
}

/**
 * Turns a grace-period "soft" dispute into a real, admin-visible one.
 * Only fires if the order is STILL sitting in 'under_review' with its
 * grace deadline passed — if the worker resubmitted in time,
 * order.service.ts resubmitCredentials() already moved the order out of
 * 'under_review', so this naturally becomes a no-op for that order (the
 * query below just won't match it anymore).
 */
export async function escalateWrongPasswordGrace(orderId: string): Promise<void> {
  const order = await Order.findOne({
    _id: orderId,
    status: 'under_review',
    wrongPasswordGraceDeadline: { $lte: new Date() },
  });
  if (!order || !order.workerId) return;

  // Already escalated (shouldn't normally happen, but the cron safety net
  // and the in-process timer could both fire close together) — guard
  // against creating a duplicate Dispute.
  const existing = await Dispute.findOne({ orderId: order._id });
  if (existing) return;

  await Dispute.create({
    orderId:    order._id,
    customerId: order.customerId,
    workerId:   order.workerId,
    reason:     'wrong_password',
    description: 'Worker did not resubmit corrected credentials within the grace window.',
  });

  const admins = await User.find({ role: 'admin' }).select('_id');
  const orderRef = order._id.toString().slice(-6).toUpperCase();
  await Promise.all([
    ...admins.map(a => notificationService.create({
      userId:  a._id.toString(),
      title:   '🚨 New Dispute — Grace Window Expired',
      message: `Worker did not fix the wrong password in time for Order #${orderRef}. Escalated for review.`,
      type:    'dispute',
      orderId: order._id,
    })),
    notificationService.create({
      userId:  order.workerId.toString(),
      title:   '⛔ Grace Window Expired',
      message: `You did not resubmit corrected credentials in time for Order #${orderRef}. This has been sent to admin for review — if the wrong password is confirmed, this results in a permanent ban.`,
      type:    'dispute',
      orderId: order._id,
    }),
  ]);
}
