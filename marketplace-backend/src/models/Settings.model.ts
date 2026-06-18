import mongoose, { Schema, Document } from 'mongoose';

export interface ISettings extends Document {
  key: string;
  value: string;
  description: string;
  updatedAt: Date;
}

const SettingsSchema = new Schema<ISettings>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    value: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: { createdAt: false, updatedAt: true },
  }
);

export const Settings = mongoose.model<ISettings>('Settings', SettingsSchema);

// ─── Default settings seeded on first run ─────────────────────────────────────
// These are inserted by the database seeder in Phase 1.
//
// { key: 'orderPrice',        value: '50',  description: 'Customer order price in INR' }
// { key: 'workerEarning',     value: '20',  description: 'Worker earning per order in INR' }
// { key: 'autoCompleteHours', value: '24',  description: 'Hours before order auto-completes' }
// { key: 'orderTimerMinutes', value: '10',  description: 'Minutes worker has to submit credentials' }

/**
 * Seeds the four default platform settings on first startup.
 * Uses $setOnInsert so existing values are NEVER overwritten —
 * admin changes made via the panel persist across restarts.
 */
export const seedDefaultSettings = async (): Promise<void> => {
  const defaults = [
    { key: 'orderPrice',        value: '50',  description: 'Customer order price in INR' },
    { key: 'workerEarning',     value: '20',  description: 'Worker earning per order in INR' },
    { key: 'autoCompleteHours', value: '24',  description: 'Hours after credential submission before auto-complete' },
    { key: 'orderTimerMinutes', value: '10',  description: 'Minutes worker has to submit credentials after accepting' },
  ];

  for (const s of defaults) {
    await Settings.findOneAndUpdate(
      { key: s.key },
      { $setOnInsert: s },
      { upsert: true, new: false }
    );
  }
  console.log('✅ Default settings ready');
};
