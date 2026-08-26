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

  // NEW — customer referral bonus (see order.service.ts createOrder() /
  // wallet.service.ts settleOrderEarnings()). Locked in at ORDER CREATION
  // time, unlike the worker referral tax above — the customer's
  // referredBy is already known the moment they place the order (no need
  // to wait for a worker to accept, since this depends on the CUSTOMER's
  // referral relationship, not the worker's). Deducted from the same
  // fulfilling worker's earning at settlement, alongside referralTaxAmount
  // above if both happen to apply — the two programs are independent and
  // can stack. Only set when the customer placing this order was
  // themselves referred by another customer.
  customerReferralBonusRate?: number;   // percentage, e.g. 3
  customerReferralBonusAmount?: number; // rupees, deducted from workerEarning at settlement
  customerReferrerId?: Types.ObjectId;  // which referring customer receives it

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

  // NEW — set whenever the accept-timer expires WITHOUT confirmed theft
  // (order goes back to 'pending' for someone else to pick up) — see
  // utils/orderTimer.ts. Survives even after `workerId` is cleared back to
  // null, so that if the SAME requested email later turns out to be taken
  // (caught on a subsequent worker's accept attempt — see
  // acceptOrder() below — rather than at that original expiry moment,
  // e.g. because the verification API was transiently down and failed
  // open), we can still correctly identify and permanently ban the worker
  // who actually abandoned it, instead of losing that trail entirely.
  // Intentionally NOT cleared on a normal successful accept — it's a
  // historical breadcrumb, not live state, and the full picture is also
  // captured in OrderHistory regardless.
  lastAbandonedWorkerId?: Types.ObjectId;

  // NEW — bulk ordering (see order.service.ts createBulkOrder() /
  // models/OrderBatch.model.ts). Set only when this order was created as
  // part of a bulk placement — one customer payment covering N of these.
  // Unset (undefined) for every normal, single-order placement, which is
  // the vast majority of orders and stays completely unaffected by this
  // field's existence. Each order with a shared batchId is still fully
  // independent from here on — separate marketplace listing, separate
  // accept/complete/dispute lifecycle, exactly like any other order.
  batchId?: Types.ObjectId;

  // ── Wrong-password dispute grace window ──────────────────────────────
  // See utils/disputeGrace.ts + order.service.ts reportProblem()/
  // resubmitCredentials(). When a customer disputes with reason
  // 'wrong_password' for the FIRST time on an order, the worker gets one
  // timed chance to resubmit corrected credentials before the dispute
  // actually reaches admin — deliberately NOT the same as a second
  // dispute or a repeat offense, which skip straight to admin and are
  // treated as confirmed theft if upheld.
  wrongPasswordGraceDeadline?: Date;
  // True the moment a grace window has been granted — set immediately,
  // BEFORE the deadline passes, so this order can never get a second one
  // even if something re-triggers reportProblem() again.
  wrongPasswordGraceUsed?: boolean;
  // Rupees, locked in at resubmission time (workerEarning is already
  // fixed by then) — deducted at settlement in wallet.service.ts
  // settleOrderEarnings(), same mechanism as referralTaxAmount above.
  wrongPasswordPenaltyAmount?: number;

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

    customerReferralBonusRate: { type: Number },
    customerReferralBonusAmount: { type: Number },
    customerReferrerId: { type: Schema.Types.ObjectId, ref: 'User' },

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
      // Was `required: true` — no longer. Application code (createOrder)
      // always sets this for new orders, so the constraint added no real
      // protection — but it broke every order created BEFORE this field
      // existed: any save() on one of those legacy documents (e.g. the
      // auto-complete job trying to mark one 'completed') failed schema
      // validation because the old document has no domain/emailType at
      // all, permanently blocking that specific order from ever
      // completing. See Aug 10 2026 Render logs — order 6a7225a0a48ac1dbbd6260f8.
    },

    emailType: {
      type: String,
      enum: ['random', 'custom'],
      // Same reasoning as domain above — no longer required at the DB
      // level, for the same legacy-document reason.
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
    lastAbandonedWorkerId: { type: Schema.Types.ObjectId, ref: 'User' },
    batchId: { type: Schema.Types.ObjectId, ref: 'OrderBatch', index: true },
    wrongPasswordGraceDeadline: Date,
    wrongPasswordGraceUsed: { type: Boolean, default: false },
    wrongPasswordPenaltyAmount: Number,
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
