import crypto from 'crypto';
import { Types } from 'mongoose';
import { User } from '../models/User.model';
import { Wallet } from '../models/Wallet.model';
import { WorkerLevelModel } from '../models/WorkerLevel.model';
import { LockedIp } from '../models/LockedIp.model';
import { LockedDevice } from '../models/LockedDevice.model';
import { isPermanentLock, resolveEvasionLock } from '../utils/permanentLock';
import { checkIpRisk } from '../utils/ipIntelligence';
import { verifyPhone } from '../utils/phoneVerification';
import { checkEmailExists } from '../utils/emailVerification';
import { signToken } from '../utils/jwt';
import { sendPasswordResetEmail } from '../utils/email';
import { IUser, UserRole } from '../types';

// Reset link is valid for 30 minutes — short enough to limit the window for
// abuse if an inbox is compromised, long enough for a real user to notice
// the email and click it.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

interface RegisterInput {
  name: string;
  email: string;
  password: string;
  role: 'customer' | 'worker';
  phone: string;
  referralCode?: string;
  deviceId?: string;
}

interface AuthResult {
  user: Partial<IUser>;
  token: string;
}

const throwHttpError = (message: string, statusCode: number): never => {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  throw err;
};

// Short, unambiguous codes (no 0/O/1/I confusion) — readable enough to say
// out loud or type from memory, which matters since this is what actually
// gets shared between people.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateReferralCode = (): string => {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
};

// Retries on the astronomically-unlikely event of a collision — findOne
// check keeps this safe without relying on a race-prone "generate once and
// hope" approach. Exported so user.routes.ts can lazily backfill a code
// for workers who registered before this feature existed.
export const generateUniqueReferralCode = async (): Promise<string> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    const exists = await User.findOne({ referralCode: code }).select('_id').lean();
    if (!exists) return code;
  }
  // Fall back to a longer code if we somehow collided 5 times in a row
  return generateReferralCode() + generateReferralCode().slice(0, 2);
};

export const authService = {
  async register(input: RegisterInput, ip?: string): Promise<AuthResult> {
    const { name, email, password, role, phone, referralCode, deviceId } = input;

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throwHttpError('An account with this email already exists.', 409);

    // Email verification — same multi-key rotating Abstract Email
    // Reputation check already used for order-time theft detection (see
    // utils/emailVerification.ts), now also run once against the signup
    // email itself. Catches fake/non-existent addresses specifically
    // (typos, made-up addresses on a real domain like gmail.com) — a
    // disposable-domain check alone wouldn't catch this, since the domain
    // itself is perfectly real.
    // Deliberately SOFT here, unlike phone: only a confirmed 'invalid'
    // (undeliverable) blocks registration. 'unknown' (API inconclusive,
    // every configured key exhausted, etc.) fails OPEN and lets
    // registration proceed — a slow/down third party should never be able
    // to stop real signups, unlike phone which is treated as essential
    // enough to justify blocking on failure.
    const emailCheck = await checkEmailExists(email);
    if (emailCheck === 'invalid') {
      throwHttpError(
        'This email address does not appear to exist. Please double-check it or use a different one.',
        400
      );
    }

    // Phone is mandatory for BOTH roles and must pass real-number
    // verification before the account is created at all — see
    // utils/phoneVerification.ts. Checked before the IP/device lock check
    // below purely so a locked-out worker gets that (more specific) error
    // rather than a generic phone failure, but either check failing stops
    // registration.
    const phoneCheck = await verifyPhone(phone);
    if (phoneCheck.checkFailed) {
      throwHttpError('Could not verify your phone number right now. Please try again in a moment.', 503);
    }
    if (!phoneCheck.isValid) {
      throwHttpError(
        phoneCheck.isVoip
          ? 'Virtual/VOIP numbers are not accepted. Please use a real mobile number.'
          : 'This does not appear to be a valid, active phone number. Please check and try again.',
        400
      );
    }

    // Anti-evasion: block a brand-new WORKER registration if the IP and/or
    // device fingerprint currently has a dispute-strike lock in effect
    // (see user.service.ts applyStrike() / LockedIp.model.ts /
    // LockedDevice.model.ts). See resolveEvasionLock() in permanentLock.ts
    // for exactly how IP and device are weighed against each other —
    // short version: a PERMANENT ban blocks on either signal alone, but a
    // TEMPORARY strike lock needs BOTH to agree, since IP alone is easy to
    // coincidentally share on Indian mobile networks (CGNAT) and isn't
    // strong enough evidence by itself. Customers aren't restricted — this
    // penalty system only exists for worker misconduct.
    if (role === 'worker' && (ip || deviceId)) {
      const [ipLock, deviceLock] = await Promise.all([
        ip ? LockedIp.findOne({ ip, lockedUntil: { $gt: new Date() } }) : null,
        deviceId ? LockedDevice.findOne({ deviceId, lockedUntil: { $gt: new Date() } }) : null,
      ]);
      const lock = resolveEvasionLock(ipLock, deviceLock);
      if (lock) {
        if (isPermanentLock(lock.lockedUntil)) {
          throwHttpError(
            'Registration is permanently blocked due to a confirmed policy violation.',
            403
          );
        }
        const hoursLeft = Math.ceil((lock.lockedUntil.getTime() - Date.now()) / (60 * 60 * 1000));
        const label = hoursLeft >= 24 ? `${Math.ceil(hoursLeft / 24)} day(s)` : `${hoursLeft} hour(s)`;
        throwHttpError(
          `Registration is temporarily blocked due to a recent policy violation. Try again in ${label}.`,
          403
        );
      }
    }

    // ── Referral program (workers only) ────────────────────────────────
    // Resolved and validated BEFORE creating the user, but any problem
    // here (bad code, self-referral, same-IP fraud) is deliberately
    // silent — it just means no referral relationship gets recorded,
    // never a blocked registration. A typo'd or fraudulent referral code
    // should never be the reason someone can't sign up.
    let referredBy: Types.ObjectId | undefined;
    let newReferralCode: string | undefined;

    if (role === 'worker') {
      newReferralCode = await generateUniqueReferralCode();

      if (referralCode?.trim()) {
        const referrer = await User.findOne({
          referralCode: referralCode.trim().toUpperCase(),
          role: 'worker',
        }).select('_id registrationIp lastLoginIp registrationDevice lastLoginDevice');

        if (referrer) {
          const sameIp = !!ip && (referrer.registrationIp === ip || referrer.lastLoginIp === ip);
          const sameDevice = !!deviceId && (referrer.registrationDevice === deviceId || referrer.lastLoginDevice === deviceId);
          if (!sameIp && !sameDevice) {
            referredBy = referrer._id;
          }
          // else: silently drop it — almost certainly a self-referral
          // attempt from the same device/network.
        }
      }
    }

    const user = await User.create({
      name: name.trim(), email, password, role,
      emailVerificationStatus: emailCheck, emailVerifiedCheckedAt: new Date(),
      phone: phone.trim(), phoneVerified: true,
      registrationIp: ip, lastLoginIp: ip,
      registrationDevice: deviceId, lastLoginDevice: deviceId,
      referralCode: newReferralCode,
      referredBy,
    });

    // Workers get a wallet and level record on registration
    if (role === 'worker') {
      await Promise.all([
        Wallet.create({ userId: user._id }),
        WorkerLevelModel.create({ workerId: user._id }),
      ]);

      // Fire-and-forget: VPN/proxy/Tor check for admin visibility (see
      // utils/ipIntelligence.ts). Deliberately NOT awaited — the provider
      // calls can take a couple seconds each, and this is a soft
      // review-flag, not something that should ever delay a real user's
      // signup response. checkIpRisk() itself never throws (fails open
      // internally), so no unhandled-rejection risk here.
      if (ip) {
        checkIpRisk(ip)
          .then(result => User.findByIdAndUpdate(user._id, { ipRiskFlag: result }))
          .catch(err => console.error('[Auth] Background IP risk check failed:', err));
      }
    }

    const token = signToken(user._id, user.role as UserRole);
    return { user: user.toJSON(), token };
  },

  async login(email: string, password: string, ip?: string, deviceId?: string): Promise<AuthResult> {
    // +password because select: false in schema
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) throwHttpError('Invalid email or password.', 401);

    const valid = await user!.comparePassword(password);
    if (!valid) throwHttpError('Invalid email or password.', 401);

    if (ip || deviceId) {
      if (ip) user!.lastLoginIp = ip;
      if (deviceId) user!.lastLoginDevice = deviceId;

      // Anti-evasion, part 2: if this IP and/or device has an active lock
      // (from a DIFFERENT, previously-struck account), inherit it onto
      // whichever account is logging in right now — closes the loophole
      // of dodging a strike by switching to an already-existing second
      // account instead of registering a brand new one. See
      // resolveEvasionLock() in permanentLock.ts for why a temporary
      // strike lock needs BOTH IP and device to match (IP alone is too
      // easy to coincidentally share on Indian mobile networks/CGNAT),
      // while a permanent ban inherits on either signal alone.
      if (user!.role === 'worker') {
        const [ipLock, deviceLock] = await Promise.all([
          ip ? LockedIp.findOne({ ip, lockedUntil: { $gt: new Date() } }) : null,
          deviceId ? LockedDevice.findOne({ deviceId, lockedUntil: { $gt: new Date() } }) : null,
        ]);
        const lock = resolveEvasionLock(ipLock, deviceLock);
        if (lock && (!user!.lockedUntil || user!.lockedUntil < lock.lockedUntil)) {
          user!.lockedUntil = lock.lockedUntil;
        }
      }
      await user!.save();
    }

    const token = signToken(user!._id, user!.role as UserRole);
    return { user: user!.toJSON(), token };
  },

  async getMe(userId: string): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) throwHttpError('User not found.', 404);
    return user!;
  },

  // New: verifies current password, then hashes and saves the new one.
  // Works for any role — customers, workers, and the seeded admin account.
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await User.findById(userId).select('+password');
    if (!user) throwHttpError('User not found.', 404);

    const valid = await user!.comparePassword(currentPassword);
    if (!valid) throwHttpError('Current password is incorrect.', 401);

    // Assigning triggers the pre('save') bcrypt hash hook on User.model.ts
    user!.password = newPassword;
    await user!.save();
  },

  // New: generates a one-time reset token, stores only its hash, and emails
  // the raw token as a link. Always resolves silently (no error thrown for
  // "email not found") so this endpoint can't be used to check which emails
  // are registered on the platform.
  async forgotPassword(email: string): Promise<void> {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return; // Silent no-op — don't leak whether the email exists

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    // Skip password re-hash hook — we're not touching `password` here
    await user.save({ validateBeforeSave: false });

    await sendPasswordResetEmail(user.email, rawToken);
  },

  // New: verifies the raw token against the stored hash + expiry, then sets
  // the new password. Throws a generic "invalid or expired" error either way
  // (bad token vs expired token) so no extra info leaks to the caller.
  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    }).select('+password +resetPasswordToken +resetPasswordExpires');

    if (!user) throwHttpError('This reset link is invalid or has expired.', 400);

    user!.password = newPassword; // Triggers bcrypt hash hook
    user!.resetPasswordToken = undefined;
    user!.resetPasswordExpires = undefined;
    await user!.save();
  },
};
