import mongoose, { Schema, Document } from 'mongoose';

// A user can have multiple subscriptions (phone + laptop, or after
// reinstalling/clearing browser data) — each browser's Push API subscription
// is a separate endpoint, so this is a one-to-many relationship with User.
export interface IPushSubscription extends Document {
  userId:   mongoose.Types.ObjectId;
  endpoint: string;
  keys: {
    p256dh: string;
    auth:   string;
  };
  createdAt: Date;
}

const PushSubscriptionSchema = new Schema<IPushSubscription>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Unique — the browser's push endpoint URL IS the subscription's
    // identity. Re-subscribing from the same browser naturally upserts
    // rather than creating a duplicate row.
    endpoint: {
      type: String,
      required: true,
      unique: true,
    },
    keys: {
      p256dh: { type: String, required: true },
      auth:   { type: String, required: true },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const PushSubscription = mongoose.model<IPushSubscription>(
  'PushSubscription',
  PushSubscriptionSchema
);
