import { Order }              from '../models/Order.model';
import { Dispute }            from '../models/Dispute.model';
import { Notification }       from '../models/Notification.model';
import { walletService }      from '../services/wallet.service';
import { paymentService }     from '../services/payment.service';
import { workerLevelService } from '../services/workerLevel.service';
import { userService }        from '../services/user.service';
import { emitToUser, EVENTS } from '../socket/events';

/**
 * Auto-complete / auto-cancel job — runs every 5 minutes.
 *
 * Handles orders the customer or worker never manually resolved, once
 * `autoCompleteAt` has passed. The outcome depends on WHO the order was
 * waiting on, which the order's status already tells us:
 *
 *   - 'credentials_submitted' → worker delivered, customer never responded
 *     at all (no code request, no report). Ball was in the CUSTOMER's court,
 *     so the worker gets paid — this protects workers from customers who
 *     simply ghost after receiving their account.
 *
 *   - 'verification_pending'  → customer asked the worker for a live
 *     verification code and the WORKER never sent one. Ball was in the
 *     WORKER's court, so the order is cancelled and the customer becomes
 *     refund-eligible instead of the worker being paid — a silent worker
 *     shouldn't get to keep the money for a job they didn't actually finish.
 *
 * Both paths reuse the exact same wallet-reversal / cancel / dispute /
 * notification pattern as an admin manually resolving a dispute (see
 * dispute.service.ts's `resolve()`) — the only difference is the system
 * does it automatically instead of an admin clicking a button.
 */
export const runAutoCompleteJob = async (): Promise<void> => {
  try {
    const now = new Date();
    await autoCompleteAbandonedByCustomer(now);
    await autoCancelUnresponsiveWorker(now);
    await cleanupAbandonedPayments(now);
  } catch (error) {
    console.error('[AutoComplete] Job error:', error);
  }
};

// ── Customer never responded — pay the worker (unchanged behavior) ─────────────
async function autoCompleteAbandonedByCustomer(now: Date): Promise<void> {
  const expiredOrders = await Order.find({
    autoCompleteAt: { $lte: now },
    $or: [
      // Worker delivered credentials, customer never responded at all.
      { status: 'credentials_submitted' },
      // 'number' method: worker already confirmed the Google verification
      // number on their device — the ball is back in the CUSTOMER's court
      // from that point on, same as credentials_submitted.
      { status: 'verification_pending', verificationMethod: 'number', verificationConfirmed: true },
      // 'code' method: worker already sent the login code back — same
      // idea, ball is with the customer now.
      { status: 'verification_pending', verificationMethod: 'code', verificationCode: { $exists: true, $ne: null } },
    ],
  });

  if (expiredOrders.length === 0) return;
  console.log(`⚡ Auto-completing ${expiredOrders.length} abandoned order(s) (customer silent)...`);

  for (const order of expiredOrders) {
    // Each order gets its own try/catch — previously, if ANY single order in
    // this batch threw (a bad wallet doc, a notification failure, whatever),
    // the exception bubbled all the way up to runAutoCompleteJob()'s outer
    // catch, which just logs and returns — meaning EVERY order after the
    // failing one in this run was silently skipped. Worse: since the query
    // re-runs from scratch every 5 minutes, the same first order fails again
    // every time, permanently blocking the entire batch forever. This is
    // almost certainly why orders sat in "Credentials Submitted" well past
    // their 24-hour window — one stuck order was silently blocking all the
    // ones behind it, indefinitely.
    try {
      order.status      = 'completed';
      order.completedAt = now;
      await order.save();

      if (!order.workerId) continue;
      const workerId   = order.workerId.toString();
      const customerId = order.customerId.toString();
      const orderRef   = order._id.toString().slice(-6).toUpperCase();

      await walletService.settleOrderEarnings(
        order, `Auto-completed: Order #${orderRef}`
      );

      const workerNotif = await Notification.create({
        userId: workerId,
        title:  `₹${order.workerEarning} Credited (Auto-completed)`,
        message: `Order #${orderRef} was auto-completed after 24 hours of no customer response. Earnings released.`,
        type: 'order', orderId: order._id, isRead: false, createdAt: now,
      });
      emitToUser(workerId, EVENTS.ORDER_COMPLETED, { orderId: order._id, notification: workerNotif });

      const customerNotif = await Notification.create({
        userId: customerId,
        title:  '✅ Order Auto-Completed',
        message: 'Your order was automatically marked complete. We hope everything went well!',
        type: 'order', orderId: order._id, isRead: false, createdAt: now,
      });
      emitToUser(customerId, EVENTS.ORDER_COMPLETED, { orderId: order._id, notification: customerNotif });

      workerLevelService.recalculate(workerId).catch(err =>
        console.error(`[AutoComplete][WorkerLevel] Failed for worker ${workerId}:`, err)
      );
    } catch (err) {
      console.error(`[AutoComplete] Failed to auto-complete order ${order._id.toString()}:`, err);
      // Falling through to the next loop iteration (default behavior once
      // this catch finishes) is exactly what we want — one bad order no
      // longer blocks the rest of the batch.
    }
  }
}

// ── Worker never confirmed the customer's verification number — cancel + refund the customer ─────
async function autoCancelUnresponsiveWorker(now: Date): Promise<void> {
  const stuckOrders = await Order.find({
    status: 'verification_pending',
    autoCompleteAt: { $lte: now },
    // Only orders where the WORKER is genuinely the one holding things up —
    // if they already responded (confirmed the number / sent the code),
    // autoCompleteAbandonedByCustomer above handles it instead (worker
    // gets paid, not cancelled).
    $or: [
      { verificationMethod: 'number', verificationConfirmed: { $ne: true } },
      { verificationMethod: 'code', verificationCode: null },
    ],
  });

  if (stuckOrders.length === 0) return;
  console.log(`⚡ Auto-cancelling ${stuckOrders.length} order(s) (worker unresponsive to verification request)...`);

  for (const order of stuckOrders) {
    try {
      if (!order.workerId) continue;
      const workerId   = order.workerId.toString();
      const customerId = order.customerId.toString();
      const orderRef   = order._id.toString().slice(-6).toUpperCase();
      const reasonLabel = order.verificationMethod === 'code'
        ? "did not send the customer's requested verification code"
        : "did not confirm the customer's verification number";

      order.status = 'cancelled';
      await order.save();

      // Reverse the worker's pending earnings — they never actually finished
      // the job (never responded to the customer's live verification request).
      await walletService.reversePendingEarnings(
        workerId, order.workerEarning, order._id,
        `Reversed: Order #${orderRef} (worker unresponsive to verification request)`
      );

      // Kept as an audit-trail record so admin can see why this was
      // auto-cancelled in the Disputes history — refund eligibility itself
      // is now handled by the instant wallet credit below, not by this
      // record's existence.
      await Dispute.create({
        orderId: order._id,
        customerId: order.customerId,
        workerId,
        reason: 'other',
        description: `Auto-resolved by system: worker ${reasonLabel} within 24 hours.`,
        status: 'resolved',
        adminNote: `Auto-resolved — worker ${reasonLabel}.`,
        resolvedAt: now,
      });

      // NEW: instant wallet credit for the customer, replacing the old
      // "go request a UPI refund and wait for admin" flow.
      await walletService.creditRefund(
        customerId, order.amount, order._id,
        `Refund: Order #${orderRef} (worker unresponsive to verification request)`
      );

      await Promise.all([
        Notification.create({
          userId: workerId,
          title:  'Order Cancelled — No Response',
          message: `Order #${orderRef} was cancelled because you ${reasonLabel} within 24 hours. Your pending earnings for this order have been reversed.`,
          type: 'dispute', orderId: order._id, isRead: false, createdAt: now,
        }),
        Notification.create({
          userId: customerId,
          title:  '💰 Refund Credited',
          message: `The worker ${reasonLabel}, so Order #${orderRef} was cancelled. ₹${order.amount} has been credited to your Mailzeon wallet — use it on your next order.`,
          type: 'dispute', orderId: order._id, isRead: false, createdAt: now,
        }),
      ]);

      emitToUser(workerId,   EVENTS.ORDER_CANCELLED, { orderId: order._id });
      emitToUser(customerId, EVENTS.ORDER_CANCELLED, { orderId: order._id });

      // A worker going silent on a live customer request is worse for their
      // reliability stats than a customer simply ghosting — recalculating
      // here means it counts against them the same way a lost dispute would.
      workerLevelService.recalculate(workerId).catch(err =>
        console.error(`[AutoComplete][WorkerLevel] Failed for worker ${workerId}:`, err)
      );

      // Same penalty as a human-adjudicated dispute upheld against them —
      // going completely silent on a live customer is exactly the kind of
      // fault this system exists to deter.
      userService.applyStrike(workerId).catch(err =>
        console.error(`[AutoComplete] Failed to apply strike for worker ${workerId}:`, err)
      );
    } catch (err) {
      console.error(`[AutoComplete] Failed to auto-cancel order ${order._id.toString()}:`, err);
    }
  }
}

// ── Abandoned checkout cleanup ───────────────────────────────────────────────
// A customer can create an order, optionally apply wallet credit toward it,
// then simply close the tab without ever completing (or explicitly
// cancelling) the Cashfree checkout — no webhook ever fires, no
// verify-on-return ever happens, so the order was previously left stuck in
// 'payment_pending' forever. Worse, if wallet credit was applied, that
// credit stayed deducted with no order ever actually going through.
//
// This treats anything still 'payment_pending' after ABANDONED_TIMEOUT_MS
// as dead and reuses paymentService.markPaymentFailed() — the exact same
// function the webhook/verify-on-return failure paths already call — so
// the wallet-credit refund and customer notification happen identically,
// with no separate logic to keep in sync.
const ABANDONED_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

async function cleanupAbandonedPayments(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - ABANDONED_TIMEOUT_MS);

  const stale = await Order.find({
    status:    'payment_pending',
    createdAt: { $lte: cutoff },
  }).select('_id');

  if (stale.length === 0) return;
  console.log(`⚡ Marking ${stale.length} abandoned checkout(s) as failed...`);

  for (const order of stale) {
    await paymentService.markPaymentFailed(order._id.toString()).catch((err) =>
      console.error(`[AutoComplete][CleanupAbandoned] Failed for order ${order._id}:`, err)
    );
  }
}

export const startAutoCompleteJob = (): void => {
  const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
  console.log('🤖 Auto-complete job started (interval: 5 min)');
  // Run immediately on startup to catch anything missed during downtime
  runAutoCompleteJob();
  setInterval(runAutoCompleteJob, INTERVAL_MS);
};
