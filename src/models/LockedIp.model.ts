import { Schema, model, Document, Types } from 'mongoose';

// Tracks IP addresses tied to a worker currently serving a dispute-strike
// penalty. Exists specifically to close the "just make a new account"
// loophole — see user.service.ts applyStrike() and auth.service.ts
// register()/login(). One document per IP; upserted (not accumulated) so
// each IP only ever has a single, current lock window.
export interface ILockedIp extends Document {
  ip: string;
  workerId: Types.ObjectId;
  lockedUntil: Date;
  strikeCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const LockedIpSchema = new Schema<ILockedIp>(
  {
    ip: {
      type: String,
      required: true,
      unique: true,
    },
    workerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    lockedUntil: {
      type: Date,
      required: true,
    },
    strikeCount: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true }
);

// TTL-ish safety net: Mongo doesn't need this to function correctly (every
// read already compares lockedUntil to `now`), but it keeps the collection
// from growing forever with long-expired rows nobody's cleaning up.
LockedIpSchema.index({ lockedUntil: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const LockedIp = model<ILockedIp>('LockedIp', LockedIpSchema);
