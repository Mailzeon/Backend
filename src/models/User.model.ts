import mongoose, { Schema } from 'mongoose';
import bcrypt from 'bcryptjs';
import { IUser } from '../types';

const UserSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: 2,
      maxlength: 50,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 6,
      select: false, // Never returned in queries by default
    },
    role: {
      type: String,
      enum: ['customer', 'worker', 'admin'],
      required: true,
    },

    // NEW: required by Cashfree's Payment Gateway API (customer_details.customer_phone
    // is mandatory on every order create call). Not required at the schema level
    // since existing users won't have it yet — it's collected the first time a
    // customer creates an order and saved to their profile from then on.
    phone: {
      type: String,
      trim: true,
    },

    // ── Worker-specific ────────────────────────────────────────────────────
    isOnline: {
      type: Boolean,
      default: false,
    },
    isApproved: {
      type: Boolean,
      // Customers and admins are auto-approved.
      // Workers start as false and need manual admin approval.
      default: function (this: IUser) {
        return this.role !== 'worker';
      },
    },
    level: {
      type: String,
      enum: ['bronze', 'silver', 'gold'],
      default: 'bronze',
    },

    // ── Payment details (worker withdrawals) ───────────────────────────────
    upiId: { type: String, trim: true },
    bankDetails: {
      accountHolder: String,
      accountNumber: String,
      ifscCode: String,
      bankName: String,
    },

    profileImage: String,

    // NEW — PWA install detection. Set when the frontend detects it's
    // running in standalone/installed mode (display-mode: standalone,
    // matched via window.matchMedia — see AppInstallDetector.tsx) and
    // pings the backend. Not 100% reliable (no signal if someone installs
    // but never re-opens, or uninstalls) but accurate for "who is
    // currently using the installed app".
    hasInstalledApp: {
      type: Boolean,
      default: false,
    },
    lastSeenAsInstalledApp: {
      type: Date,
    },

    // ── Forgot / reset password ─────────────────────────────────────────────
    // We store a SHA-256 hash of the reset token (never the raw token) so that
    // even if the database is compromised, the token itself can't be reused —
    // same principle as the password field, just a different hash algorithm
    // since bcrypt is unnecessarily slow for a short-lived random token.
    resetPasswordToken: {
      type: String,
      select: false,
    },
    resetPasswordExpires: {
      type: Date,
      select: false,
    },
  },
  { timestamps: true }
);

// ─── Hash password before save ────────────────────────────────────────────────
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// ─── Instance method: compare password ───────────────────────────────────────
UserSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

// ─── Never return password field in JSON ─────────────────────────────────────
UserSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    return ret;
  },
});

// ─── Indexes ──────────────────────────────────────────────────────────────────
UserSchema.index({ role: 1, isOnline: 1 }); // Fast lookup of online workers
UserSchema.index({ role: 1, isApproved: 1 }); // Admin approval list

export const User = mongoose.model<IUser>('User', UserSchema);
