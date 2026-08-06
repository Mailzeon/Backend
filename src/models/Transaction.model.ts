import mongoose, { Schema, Document, Types } from 'mongoose';
import { TransactionType } from '../types';

export interface ITransaction extends Document {
  userId: Types.ObjectId;
  orderId?: Types.ObjectId;
  type: TransactionType;
  amount: number;
  status: 'pending' | 'completed' | 'failed';
  description: string;
  // NEW: only set for type='recharge' — the order_id we sent to Cashfree
  // (format `WALLET-<transactionId>`). Used by the webhook to find and
  // idempotently complete/fail the matching recharge, the same way
  // Order.cashfreeOrderId is used for regular order payments.
  cashfreeOrderId?: string;
  createdAt: Date;
}

const TransactionSchema = new Schema<ITransaction>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
    },
    type: {
      type: String,
      enum: ['credit', 'debit', 'withdrawal', 'recharge'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'completed',
    },
    description: {
      type: String,
      required: true,
    },
    cashfreeOrderId: {
      type: String,
    },
  },
  {
    // Transactions are immutable — we only store createdAt, no updatedAt
    timestamps: { createdAt: true, updatedAt: false },
  }
);

TransactionSchema.index({ userId: 1, createdAt: -1 });
TransactionSchema.index({ cashfreeOrderId: 1 }, { sparse: true });

export const Transaction = mongoose.model<ITransaction>('Transaction', TransactionSchema);
