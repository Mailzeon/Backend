import mongoose, { Schema, Document, Types } from 'mongoose';

// Bulk ordering: a customer pays ONCE for N accounts of the same
// service/price, but each account still becomes its OWN separate Order
// document — individually visible in the marketplace, individually
// acceptable by any worker, individually tracked through its own
// lifecycle (accept → credentials → complete/dispute). This model exists
// purely to tie that one payment to its N resulting Order documents (see
// Order.model.ts's `batchId` field) — it has no lifecycle of its own
// beyond "did the payment succeed."
export interface IOrderBatch extends Document {
  customerId: Types.ObjectId;
  serviceName: string;
  domain: string;
  emailType: 'random' | 'custom';
  amountPerOrder: number;
  quantity: number;
  totalAmount: number;
  walletAmountApplied: number;
  cashfreeOrderId?: string;
  // No 'accepted'/'completed'/etc — those all live on the individual child
  // Order documents. This only ever needs to answer "is the ONE payment
  // covering this batch done, failed, or still pending."
  status: 'payment_pending' | 'completed' | 'payment_failed';
  createdAt: Date;
}

const OrderBatchSchema = new Schema<IOrderBatch>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    serviceName: { type: String, required: true, trim: true },
    domain: { type: String, required: true },
    emailType: { type: String, enum: ['random', 'custom'], required: true },
    amountPerOrder: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 2 },
    totalAmount: { type: Number, required: true, min: 0 },
    walletAmountApplied: { type: Number, default: 0, min: 0 },
    cashfreeOrderId: { type: String },
    status: {
      type: String,
      enum: ['payment_pending', 'completed', 'payment_failed'],
      default: 'payment_pending',
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

OrderBatchSchema.index({ customerId: 1, createdAt: -1 });
OrderBatchSchema.index({ cashfreeOrderId: 1 });

export const OrderBatch = mongoose.model<IOrderBatch>('OrderBatch', OrderBatchSchema);
