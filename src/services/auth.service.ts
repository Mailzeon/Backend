import crypto from 'crypto';
import { User } from '../models/User.model';
import { Wallet } from '../models/Wallet.model';
import { WorkerLevelModel } from '../models/WorkerLevel.model';
import { LockedIp } from '../models/LockedIp.model';
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

export const authService = {
  async register(input: RegisterInput, ip?: string): Promise<AuthResult> {
    const { name, email, password, role } = input;

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throwHttpError('An account with this email already exists.', 409);

    // Anti-evasion: block a brand-new WORKER registration from an IP that
    // currently has a dispute-strike lock in effect (see user.service.ts
    // applyStrike() / LockedIp.model.ts). Customers aren't restricted —
    // this penalty system only exists for worker misconduct.
    if (role === 'worker' && ip) {
      const ipLock = await LockedIp.findOne({ ip, lockedUntil: { $gt: new Date() } });
      if (ipLock) {
        const hoursLeft = Math.ceil((ipLock.lockedUntil.getTime() - Date.now()) / (60 * 60 * 1000));
        const label = hoursLeft >= 24 ? `${Math.ceil(hoursLeft / 24)} day(s)` : `${hoursLeft} hour(s)`;
        throwHttpError(
          `Registration is temporarily blocked from this network due to a recent policy violation. Try again in ${label}.`,
          403
        );
      }
    }

    const user = await User.create({
      name: name.trim(), email, password, role,
      registrationIp: ip, lastLoginIp: ip,
    });

    // Workers get a wallet and level record on registration
    if (role === 'worker') {
      await Promise.all([
        Wallet.create({ userId: user._id }),
        WorkerLevelModel.create({ workerId: user._id }),
      ]);
    }

    const token = signToken(user._id, user.role as UserRole);
    return { user: user.toJSON(), token };
  },

  async login(email: string, password: string, ip?: string): Promise<AuthResult> {
    // +password because select: false in schema
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) throwHttpError('Invalid email or password.', 401);

    const valid = await user!.comparePassword(password);
    if (!valid) throwHttpError('Invalid email or password.', 401);

    if (ip) {
      user!.lastLoginIp = ip;

      // Anti-evasion, part 2: if this IP has an active lock (from a
      // DIFFERENT, previously-struck account), inherit that same lock onto
      // whichever account is logging in right now — closes the loophole of
      // dodging a strike by simply switching to an already-existing second
      // account instead of registering a brand new one.
      if (user!.role === 'worker') {
        const ipLock = await LockedIp.findOne({ ip, lockedUntil: { $gt: new Date() } });
        if (ipLock && (!user!.lockedUntil || user!.lockedUntil < ipLock.lockedUntil)) {
          user!.lockedUntil = ipLock.lockedUntil;
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
