import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { upload } from '../middleware/upload.middleware';
import { uploadProfileImage } from '../controllers/user.controller';
import { Request, Response } from 'express';
import { User } from '../models/User.model';
import { Order } from '../models/Order.model';
import { Transaction } from '../models/Transaction.model';
import { sendSuccess, sendError } from '../utils/response';
import { userService } from '../services/user.service';
import { generateUniqueReferralCode } from '../services/auth.service';
import { verifyPhone } from '../utils/phoneVerification';
import { checkEmailExists } from '../utils/emailVerification';

const router = Router();
router.use(authenticate);

// NOTE: the old PATCH /status (manual online/offline toggle) has been
// removed on purpose. A worker is now automatically "online" for as long
// as they have the app open — see socket.ts join-room/disconnect handlers —
// with zero manual step and nothing to forget to flip back on.

// Update profile / payment details
router.put('/profile', async (req: Request, res: Response) => {
  const { name, upiId, bankDetails, phone, email } = req.body;
  const updates: Record<string, unknown> = {};
  if (name?.trim()) updates.name = name.trim();
  if (upiId !== undefined) updates.upiId = upiId;
  if (bankDetails) updates.bankDetails = bankDetails;

  // NEW: email can now be changed (it used to be permanently locked at
  // signup) — added specifically so someone whose email came back
  // 'invalid' from the verification check (see auth.service.ts register()
  // / utils/backfillEmailVerification.ts) actually has a way to fix it,
  // instead of being permanently stuck with no recourse. Re-verified on
  // every change, same reasoning as phone below. Soft/fail-open here
  // though, unlike phone: a slow/down provider shouldn't block someone
  // from just changing their email address, so 'unknown' still saves the
  // change (see checkEmailExists()'s tri-state result and
  // order.service.ts's gate, which only blocks on a CONFIRMED 'invalid').
  if (typeof email === 'string' && email.trim()) {
    const trimmedEmail = email.trim().toLowerCase();
    // Same fix as phone below — only skip if this exact email was
    // already CONFIRMED valid, not merely "unchanged". Otherwise anyone
    // whose email came back 'unknown' (inconclusive) or was never
    // checked at all (pre-Phase-4 accounts) would have no way to trigger
    // a re-check by re-saving their own already-correct address.
    const alreadyVerifiedSameEmail = trimmedEmail === req.user!.email && req.user!.emailVerificationStatus === 'valid';
    if (!alreadyVerifiedSameEmail) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        sendError(res, 'Enter a valid email address.', 400); return;
      }
      const taken = await User.findOne({ email: trimmedEmail, _id: { $ne: req.user!._id } });
      if (taken) { sendError(res, 'This email is already in use by another account.', 409); return; }

      const emailCheck = await checkEmailExists(trimmedEmail);
      if (emailCheck === 'invalid') {
        sendError(res, 'This email address does not appear to exist. Please double-check it or use a different one.', 400);
        return;
      }
      updates.email = trimmedEmail;
      updates.emailVerificationStatus = emailCheck; // 'valid' or 'unknown' — 'invalid' already returned above
      updates.emailVerifiedCheckedAt = new Date();
    }
  }

  // BUG FIX: `phone` was never destructured from req.body here before —
  // the frontend has been sending it all along, but it was silently
  // dropped on arrival, so it never actually saved via this route (it
  // only ever got set as a side effect of placing an order — see
  // order.service.ts createOrder()). Fixed here as part of building
  // proper phone verification: any phone submitted through profile now
  // gets checked via Abstract Phone Validation before being accepted, same
  // as at registration (see utils/phoneVerification.ts). Only re-verify if
  // it's actually changing — an unchanged phone that's already verified
  // shouldn't burn another API credit or risk flipping to unverified on a
  // transient provider hiccup.
  if (typeof phone === 'string' && phone.trim()) {
    const trimmedPhone = phone.trim();
    // BUG FIX (Aug 2026): this used to skip verification whenever the
    // submitted number matched what was already saved — but that alone
    // isn't enough to skip. Every customer/worker who placed an order
    // BEFORE phone verification existed already had a real phone saved
    // (see order.service.ts's old fallback, removed in Phase 4) with
    // phoneVerified defaulting to false. When they'd visit their
    // profile, see their own correct number already pre-filled, and hit
    // Save without touching it (the natural thing to do), this "no
    // change" check skipped verification entirely — permanently
    // stranding them at "Not verified" with literally no way to fix it,
    // since resubmitting the identical number never did anything. This
    // also silently blocked them from ever placing/accepting an order,
    // since that's gated on phoneVerified being true.
    const alreadyVerifiedSameNumber = trimmedPhone === req.user!.phone && req.user!.phoneVerified;
    if (!alreadyVerifiedSameNumber) {
      if (!/^[6-9]\d{9}$/.test(trimmedPhone)) {
        sendError(res, 'Enter a valid 10-digit Indian mobile number.', 400);
        return;
      }
      const phoneCheck = await verifyPhone(trimmedPhone);
      if (phoneCheck.checkFailed) {
        sendError(res, 'Could not verify this phone number right now. Please try again in a moment.', 503);
        return;
      }
      if (!phoneCheck.isValid) {
        sendError(
          res,
          phoneCheck.isVoip
            ? 'Virtual/VOIP numbers are not accepted. Please use a real mobile number.'
            : 'This does not appear to be a valid, active phone number.',
          400
        );
        return;
      }
      updates.phone = trimmedPhone;
      updates.phoneVerified = true;
    }
  }

  const user = await User.findByIdAndUpdate(req.user!._id, updates, { new: true });
  sendSuccess(res, 'Profile updated.', user);
});

// New: upload/replace profile picture. 'image' must match the FormData
// field name the frontend sends (see ProfileImageUploader.tsx).
router.post('/profile-image', upload.single('image'), uploadProfileImage);

// New: pinged by AppInstallDetector.tsx when the frontend detects it's
// running in standalone/installed mode. Cheap, no-op-safe to call
// repeatedly (every app open), used purely to track who's actually using
// the installed PWA vs. the plain browser.
router.post('/mark-installed', async (req: Request, res: Response) => {
  await User.findByIdAndUpdate(req.user!._id, {
    hasInstalledApp: true,
    lastSeenAsInstalledApp: new Date(),
  });
  sendSuccess(res, 'Noted.');
});

// ── Referral program (workers AND customers — two independent programs) ──
// See auth.service.ts register() for how a referral gets recorded, and
// wallet.service.ts settleOrderEarnings() for how each side's bonus is
// actually paid out on completed orders.
router.get('/me/referral', requireRole('worker', 'customer'), async (req: Request, res: Response) => {
  const myRole = req.user!.role;
  let me = await User.findById(req.user!._id).select('referralCode');

  // Backfill for accounts that registered before this feature existed (or,
  // for customers, before the program existed for their role at all) —
  // they never got a referralCode assigned at signup, so generate one the
  // first time they open this page instead of leaving it blank forever.
  if (!me?.referralCode) {
    const code = await generateUniqueReferralCode();
    me = await User.findByIdAndUpdate(req.user!._id, { referralCode: code }, { new: true }).select('referralCode');
  }

  const referred = await User.find({ referredBy: req.user!._id, role: myRole })
    .select('name createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const referredIds = referred.map(r => r._id);
  const matchField = myRole === 'worker' ? 'workerId' : 'customerId';
  const completedCounts = referredIds.length > 0
    ? await Order.aggregate([
        { $match: { [matchField]: { $in: referredIds }, status: 'completed' } },
        { $group: { _id: `$${matchField}`, count: { $sum: 1 } } },
      ])
    : [];
  const completedMap = new Map(completedCounts.map((c: any) => [c._id.toString(), c.count]));

  const totalEarnedAgg = await Transaction.aggregate([
    { $match: { userId: req.user!._id, type: 'credit', description: /^Referral bonus/, status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const totalEarned = totalEarnedAgg[0]?.total ?? 0;

  sendSuccess(res, 'Referral info fetched.', {
    referralCode: me?.referralCode,
    totalEarned,
    referred: referred.map(r => ({
      name: r.name,
      joinedAt: r.createdAt,
      completedOrders: completedMap.get(r._id.toString()) ?? 0,
    })),
  });
});

// Delete my own account — soft delete (see user.service.ts). Blocked if
// there's still an order actively in progress. Not available to admins.
router.delete('/me', requireRole('customer', 'worker'), async (req: Request, res: Response) => {
  await userService.deleteAccount(req.user!._id.toString(), res);
  sendSuccess(res, 'Your account has been deleted.', {});
});

export default router;
