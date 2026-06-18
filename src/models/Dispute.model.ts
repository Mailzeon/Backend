import mongoose, { Schema, Document, Types } from 'mongoose';
import { DisputeReason, DisputeStatus } from '../types';

export interface IDispute extends Document {
  orderId: Types.ObjectId;
  customerId: Types.ObjectId;
  workerId: Types.ObjectId;
  reason: DisputeReason;
  description?: string;
  status: DisputeStatus;
  adminNote?: string;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DisputeSchema = new Schema<IDispute>(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    workerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reason: {
      type: String,
      enum: ['wrong_password', 'unable_to_login', 'account_issue', 'other'],
      required: true,
    },
    description: String,
    status: {
      type: String,
      enum: ['open', 'resolved', 'rejected'],
      default: 'open',
    },
    adminNote: String,
    resolvedAt: Date,
  },
  { timestamps: true }
);

DisputeSchema.index({ status: 1, createdAt: -1 }); // Admin dispute queue
DisputeSchema.index({ customerId: 1 });
DisputeSchema.index({ workerId: 1 });

export const Dispute = mongoose.model<IDispute>('Dispute', DisputeSchema);
