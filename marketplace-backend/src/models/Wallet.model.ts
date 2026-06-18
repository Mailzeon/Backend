import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IWallet extends Document {
  userId: Types.ObjectId;
  balance: number;         // Available to withdraw right now
  pendingBalance: number;  // Held until order is completed/confirmed
  totalEarned: number;     // Lifetime earnings (never decreases)
  createdAt: Date;
  updatedAt: Date;
}

const WalletSchema = new Schema<IWallet>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    balance: {
      type: Number,
      default: 0,
      min: [0, 'Balance cannot be negative'],
    },
    pendingBalance: {
      type: Number,
      default: 0,
      min: [0, 'Pending balance cannot be negative'],
    },
    totalEarned: {
      type: Number,
      default: 0,
      min: [0, 'Total earned cannot be negative'],
    },
  },
  { timestamps: true }
);

export const Wallet = mongoose.model<IWallet>('Wallet', WalletSchema);
