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

  // The exact email address the customer wants created for this order.
  requestedEmail?: string;

  // Submitted by worker — NEVER exposed to the worker's own earnings view,
  // shown to customer once submitted (see order.service.ts getOrder).
  credentials?: {
    email: string;
    password: string;
    notes?: string;
  };

  verificationCode?: string;

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
      min: [15, 'Order amount must be at least ₹15'],
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

    requestedEmail: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
    },

    credentials: {
      email: String,
      password: String,
      notes: String,
    },

    verificationCode: String,
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
