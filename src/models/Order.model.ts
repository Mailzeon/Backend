import mongoose, { Schema, Document, Types } from 'mongoose';
import { OrderStatus } from '../types';

export interface IOrder extends Document {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  workerId?: Types.ObjectId;
  serviceName: string;

  // Full amount the customer pays. Previously a fixed admin-set price —
  // now the customer sets this themselves at order creation (min ₹15,
  // enforced in order.service.ts / order.validator.ts).
  amount: number;

  // 85% of `amount` — what the worker actually earns. Computed once at
  // order creation using the commission rate active at that time, then
  // locked in (so later commission-rate changes never affect past orders).
  workerEarning: number;

  // NEW: 15% of `amount` — the platform's cut. Stored explicitly (not just
  // derived from amount - workerEarning) so admin reporting/analytics can
  // query it directly.
  platformCommission: number;

  // NEW: the commission rate (e.g. 0.15) actually used for this order —
  // an audit trail in case platformCommissionRate setting changes later.
  commissionRate: number;

  status: OrderStatus;

  // NEW — Cashfree payment tracking. `cashfreeOrderId` is the order_id we
  // send to Cashfree (currently just this document's own _id as a string).
  // `paymentStatus` is separate internal bookkeeping from `status` above —
  // it specifically tracks the payment lifecycle, while `status` tracks
  // the overall order/fulfillment lifecycle.
  cashfreeOrderId?: string;
  paymentStatus: 'pending' | 'success' | 'failed';

  // NEW — how much of this order's `amount` was paid using wallet credit
  // (from a previous refund) rather than Cashfree. The remainder
  // (amount - walletAmountApplied) is what actually goes through Cashfree.
  // Worker earning/commission are still calculated off the full `amount` —
  // this only affects how the CUSTOMER's payment was split.
  walletAmountApplied: number;

  // NEW — referral tax (see wallet.service.ts settleOrderEarnings()).
  // Locked in at ACCEPT time (once we finally know which worker is doing
  // the work) rather than at order creation, same reasoning as
  // commissionRate above: the referral tax setting could change later, but
  // this order should always pay out at the rate that applied when the
  // worker actually took the job. Only set when the accepting worker was
  // themselves referred by another worker.
  referralTaxRate?: number;   // percentage, e.g. 3
  referralTaxAmount?: number; // rupees, deducted from workerEarning
  referrerId?: Types.ObjectId; // who receives referralTaxAmount

  // The exact email address the customer wants created for this order.
  // Only set when emailType === 'custom'. For 'random' orders this is left
  // undefined on purpose — see `domain` and `emailType` below — the worker
  // is free to submit ANY existing or newly-created address on the right
  // domain, not one specific pre-generated string.
  requestedEmail?: string;

  // NEW — always stored regardless of emailType, since 'random' orders no
  // longer bake the domain into requestedEmail. Used to (a) show the
  // worker which provider to use, and (b) validate their submitted
  // credentials.email actually ends in @domain (see order.service.ts
  // submitCredentials()).
  domain: string;

  // NEW — 'custom': worker must create requestedEmail exactly.
  // 'random': worker submits ANY email on `domain` (old or newly created) —
  // this is what actually makes "random" behave like a random pick from
  // the worker's own available accounts, instead of forcing them to create
  // one specific auto-generated address every time.
  emailType: 'random' | 'custom';

  // Submitted by worker — NEVER exposed to the worker's own earnings view,
  // shown to customer once submitted (see order.service.ts getOrder).
  credentials?: {
    email: string;
    password: string;
    notes?: string;
  };

  // The number the customer sees on their new-device Google login screen
  // (method: 'number'), OR the actual login code the worker sends back
  // (method: 'code') — see verificationMethod below. Same field, different
  // meaning depending on which flow the customer picked, since Google
  // doesn't always show the same kind of prompt.
  verificationCode?: string;

  // Which verification flow is active for this order. Google sometimes
  // shows a "select this number on your other device" prompt, and
  // sometimes just texts/shows a plain code instead — the platform can't
  // control which one, so the customer picks whichever matches what they
  // actually see:
  //   'number' — customer submits the number, worker CONFIRMS by selecting
  //              it on their own device (see verificationConfirmed).
  //   'code'   — customer REQUESTS a code, worker submits the actual code
  //              back (e.g. from an authenticator app or SMS they have
  //              access to for the account), customer types it in.
  verificationMethod?: 'number' | 'code';

  // True once the worker has selected the matching number on their device
  // and tapped "Confirm" in the app. Lets the customer's UI show "worker
  // confirmed — try logging in now" instead of a raw code to type in.
  // Only meaningful when verificationMethod === 'number'.
  verificationConfirmed?: boolean;

  acceptedAt?: Date;
  timerExpiresAt?: Date;
  credentialsSubmittedAt?: Date;
  autoCompleteAt?: Date;
  completedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema = new Schema<IOrder>(
  {
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    workerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    serviceName: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      // Bare sanity floor only (must be positive) — NOT the real business
      // minimum, which is admin-configurable via the minimumOrderAmount
      // setting and enforced dynamically in order.service.ts BEFORE this
      // document is ever saved. This was previously hardcoded to `15`,
      // which silently overrode any admin setting below ₹15 — same bug
      // as the one fixed in order.validator.ts, just one layer deeper
      // (Zod runs first and was already fixed, but this Mongoose-level
      // validator still fired at .save() time regardless).
      min: [1, 'Order amount must be at least ₹1'],
    },
    workerEarning: {
      type: Number,
      required: true,
    },
    platformCommission: {
      type: Number,
      required: true,
    },
    commissionRate: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: [
        'payment_pending',   // NEW: order created, waiting for Cashfree payment confirmation
        'payment_failed',    // NEW: payment did not succeed — terminal state
        'pending',           // Payment confirmed — now visible in marketplace
        'accepted',
        'credentials_submitted',
        'verification_pending',
        'success_confirmed',
        'completed',
        'under_review',
        'cancelled',
      ],
      // Orders now start unpaid — they only become 'pending' (marketplace-visible)
      // once Cashfree confirms payment via webhook or the verify-on-return check.
      default: 'payment_pending',
    },

    cashfreeOrderId: {
      type: String,
      trim: true,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'success', 'failed'],
      default: 'pending',
    },
    walletAmountApplied: {
      type: Number,
      default: 0,
      min: [0, 'Wallet amount applied cannot be negative'],
    },

    referralTaxRate: { type: Number },
    referralTaxAmount: { type: Number },
    referrerId: { type: Schema.Types.ObjectId, ref: 'User' },

    requestedEmail: {
      type: String,
      trim: true,
      lowercase: true,
      // Was `required: true` — no longer, since 'random' orders
      // intentionally leave this unset (see IOrder interface comment above).
    },

    domain: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
    },

    emailType: {
      type: String,
      enum: ['random', 'custom'],
      required: true,
    },

    credentials: {
      email: String,
      password: String,
      notes: String,
    },

    verificationCode: String,
    verificationMethod: { type: String, enum: ['number', 'code'] },
    verificationConfirmed: { type: Boolean, default: false },
    acceptedAt: Date,
    timerExpiresAt: Date,
    credentialsSubmittedAt: Date,
    autoCompleteAt: Date,
    completedAt: Date,
  },
  { timestamps: true }
);

// ─── Indexes for common queries ───────────────────────────────────────────────
OrderSchema.index({ status: 1, createdAt: -1 });       // Marketplace list
OrderSchema.index({ customerId: 1, createdAt: -1 });   // Customer order history
OrderSchema.index({ workerId: 1, status: 1 });         // Worker active orders
OrderSchema.index({ timerExpiresAt: 1, status: 1 });   // Timer cleanup job
OrderSchema.index({ cashfreeOrderId: 1 });              // Webhook lookup

export const Order = mongoose.model<IOrder>('Order', OrderSchema);
