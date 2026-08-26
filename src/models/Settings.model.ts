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
      key: 'maxBulkOrderQuantity',
      value: '50',
      description: 'Maximum number of accounts a customer can order in a single bulk placement',
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
    // ── Dispute-strike penalty (escalating) ──────────────────────────────
    // See user.service.ts applyStrike() — hours a worker is locked out of
    // accepting orders after a dispute is resolved against them (or after
    // going silent on a live verification request). They still see every
    // order in the marketplace during the lock, just can't take any.
    {
      key: 'strikeLockHours1',
      value: '6',
      description: '1st dispute strike — hours the worker is locked out of accepting orders',
    },
    {
      key: 'strikeLockHours2',
      value: '24',
      description: '2nd dispute strike — hours locked',
    },
    {
      key: 'strikeLockHours3',
      value: '72',
      description: '3rd dispute strike — hours locked',
    },
    {
      key: 'strikeLockHours4Plus',
      value: '168',
      description: '4th and every further strike — hours locked (also flags the worker to admins as a repeat offender for possible permanent suspension)',
    },
    // ── Worker referral program ──────────────────────────────────────────
    // See wallet.service.ts settleOrderEarnings() — this percentage is
    // deducted from a REFERRED worker's earning on every order they
    // complete and paid straight to whoever referred them. Comes entirely
    // out of the worker's own cut, never the platform's commission.
    {
      key: 'referralTaxRate',
      value: '3',
      description: 'Percent of a referred worker\'s earning paid to their referrer on every completed order',
    },
    // ── Customer referral program ─────────────────────────────────────────
    // See order.service.ts createOrder() / wallet.service.ts
    // settleOrderEarnings() — this percentage is ALSO deducted from the
    // fulfilling WORKER's earning (same funding source as the worker
    // referral tax above — it's the order's own margin/split being
    // redistributed, never an extra platform cost) whenever the CUSTOMER
    // placing the order was referred by another customer, and paid to
    // that referring customer's wallet. Deliberately kept as its own
    // separate setting/field from referralTaxRate above even though the
    // mechanism is similar — they're two independent programs (worker→
    // worker vs customer→customer) that an admin may want to tune
    // differently, and mixing their accounting would make it impossible
    // to see how much either program actually costs on its own.
    {
      key: 'customerReferralBonusRate',
      value: '3',
      description: 'Percent deducted from the fulfilling worker\'s earning and paid to a referring customer, on every order placed by the customer they referred',
    },
    // ── Wrong-password dispute grace window ──────────────────────────────
    // See utils/disputeGrace.ts / order.service.ts reportProblem(). Gives
    // a worker one timed chance to fix a wrong password BEFORE the
    // dispute reaches admin — a second wrong attempt (or letting the
    // window expire) escalates straight to admin, and is treated as
    // CONFIRMED THEFT (permanent ban) if upheld, not just a strike.
    {
      key: 'wrongPasswordGraceMinutes',
      value: '30',
      description: 'Minutes a worker has to resubmit corrected credentials after a "wrong password" dispute, before it escalates to admin',
    },
    {
      key: 'wrongPasswordPenaltyRate',
      value: '5',
      description: 'Percent deducted from a worker\'s earning on an order where their first password submission was wrong (even if corrected in time)',
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
