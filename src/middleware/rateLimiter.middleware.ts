import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import { verifyToken } from '../utils/jwt';
import { AUTH_COOKIE_NAME } from '../utils/cookies';

/**
 * Strict limiter for auth endpoints (login, register).
 * 8 attempts per 15 minutes per IP — enough for genuine typos,
 * too slow for password-guessing attacks.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts. Please try again in 15 minutes.',
  },
  // Don't count successful requests against the limit
  skipSuccessfulRequests: true,
});

// BUG FIX (Aug 2026): keys by the logged-in user's own ID when a valid
// session cookie is present, falling back to IP only for logged-out
// requests. Previously this always keyed by raw IP — on Indian mobile
// networks (CGNAT is extremely common — see the whole IP-hardening
// discussion elsewhere in this codebase), MANY completely unrelated real
// customers/workers can share the same apparent public IP. One person's
// normal active session (placing orders, checking status, admin browsing
// several pages) could burn through the shared IP's entire budget and
// get every OTHER genuine user on that same network locked out with
// "Too many requests" — which is exactly what was happening. Keying by
// account instead ties the limit to actual usage per person, not per
// (possibly shared) network.
function rateLimitKey(req: Request): string {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (token) {
    try {
      const payload = verifyToken(token);
      return `user:${payload.userId}`;
    } catch {
      // Invalid/expired token — fall through to IP-based limiting below.
    }
  }
  return `ip:${req.ip}`;
}

/**
 * Looser limiter applied globally to all /api routes.
 * Protects against scraping / abuse without affecting normal usage.
 */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // BUG FIX: 500/15min was too low for genuine active use — a single
  // person browsing the admin panel, or a customer/worker actively
  // placing and tracking orders, easily makes this many real requests in
  // 15 minutes (dashboard stats, order lists, notifications, wallet
  // balance, etc. each fetch separately, and pages get revisited). Raised
  // to a ceiling generous enough for real heavy usage while still
  // meaningfully protecting against actual scraping/abuse.
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: {
    success: false,
    message: 'Too many requests. Please slow down and try again shortly.',
  },
});
