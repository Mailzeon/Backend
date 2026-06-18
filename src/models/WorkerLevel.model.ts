import mongoose, { Schema, Document, Types } from 'mongoose';
import { WorkerLevel } from '../types';

export interface IWorkerLevel extends Document {
  workerId: Types.ObjectId;
  level: WorkerLevel;
  completedOrders: number;
  totalEarnings: number;
  successRate: number;    // Percentage: 0–100
  averageRating: number;  // 1.0–5.0
  updatedAt: Date;
}

const WorkerLevelSchema = new Schema<IWorkerLevel>(
  {
    workerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    level: {
      type: String,
      enum: ['bronze', 'silver', 'gold'],
      default: 'bronze',
    },
    completedOrders: { type: Number, default: 0 },
    totalEarnings:   { type: Number, default: 0 },
    successRate:     { type: Number, default: 100 }, // Starts at 100% with no orders
    averageRating:   { type: Number, default: 0 },
  },
  {
    // Level stats recalculate on order completion — no createdAt needed
    timestamps: { createdAt: false, updatedAt: true },
  }
);

// ─── Level thresholds (used by WorkerLevel service) ───────────────────────────
// Bronze → Silver: 10 completed orders, success rate ≥ 80%
// Silver → Gold:   50 completed orders, success rate ≥ 90%, avg rating ≥ 4.0

export const WorkerLevelModel = mongoose.model<IWorkerLevel>('WorkerLevel', WorkerLevelSchema);
