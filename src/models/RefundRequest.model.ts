import mongoose, { Schema, Document, Types } from 'mongoose';

export type RefundStatus = 'pending' | 'completed' | 'rejected';

export interface IRefundRequest extends Document {
  orderId: Types.ObjectId;
  customerId: Types.ObjectId;
  amount: number;
  upiId: string;
  status: RefundStatus;
  adminNote?: string;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RefundRequestSchema = new Schema<IRefundRequest>(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      unique: true, // One refund request per order — no duplicates
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [1, 'Refund amount must be positive'],
    },
    upiId: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'rejected'],
      default: 'pending',
    },
    adminNote: String,
    processedAt: Date,
  },
  { timestamps: true }
);

RefundRequestSchema.index({ status: 1, createdAt: -1 }); // Admin refund queue
RefundRequestSchema.index({ customerId: 1 });

export const RefundRequest = mongoose.model<IRefundRequest>('RefundRequest', RefundRequestSchema);
