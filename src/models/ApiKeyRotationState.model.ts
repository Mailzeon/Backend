import { Schema, model, Document } from 'mongoose';

/**
 * Persists rotation state for multi-key providers (currently: Abstract
 * Email Reputation — see utils/emailVerification.ts). A SINGLE document
 * per provider, keyed by a fixed `_id` string, so there's always exactly
 * one to read/update (upserted on first use, no separate seed step
 * needed).
 *
 * Persisted in the DB rather than kept in-memory (unlike the simpler
 * single-key monthly-exhaustion tracking in utils/ipIntelligence.ts)
 * because with potentially 10+ keys, losing the "which ones are
 * exhausted" state on every Render restart would mean re-discovering
 * exhausted keys one wasted request at a time after every restart —
 * annoying at 2 keys, actually costly at 10+.
 */
export interface IApiKeyRotationState extends Document {
  _id: string;
  // Index (into the provider's configured key array) most recently used —
  // the next check starts searching from here + 1, so load spreads evenly
  // across all configured keys instead of always hammering key #0 first.
  lastUsedIndex: number;
  // Key index (as a string, since Mongoose Maps require string keys) ->
  // the date its monthly quota resets. A key is skipped while its entry
  // here is still in the future.
  exhausted: Map<string, Date>;
}

const ApiKeyRotationStateSchema = new Schema<IApiKeyRotationState>({
  _id:           { type: String, required: true },
  lastUsedIndex: { type: Number, default: -1 },
  exhausted:     { type: Map, of: Date, default: () => new Map() },
});

export const ApiKeyRotationState = model<IApiKeyRotationState>(
  'ApiKeyRotationState',
  ApiKeyRotationStateSchema
);
