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
    // NEW — checked via Abstract Email Reputation at registration (see
    // auth.service.ts register() / utils/emailVerification.ts) — same
    // multi-key rotating check already used for order-time theft
    // detection, now also run once against the signup email itself, to
    // catch fake/non-existent addresses (not just disposable domains —
    // this confirms the SPECIFIC address is actually deliverable).
    // Soft signal, not a hard gate: 'unknown' (API inconclusive/down)
    // never blocks registration, fail-open like every other check in this
    // codebase — it just leaves this false rather than true.
    emailVerified: {
      type: Boolean,
      default: false,
    },
    // Set the moment a check is attempted (any outcome) — lets the
    // one-time startup backfill (see utils/backfillEmailVerification.ts)
    // tell "genuinely never checked yet" apart from "checked and came back
    // unverified", so existing accounts don't get silently re-checked
    // (and burn API quota) on every server restart.
    emailVerifiedCheckedAt: {
      type: Date,
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

    // Required going forward (see auth.validator.ts registerSchema) and
    // verified via Abstract Phone Validation at registration time (see
    // auth.service.ts register() / utils/phoneVerification.ts) — also
    // satisfies Cashfree's customer_phone requirement on order creation.
    // NOT `required: true` at the schema level on purpose, even though new
    // signups always have one now — existing users from before this field
    // was mandatory don't have it yet, and a hard schema requirement would
    // break every read/save of those old documents. phoneVerified below is
    // what createOrder()/acceptOrder() actually gate on.
    phone: {
      type: String,
      trim: true,
    },
    // NEW — true only once `phone` has passed verifyPhone() (real,
    // non-VOIP number). order.service.ts createOrder() (customers) and
    // acceptOrder() (workers) both require this before proceeding — see
    // user.controller.ts updateProfile() for how an existing user without
    // one adds/verifies theirs retroactively.
    phoneVerified: {
      type: Boolean,
      default: false,
    },

    // ── Worker-specific ────────────────────────────────────────────────────
    // Fully automatic — set true the moment a worker's socket connects
    // (site open in a tab), false the moment their last connection drops.
    // There's no manual toggle anymore; see socket.ts join-room/disconnect.
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
    // NEW: distinguishes "never approved yet" (pending, first-time signup)
    // from "was approved, then suspended" (isApproved went true -> false).
    // isApproved alone can't tell these apart, which made the admin panel's
    // Users list show the exact same "Approve" button + "Pending" label for
    // a brand-new worker AND a worker an admin had deliberately suspended —
    // no way to tell at a glance which case you were looking at. Set true
    // the moment isApproved is first flipped to true (see
    // admin.routes.ts PATCH /users/:id/approve); never unset afterward.
    wasEverApproved: {
      type: Boolean,
      default: false,
    },
    level: {
      type: String,
      enum: ['bronze', 'silver', 'gold'],
      default: 'bronze',
    },

    // ── Dispute-strike penalty system ───────────────────────────────────────
    // See user.service.ts applyStrike() — incremented every time an admin
    // resolves a dispute AGAINST this worker (fake/no credentials, etc.).
    // lockedUntil is checked in order.service.ts acceptOrder() — a locked
    // worker still SEES every order in the marketplace, they just can't
    // accept any until the lock expires.
    strikeCount: {
      type: Number,
      default: 0,
    },
    lockedUntil: {
      type: Date,
    },
    lastStrikeAt: {
      type: Date,
    },

    // ── IP tracking (anti-evasion for the penalty above) ────────────────────
    // A locked worker making a brand-new account to dodge the penalty is
    // the obvious loophole — these let register()/login() in auth.service.ts
    // check incoming IPs against LockedIp.model.ts and apply/extend the same
    // lock to whatever account is being used, regardless of which one was
    // originally struck.
    registrationIp: {
      type: String,
    },
    lastLoginIp: {
      type: String,
    },
    // NEW — browser device fingerprint (see frontend lib/fingerprint.ts),
    // captured alongside the IP above at register/login. Same anti-evasion
    // purpose, different signal: a VPN changes the IP but not the device,
    // and vice versa — auth.service.ts checks both LockedIp AND
    // LockedDevice, treating a match on either as a hit. Neither is
    // foolproof alone (clearing browser data can reset a fingerprint, a
    // VPN changes an IP), but combined they raise the bar meaningfully.
    registrationDevice: {
      type: String,
    },
    lastLoginDevice: {
      type: String,
    },
    // NEW — soft VPN/proxy/Tor signal captured at registration time (see
    // utils/ipIntelligence.ts + auth.service.ts register()). Never blocks
    // a signup by itself, just surfaces a warning badge for admin review
    // on the Users page — plenty of legitimate users are on a VPN.
    ipRiskFlag: {
      isRisky:  { type: Boolean },
      reasons:  [{ type: String }],
      provider: { type: String },
      checkedAt: { type: Date },
    },

    // ── Referral program (workers only, for now) ────────────────────────────
    // See auth.service.ts register() for how these get set, and
    // order.service.ts acceptOrder()/wallet.service.ts settleOrderEarnings()
    // for how the referral tax actually gets paid out on completed orders.
    referralCode: {
      type: String,
      unique: true,
      sparse: true, // only workers get one; customers/admins leave this unset
    },
    referredBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      // Permanent once set at registration — never changes afterward.
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

    // ── Soft delete ──────────────────────────────────────────────────────
    // Deleting an account never hard-deletes the User document — every
    // Order/Dispute/Transaction/Rating/Notification elsewhere in the app
    // references this user by ObjectId, and a hard delete would leave all
    // of that history pointing at nothing (breaking every populate('name
    // email') call across the app, including for the OTHER party in an
    // order who has every right to still see it). Soft-deleting keeps the
    // document resolvable — name/email get scrubbed below so their old
    // history displays "Deleted User" automatically wherever it's shown,
    // with no special-casing needed anywhere else in the codebase.
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
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
