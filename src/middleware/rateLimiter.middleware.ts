import rateLimit from 'express-rate-limit';

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

/**
 * Looser limiter applied globally to all /api routes.
 * Protects against scraping / abuse without affecting normal usage.
 */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please slow down and try again shortly.',
  },
});
