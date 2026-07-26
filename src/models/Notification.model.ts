import mongoose, { Schema, Document, Types } from 'mongoose';
import { NotificationType } from '../types';

export interface INotification extends Document {
  userId: Types.ObjectId;
  title: string;
  message: string;
  type: NotificationType;
  isRead: boolean;
  orderId?: Types.ObjectId;
  createdAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['order', 'withdrawal', 'verification', 'dispute', 'system'],
      required: true,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

// ── Auto-cleanup ────────────────────────────────────────────────────────────
// TTL index: MongoDB's background TTL monitor (runs every ~60s) deletes any
// document matching partialFilterExpression once `createdAt` is older than
// expireAfterSeconds. This only targets isRead: true — unread notifications
// are never touched, no matter how old. Read notifications are cleared out
// 30 days after they were created.
// No cron job or extra code needed — this is enforced entirely by MongoDB.
NotificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { isRead: true } }
);

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);
