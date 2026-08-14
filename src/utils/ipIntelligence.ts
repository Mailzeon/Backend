import { env } from '../config/env';
import { ApiKeyRotationState } from '../models/ApiKeyRotationState.model';

export interface IpRiskResult {
  // Soft signal, not a hard block — see auth.service.ts register(). VPN/
  // proxy usage is common for perfectly legitimate reasons (privacy,
  // data-saver apps, corporate networks), so this is used to FLAG a new
  // worker signup for admin review, never to auto-reject it outright.
  isRisky: boolean;
  reasons: string[];               // e.g. ['vpn'], ['proxy', 'hosting']
  provider: 'abstract' | 'proxycheck' | 'unavailable';
  checkedAt: Date;
}

const UNAVAILABLE: Omit<IpRiskResult, 'checkedAt'> = {
  isRisky: false, // fail-open — never treat "couldn't check" as suspicious
  reasons: [],
  provider: 'unavailable',
};

const STATE_ID = 'abstract-ip-intelligence';

// ─── Abstract IP Intelligence — multi-key rotation ─────────────────────────
// MULTI-KEY ROTATION (added Aug 14 2026): same system as
// utils/emailVerification.ts / utils/phoneVerification.ts. Accepts ANY
// NUMBER of API keys via ABSTRACT_IP_API_KEYS (comma-separated), rotates
// round-robin, and skips any key that hits its monthly quota (422) until
// the 1st of next month — all configured Abstract keys are tried before
// ever falling through to the proxycheck.io fallback below. Rotation
// state is tracked separately from the email/phone rotations (different
// STATE_ID) even though they share the same underlying model/collection.
// See the big comment block at the bottom of this file for exactly how to
// add more keys.

function getConfiguredAbstractKeys(): string[] {
  if (env.ABSTRACT_IP_API_KEYS) {
    return env.ABSTRACT_IP_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
  }
  // Backward-compat: the original single-key env var still works on its
  // own if the new multi-key one was never set.
  return env.ABSTRACT_IP_API_KEY ? [env.ABSTRACT_IP_API_KEY] : [];
}

async function getOrCreateState() {
  let state = await ApiKeyRotationState.findById(STATE_ID);
  if (!state) {
    state = await ApiKeyRotationState.create({ _id: STATE_ID });
  }
  return state;
}

async function pickAndAdvanceKey(keys: string[]): Promise<{ key: string; index: number } | null> {
  const state = await getOrCreateState();
  const now = new Date();

  for (let i = 1; i <= keys.length; i++) {
    const idx = (state.lastUsedIndex + i) % keys.length;
    const exhaustedUntil = state.exhausted.get(String(idx));
    if (exhaustedUntil && exhaustedUntil > now) continue; // still exhausted this month

    await ApiKeyRotationState.updateOne({ _id: STATE_ID }, { $set: { lastUsedIndex: idx } });
    return { key: keys[idx], index: idx };
  }
  return null;
}

async function markExhausted(index: number): Promise<void> {
  const now = new Date();
  const resetsAt = new Date(now.getFullYear(), now.getMonth() + 1, 1); // 1st of next month
  await ApiKeyRotationState.updateOne(
    { _id: STATE_ID },
    { $set: { [`exhausted.${index}`]: resetsAt } }
  );
}

async function tryAbstractKey(
  apiKey: string,
  ip: string
): Promise<{ quotaExhausted: boolean; result: IpRiskResult | null }> {
  try {
    const url = `https://ip-intelligence.abstractapi.com/v1/?api_key=${encodeURIComponent(apiKey)}&ip_address=${encodeURIComponent(ip)}&fields=security`;
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(6000) });

    if (res.status === 422) {
      // Free-tier monthly credits used up on this key — expected, not an
      // error worth logging loudly. checkIpRisk() moves on to the next
      // configured key automatically.
      return { quotaExhausted: true, result: null };
    }
    if (!res.ok) {
      console.error(`[IpIntelligence] Abstract returned ${res.status}`);
      return { quotaExhausted: false, result: null };
    }

    const data = (await res.json()) as {
      security?: {
        is_vpn?: boolean; is_proxy?: boolean; is_tor?: boolean;
        is_hosting?: boolean; is_abuse?: boolean;
      };
    };
    const s = data.security || {};
    const reasons: string[] = [];
    if (s.is_vpn)     reasons.push('vpn');
    if (s.is_proxy)   reasons.push('proxy');
    if (s.is_tor)     reasons.push('tor');
    if (s.is_hosting) reasons.push('hosting'); // datacenter/cloud IP, not a home connection
    if (s.is_abuse)   reasons.push('flagged for abuse');

    return {
      quotaExhausted: false,
      result: { isRisky: reasons.length > 0, reasons, provider: 'abstract', checkedAt: new Date() },
    };
  } catch (err) {
    console.error('[IpIntelligence] Abstract check failed:', err);
    return { quotaExhausted: false, result: null };
  }
}

async function checkAbstract(ip: string): Promise<IpRiskResult | null> {
  const keys = getConfiguredAbstractKeys();
  if (keys.length === 0) return null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const picked = await pickAndAdvanceKey(keys);
    if (!picked) return null; // every configured key exhausted this month

    const outcome = await tryAbstractKey(picked.key, ip);
    if (outcome.quotaExhausted) {
      await markExhausted(picked.index);
      continue; // try the next available key
    }
    return outcome.result; // null here just means a non-quota error — fall through to proxycheck
  }
  return null;
}

// ─── proxycheck.io — final fallback, only reached once every configured
//     Abstract key is exhausted for the month ─────────────────────────────

async function checkProxycheck(ip: string): Promise<IpRiskResult | null> {
  try {
    const keyParam = env.PROXYCHECK_API_KEY ? `&key=${encodeURIComponent(env.PROXYCHECK_API_KEY)}` : '';
    const url = `https://proxycheck.io/v2/${encodeURIComponent(ip)}?vpn=1${keyParam}`;
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      console.error(`[IpIntelligence] proxycheck.io returned ${res.status}`);
      return null;
    }

    const data = (await res.json()) as Record<string, any>;
    if (data.status !== 'ok' && data.status !== 'warning') return null;

    const entry = data[ip];
    if (!entry) return null;

    const isRisky = entry.proxy === 'yes';
    const reasons = isRisky ? [String(entry.type || 'proxy').toLowerCase()] : [];

    return { isRisky, reasons, provider: 'proxycheck', checkedAt: new Date() };
  } catch (err) {
    console.error('[IpIntelligence] proxycheck.io check failed:', err);
    return null;
  }
}

/**
 * Checks whether an IP is a VPN/proxy/Tor exit node — used at worker
 * registration to flag new signups for admin review (see
 * auth.service.ts register()). Tries, in order:
 *   1. Abstract IP Intelligence — ANY number of rotating keys (see
 *      ABSTRACT_IP_API_KEYS), each 1000 free/month
 *   2. proxycheck.io — fallback once EVERY configured Abstract key is
 *      exhausted for the month, 1000 free/day (with a free registered
 *      key) or 100/day without one
 * Deliberately a soft signal only — never used to block a signup outright,
 * since VPN use alone doesn't mean anything is actually wrong.
 */
export async function checkIpRisk(ip: string): Promise<IpRiskResult> {
  const fromAbstract = await checkAbstract(ip);
  if (fromAbstract) return fromAbstract;

  const fromProxycheck = await checkProxycheck(ip);
  if (fromProxycheck) return fromProxycheck;

  return { ...UNAVAILABLE, checkedAt: new Date() };
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * HOW TO ADD MORE ABSTRACT IP INTELLIGENCE KEYS
 * ═══════════════════════════════════════════════════════════════════════
 * 1. Sign up for a new (free) Abstract API account with a different email,
 *    enable the "IP Intelligence" product specifically, and copy that
 *    account's API key.
 * 2. Go to Render → your backend service → Environment.
 * 3. Find (or create) the env var named ABSTRACT_IP_API_KEYS.
 * 4. Set its value to ALL your keys, comma-separated:
 *       key1,key2,key3,key4,key5
 *    To add a new key later, just edit this value and append ",newkey" —
 *    no code changes needed, Render redeploys automatically on save.
 * 5. Save — that's it. Rotation picks it up immediately. proxycheck.io
 *    keeps working as the fallback underneath all of this regardless.
 * ═══════════════════════════════════════════════════════════════════════
 */
