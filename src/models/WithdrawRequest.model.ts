import mongoose, { Schema, Document, Types } from 'mongoose';
import { WithdrawalStatus, PaymentMethod } from '../types';

export interface IWithdrawRequest extends Document {
  workerId: Types.ObjectId;
  amount: number;
  paymentMethod: PaymentMethod;
  upiId?: string;
  // NEW: for UPI withdrawals, the worker now must ALSO provide a
  // screenshot of their own UPI app's QR code and type the exact name
  // that app shows as the account holder — see withdrawal.service.ts
  // create() for why all three (UPI ID + QR + name) are required
  // together, not just the ID alone. Admin cross-checks the name against
  // what their own UPI app shows when actually paying — see
  // ADMIN_UPI_NAME_INSTRUCTIONS in withdrawal.service.ts for the exact
  // wording shown to workers about this.
  upiQrCode?: string;
  upiVerifiedName?: string;
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
    upiQrCode: { type: String, trim: true },
    upiVerifiedName: { type: String, trim: true },
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
