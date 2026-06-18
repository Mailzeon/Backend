import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IRating extends Document {
  orderId: Types.ObjectId;
  customerId: Types.ObjectId;
  workerId: Types.ObjectId;
  rating: 1 | 2 | 3 | 4 | 5;
  createdAt: Date;
}

const RatingSchema = new Schema<IRating>(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      unique: true, // One rating per order — no duplicates
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
    rating: {
      type: Number,
      enum: [1, 2, 3, 4, 5],
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

RatingSchema.index({ workerId: 1 }); // Calculate average rating per worker

export const Rating = mongoose.model<IRating>('Rating', RatingSchema);
