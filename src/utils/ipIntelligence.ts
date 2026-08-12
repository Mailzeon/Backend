import { env } from '../config/env';

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

// In-memory only (resets on server restart, which Render's free tier does
// often enough anyway) — once Abstract returns a 422 (monthly quota used
// up), remember that until the calendar month rolls over, so every
// subsequent call skips straight to the proxycheck.io fallback instead of
// wasting a request finding out Abstract is still exhausted. No DB state
// needed for this, and worst case (a restart resets it early) just costs
// one extra wasted Abstract call, not a functional problem.
let abstractExhaustedForMonth: number | null = null; // 0-11, matches Date#getMonth()

async function checkAbstract(ip: string): Promise<IpRiskResult | null> {
  if (!env.ABSTRACT_IP_API_KEY) return null;
  if (abstractExhaustedForMonth === new Date().getMonth()) return null;

  try {
    const url = `https://ip-intelligence.abstractapi.com/v1/?api_key=${encodeURIComponent(env.ABSTRACT_IP_API_KEY)}&ip_address=${encodeURIComponent(ip)}&fields=security`;
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(6000) });

    if (res.status === 422) {
      // Free-tier monthly credits used up — this is the expected, planned
      // "switch to fallback for the rest of the month" trigger, not an
      // error worth logging loudly.
      abstractExhaustedForMonth = new Date().getMonth();
      return null;
    }
    if (!res.ok) {
      console.error(`[IpIntelligence] Abstract returned ${res.status}`);
      return null;
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

    return { isRisky: reasons.length > 0, reasons, provider: 'abstract', checkedAt: new Date() };
  } catch (err) {
    console.error('[IpIntelligence] Abstract check failed:', err);
    return null;
  }
}

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
 * auth.service.ts register()). Two providers tried in order:
 *   1. Abstract IP Intelligence — primary, 1000 free/month
 *   2. proxycheck.io — fallback once Abstract's monthly quota is used up,
 *      1000 free/day (with a free registered key) or 100/day without one
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
