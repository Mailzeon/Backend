import mongoose, { Schema, Document, Types } from 'mongoose';
import { WithdrawalStatus, PaymentMethod } from '../types';

export interface IWithdrawRequest extends Document {
  workerId: Types.ObjectId;
  amount: number;
  paymentMethod: PaymentMethod;
  upiId?: string;
  bankDetails?: {
    accountHolder: string;
    accountNumber: string;
    ifscCode: string;
    bankName: string;
  };
  status: WithdrawalStatus;
  adminNote?: string;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WithdrawRequestSchema = new Schema<IWithdrawRequest>(
  {
    workerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [1, 'Minimum withdrawal is ₹1'],
    },
    paymentMethod: {
      type: String,
      enum: ['upi', 'bank'],
      required: true,
    },
    upiId: { type: String, trim: true },
    bankDetails: {
      accountHolder: String,
      accountNumber: String,
      ifscCode: String,
      bankName: String,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'completed'],
      default: 'pending',
    },
    adminNote: String,
    processedAt: Date,
  },
  { timestamps: true }
);

WithdrawRequestSchema.index({ workerId: 1, status: 1 });
WithdrawRequestSchema.index({ status: 1, createdAt: -1 }); // Admin panel sort

export const WithdrawRequest = mongoose.model<IWithdrawRequest>(
  'WithdrawRequest',
  WithdrawRequestSchema
);
