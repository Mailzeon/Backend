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
//
// FIX: 'orderPrice' and 'workerEarning' are REMOVED here — customers now set
// their own order amount at creation time (min ₹15) instead of a fixed
// admin-set price. Old 'orderPrice'/'workerEarning' documents already in the
// database (from before this change) are simply left in place, unused and
// harmless — $setOnInsert below never deletes existing keys, and no code
// reads them anymore.
//
// { key: 'minimumOrderAmount',     value: '15', description: '...' }
// { key: 'platformCommissionRate', value: '15', description: '...' }
// { key: 'autoCompleteHours',      value: '24', description: '...' }
// { key: 'orderTimerMinutes',      value: '10', description: '...' }
//
/**
 * Seeds default platform settings on startup. Uses $setOnInsert so existing
 * values are NEVER overwritten — admin changes made via the panel persist
 * across restarts.
 */
export const seedDefaultSettings = async (): Promise<void> => {
  const defaults = [
    {
      key: 'minimumOrderAmount',
      value: '15',
      description: 'Minimum amount (INR) a customer can set when creating an order',
    },
    {
      key: 'platformCommissionRate',
      value: '15',
      description: 'Platform commission percentage deducted from every order (worker keeps the rest)',
    },
    {
      key: 'autoCompleteHours',
      value: '24',
      description: 'Hours after credential submission before order auto-completes',
    },
    {
      key: 'orderTimerMinutes',
      value: '10',
      description: 'Minutes worker has to submit credentials after accepting',
    },
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
