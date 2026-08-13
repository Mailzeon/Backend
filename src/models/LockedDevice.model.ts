import { Schema, model, Document, Types } from 'mongoose';

// Same idea as LockedIp.model.ts, but keyed on a browser device fingerprint
// (see utils/fingerprint on the frontend, captured at register/login) instead
// of an IP address. IP alone is easy to dodge with a VPN or mobile data —
// this catches a struck/suspended worker who changes their IP but signs up
// again from the SAME physical browser/device. Neither signal is perfect on
// its own (fingerprints can be reset via a different browser or a device
// reset, same as a VPN changes an IP) — auth.service.ts checks BOTH and
// treats a match on either as a hit, which is what actually makes the combo
// meaningfully harder to evade than either alone.
export interface ILockedDevice extends Document {
  deviceId: string;
  workerId: Types.ObjectId;
  lockedUntil: Date;
  strikeCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const LockedDeviceSchema = new Schema<ILockedDevice>(
  {
    deviceId: {
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

// Same TTL-ish safety net as LockedIp.model.ts.
LockedDeviceSchema.index({ lockedUntil: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const LockedDevice = model<ILockedDevice>('LockedDevice', LockedDeviceSchema);
