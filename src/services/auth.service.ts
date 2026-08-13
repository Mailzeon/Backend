import crypto from 'crypto';
import { Types } from 'mongoose';
import { User } from '../models/User.model';
import { Wallet } from '../models/Wallet.model';
import { WorkerLevelModel } from '../models/WorkerLevel.model';
import { LockedIp } from '../models/LockedIp.model';
import { LockedDevice } from '../models/LockedDevice.model';
import { isPermanentLock } from '../utils/permanentLock';
import { checkIpRisk } from '../utils/ipIntelligence';
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
    const { name, email, password, role, referralCode, deviceId } = input;

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throwHttpError('An account with this email already exists.', 409);

    // Anti-evasion: block a brand-new WORKER registration if EITHER the IP
    // or the device fingerprint currently has a dispute-strike lock in
    // effect (see user.service.ts applyStrike() / LockedIp.model.ts /
    // LockedDevice.model.ts). Checking both and taking whichever lock is
    // active/longer is what makes this meaningfully harder to dodge than
    // either signal alone — a VPN changes the IP but not the device, and a
    // fresh browser profile changes the device but not the IP. Customers
    // aren't restricted — this penalty system only exists for worker
    // misconduct.
    if (role === 'worker' && (ip || deviceId)) {
      const [ipLock, deviceLock] = await Promise.all([
        ip ? LockedIp.findOne({ ip, lockedUntil: { $gt: new Date() } }) : null,
        deviceId ? LockedDevice.findOne({ deviceId, lockedUntil: { $gt: new Date() } }) : null,
      ]);
      // Whichever lock (if any) expires later wins — that's the one whose
      // message/duration we show.
      const lock = [ipLock, deviceLock].filter(Boolean).sort(
        (a, b) => (b!.lockedUntil.getTime() - a!.lockedUntil.getTime())
      )[0];
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

      // Anti-evasion, part 2: if this IP OR device has an active lock (from
      // a DIFFERENT, previously-struck account), inherit whichever lock
      // expires later onto whichever account is logging in right now —
      // closes the loophole of dodging a strike by switching to an
      // already-existing second account instead of registering a brand
      // new one, from either a different network OR a different browser
      // profile on the same device.
      if (user!.role === 'worker') {
        const [ipLock, deviceLock] = await Promise.all([
          ip ? LockedIp.findOne({ ip, lockedUntil: { $gt: new Date() } }) : null,
          deviceId ? LockedDevice.findOne({ deviceId, lockedUntil: { $gt: new Date() } }) : null,
        ]);
        const lock = [ipLock, deviceLock].filter(Boolean).sort(
          (a, b) => (b!.lockedUntil.getTime() - a!.lockedUntil.getTime())
        )[0];
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
