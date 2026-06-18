import mongoose, { Schema, Document, Types } from 'mongoose';
import { OrderStatus } from '../types';

export interface IOrder extends Document {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  workerId?: Types.ObjectId;
  serviceName: string;
  amount: number;           // What customer paid (₹50)
  workerEarning: number;    // What worker earns (₹20)
  status: OrderStatus;

  // Submitted by worker — NEVER exposed to customer directly
  credentials?: {
    email: string;
    password: string;
    notes?: string;
  };

  // Verification code flow
  verificationCode?: string;

  // Timestamps for business logic
  acceptedAt?: Date;
  timerExpiresAt?: Date;            // acceptedAt + 10 minutes
  credentialsSubmittedAt?: Date;
  autoCompleteAt?: Date;            // credentialsSubmittedAt + 24 hours
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
    },
    workerEarning: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: [
        'pending',
        'accepted',
        'credentials_submitted',
        'verification_pending',
        'success_confirmed',
        'completed',
        'under_review',
        'cancelled',
      ],
      default: 'pending',
    },

    // Credentials are stored but never sent to customer in API responses
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

export const Order = mongoose.model<IOrder>('Order', OrderSchema);
