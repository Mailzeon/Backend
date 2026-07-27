import { Response } from 'express';
import { env } from '../config/env';

// Name is unchanged from the old (non-httpOnly) mirror cookie the frontend
// used to set for middleware.ts route-gating — but this one now carries the
// REAL session token and is httpOnly, so client-side JavaScript (and any
// XSS payload) can never read or exfiltrate it. See auth.middleware.ts for
// where this is read back.
export const AUTH_COOKIE_NAME = 'mp_session';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Frontend (Vercel) and backend (Render) are on completely different
// domains — not subdomains of a shared parent — so this is a genuine
// cross-site cookie. Browsers require SameSite=None + Secure for a cookie
// to be sent on cross-origin requests at all; Secure requires HTTPS, which
// is why this is only enabled in production. In local dev (both on
// http://localhost, same-site relative to each other) SameSite=Lax over
// plain HTTP works fine and needs no Secure flag.
const isProd = env.NODE_ENV === 'production';

/**
 * Sets the httpOnly session cookie after a successful login/register.
 * Call this instead of returning the raw JWT in the response body.
 */
export const setAuthCookie = (res: Response, token: string): void => {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure:   isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge:   SEVEN_DAYS_MS,
    path:     '/',
  });
};

/**
 * Clears the session cookie on logout. The options (except maxAge/expiry)
 * MUST match what was used to set it, or the browser won't recognize it as
 * the same cookie and won't clear it.
 */
export const clearAuthCookie = (res: Response): void => {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure:   isProd,
    sameSite: isProd ? 'none' : 'lax',
    path:     '/',
  });
};
