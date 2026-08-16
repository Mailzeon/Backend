import rateLimit from 'express-rate-limit';

/**
 * Strict limiter for auth endpoints (login, register, forgot/reset
 * password). 8 attempts per 15 minutes per IP — enough for genuine typos,
 * too slow for password-guessing attacks. This is the ONLY rate limiter
 * left in the app — the broader /api-wide one (globalLimiter) was removed
 * (Aug 2026) after it kept blocking genuine customers/workers/admin with
 * "Too many requests" during completely normal usage, especially on
 * shared/CGNAT IPs common on Indian mobile networks.
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
