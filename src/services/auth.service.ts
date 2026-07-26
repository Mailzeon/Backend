import crypto from 'crypto';
import { User } from '../models/User.model';
import { Wallet } from '../models/Wallet.model';
import { WorkerLevelModel } from '../models/WorkerLevel.model';
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
  async register(input: RegisterInput): Promise<AuthResult> {
    const { name, email, password, role } = input;

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throwHttpError('An account with this email already exists.', 409);

    const user = await User.create({ name: name.trim(), email, password, role });

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

  async login(email: string, password: string): Promise<AuthResult> {
    // +password because select: false in schema
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) throwHttpError('Invalid email or password.', 401);

    const valid = await user!.comparePassword(password);
    if (!valid) throwHttpError('Invalid email or password.', 401);

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
