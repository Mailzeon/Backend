import { User } from '../models/User.model';
import { notificationService } from '../services/notification.service';
import { emitToUser, EVENTS } from '../socket/events';

/**
 * Auto-approval job — runs every 5 minutes (same cadence and pattern as
 * autoComplete.ts's job, started alongside it in index.ts).
 *
 * Covers workers held at registration because their IP/device inherited an
 * active TEMPORARY strike lock from a different, already-struck account
 * (see auth.service.ts register()/telegramLogin()) — those accounts are
 * created with isApproved:false and lockedUntil set to the SAME countdown
 * the original struck account is serving. The moment that countdown ends,
 * this job flips isApproved to true automatically — no admin click needed,
 * mirroring exactly what a human admin would eventually do once the lock
 * had genuinely expired.
 *
 * The `wasEverApproved:false` filter is what keeps this scoped to ONLY this
 * specific hold case — any worker an admin manually suspended
 * (wasEverApproved:true, isApproved:false) is never touched by this job;
 * those still require a human to reactivate them, completely unchanged.
 * A worker permanently banned (lockedUntil far in the future) never
 * matches `lockedUntil: { $lte: new Date() }` either, so confirmed-theft
 * accounts are never accidentally re-approved by this job.
 */
export const runAutoApproveHeldJob = async (): Promise<void> => {
  try {
    const held = await User.find({
      role: 'worker',
      isApproved: false,
      wasEverApproved: false,
      lockedUntil: { $lte: new Date() },
    });

    if (held.length === 0) return;

    for (const worker of held) {
      worker.isApproved = true;
      worker.wasEverApproved = true;
      await worker.save();

      await notificationService.create({
        userId: worker._id,
        title: '✅ Account Approved!',
        message: 'Your worker account has been approved. You can now accept orders from the marketplace.',
        type: 'system',
      });
      emitToUser(worker._id.toString(), EVENTS.WORKER_APPROVED, {});
    }

    console.log(`🤖 Auto-approved ${held.length} held worker(s) after their inherited lock expired.`);
  } catch (error) {
    console.error('[AutoApproveHeld] Job error:', error);
  }
};

export const startAutoApproveHeldJob = (): void => {
  const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
  console.log('🤖 Auto-approve-held job started (interval: 5 min)');
  // Run immediately on startup to catch anything missed during downtime.
  runAutoApproveHeldJob();
  setInterval(runAutoApproveHeldJob, INTERVAL_MS);
};
