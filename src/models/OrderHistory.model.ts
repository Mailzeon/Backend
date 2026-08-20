import mongoose, { Schema, Document, Types } from 'mongoose';

// Every meaningful thing that can happen to an order, in the order they
// naturally occur — used to build a chronological timeline per order in
// the admin panel (see routes/admin.routes.ts GET /orders/:id/history).
// Deliberately a SEPARATE collection from Order itself: Order only ever
// holds the CURRENT state (workerId gets overwritten/cleared on
// re-listing, expiry, etc.) — this collection is the append-only record
// of everything that happened along the way, which the Order document
// alone can never reconstruct once a value has been overwritten.
export type OrderHistoryEvent =
  | 'created'
  | 'payment_confirmed'
  | 'payment_failed'
  | 'accepted'
  | 'accept_blocked_email_taken'
  | 'expired_returned'
  | 'theft_confirmed'
  | 'credentials_submitted'
  | 'wrong_password_grace_granted'
  | 'wrong_password_resubmitted'
  | 'completed'
  | 'auto_completed'
  | 'dispute_reported'
  | 'dispute_resolved_upheld'
  | 'dispute_resolved_rejected'
  | 'auto_cancelled_worker_unresponsive'
  | 'cancelled'
  | 'refunded';

export interface IOrderHistory extends Document {
  orderId: Types.ObjectId;
  event: OrderHistoryEvent;
  // Who/what caused this event. Left unset for pure system/cron actions
  // that have no single human actor (e.g. the 5-minute auto-complete
  // sweep catching a lost in-process timer).
  actorId?: Types.ObjectId;
  actorRole?: 'customer' | 'worker' | 'admin' | 'system';
  // Precomputed human-readable line for this event — written once at
  // log time rather than reconstructed from metadata on every read, so
  // the timeline stays readable even if the event's meaning/wording
  // changes in a later code version.
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const OrderHistorySchema = new Schema<IOrderHistory>(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    event: {
      type: String,
      required: true,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    actorRole: {
      type: String,
      enum: ['customer', 'worker', 'admin', 'system'],
    },
    message: {
      type: String,
      required: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Timeline is always read for one order, oldest-first.
OrderHistorySchema.index({ orderId: 1, createdAt: 1 });

export const OrderHistory = mongoose.model<IOrderHistory>('OrderHistory', OrderHistorySchema);
