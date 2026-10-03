import { Request, Response } from 'express';
import { authService } from '../services/auth.service';
import { sendSuccess } from '../utils/response';
import { setAuthCookie, clearAuthCookie } from '../utils/cookies';
import { getIpCountryCode } from '../utils/ipIntelligence';
import { getCallingCodeForCountry } from '../utils/callingCodes';

// Manual validation checks below are now redundant for well-formed requests
// since the `validate(schema)` middleware runs first and guarantees shape —
// kept minimal here as the controller no longer needs to re-check them.

export const register = async (req: Request, res: Response): Promise<void> => {
  const { name, email, password, role, phone, referralCode, deviceId, deviceModelHint } = req.body;

  const { user, token } = await authService.register(
    { name, email, password, role, phone, referralCode, deviceId, deviceModelHint },
    req.ip,
    req.headers['user-agent']
  );
  setAuthCookie(res, token);

  const message = role === 'worker'
    ? (user.isApproved
        ? 'Account created! You are approved and can start accepting orders right away.'
        : 'Account created! Your account is temporarily held due to a shared device/network restriction — it will be approved automatically once that clears. You will be notified.')
    : 'Account created successfully! Welcome to Marketplace.';

  // BUG FIX (Aug 2026): the token WAS deliberately left out of the response
  // body when this migrated to httpOnly cookies — correct call at the time
  // to close the XSS-token-theft door that plain localStorage storage left
  // open. But it turned out to have a real, currently-live cost: Safari,
  // Firefox, and Brave all block third-party cookies BY DEFAULT (this cookie
  // is cross-site from the browser's point of view, since the frontend on
  // Vercel and this API on Render are different domains) — so on those
  // browsers the Set-Cookie above silently never gets stored at all. The
  // person sees "account created"/"logged in", the frontend optimistically
  // shows them as authenticated, and then the very next API call 401s and
  // bounces them straight back to the login page — which is exactly what
  // gets reported as "login/register isn't working."
  //
  // The token is now ALSO returned here so the frontend can hold it as a
  // Bearer-header fallback (see lib/authToken.ts / lib/api.ts on the
  // frontend) for exactly those browsers, on top of the cookie (which still
  // works fine everywhere else and remains the primary mechanism). This is
  // a smaller exposure than the original localStorage design it's not
  // reverting to: see lib/authToken.ts for exactly what's different and why
  // that's an acceptable tradeoff.
  sendSuccess(res, message, { user, token }, 201);
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const { email, password, deviceId, deviceModelHint } = req.body;
  const { user, token } = await authService.login(email, password, req.ip, deviceId, req.headers['user-agent'], deviceModelHint);
  setAuthCookie(res, token);
  // See the comment on register() above for why this is back in the body.
  sendSuccess(res, 'Logged in successfully.', { user, token });
};

// New: clears the httpOnly session cookie. Doesn't require `authenticate` —
// if the cookie is already missing/expired/invalid, clearing it again is a
// harmless no-op, and gating this behind auth would just mean a stale
// client can never successfully log itself out.
export const logout = async (_req: Request, res: Response): Promise<void> => {
  clearAuthCookie(res);
  sendSuccess(res, 'Logged out successfully.');
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  // req.user is populated by authenticate middleware
  sendSuccess(res, 'User fetched.', req.user);
};

// New: change password for the currently logged-in user.
// Useful for the seeded admin account (admin@marketplace.com) to rotate
// away from the default password after first login.
export const changePassword = async (req: Request, res: Response): Promise<void> => {
  const { currentPassword, newPassword } = req.body;
  await authService.changePassword(req.user!._id.toString(), currentPassword, newPassword);
  sendSuccess(res, 'Password changed successfully.');
};

// New: request a reset link. Always returns the same success message whether
// or not the email exists on the platform — auth.service handles that silently.
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  await authService.forgotPassword(email);
  sendSuccess(res, 'If an account exists for that email, a reset link has been sent.');
};

// New: consumes the token from the emailed link and sets a new password.
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  const { token, newPassword } = req.body;
  await authService.resetPassword(token, newPassword);
  sendSuccess(res, 'Password reset successfully. You can now log in.');
};

// ── Telegram Mini App ──────────────────────────────────────────────────────
// See services/auth.service.ts checkTelegramUser()/telegramLogin() and
// utils/telegramAuth.ts for the actual verification. Same "token also in
// the body" pattern as register()/login() above, for the same reason —
// see the comment there.
export const telegramCheckUser = async (req: Request, res: Response): Promise<void> => {
  const { initData } = req.body;
  const result = await authService.checkTelegramUser(initData);
  sendSuccess(res, 'Telegram user checked.', result);
};

export const telegramLogin = async (req: Request, res: Response): Promise<void> => {
  const { initData, role, referralCode } = req.body;
  const { user, token } = await authService.telegramLogin(
    initData, role, referralCode, req.ip, req.body.deviceId, req.headers['user-agent'], req.body.deviceModelHint
  );
  // BUG FIX (Aug 2026): deliberately NOT calling setAuthCookie() here.
  // Telegram's in-app WebView can share cookie storage with the phone's
  // regular browser on some Android setups — if this set the SAME
  // cross-domain session cookie the normal website login uses, logging in
  // on one would silently overwrite the other's session, logging them out
  // unexpectedly. Telegram logins run ENTIRELY on the Bearer-token/
  // sessionStorage fallback instead (see lib/authToken.ts / lib/api.ts on
  // the frontend, and auth.middleware.ts's header-fallback check on this
  // side) — sessionStorage is isolated per browsing context regardless of
  // any cookie-sharing quirk, so a Telegram session and a website session
  // for the same account can never step on each other.
  sendSuccess(res, 'Logged in via Telegram.', { user, token });
};

export const telegramLink = async (req: Request, res: Response): Promise<void> => {
  const { initData, email, password } = req.body;
  const { user, token } = await authService.linkTelegramAccount(
    initData, email, password, req.ip, req.body.deviceId, req.headers['user-agent'], req.body.deviceModelHint
  );
  // Same reasoning as telegramLogin() above — no cookie, Bearer-token only.
  sendSuccess(res, 'Your Telegram account is now linked.', { user, token });
};

// ── Public: which "+NN" badge should the phone field show? ───────────────
// Called by the register/profile pages on load (logged-out visitors too, so
// NO auth). Looks up the visitor's IP country and maps it to a calling code.
//
// Falls back to India (+91, the original Indian-only behavior) whenever the
// lookup fails, the IP is private/local, or the country isn't in
// utils/callingCodes.ts — so this can never break registration, only decide
// what the badge says. The server re-checks IP vs number at submit time
// regardless; this endpoint is display-only and grants nothing.
//
// Abstract's free tier is tiny, so results are cached per IP in memory
// (1h for a real answer, 10min for a failed lookup so an exhausted quota
// isn't hammered by every page load).
const DETECT_CACHE_MAX = 5000;
const detectCache = new Map<string, { value: { countryCode: string | null; callingCode: string }; expires: number }>();

export const detectCountryCode = async (req: Request, res: Response): Promise<void> => {
  const ip = req.ip;
  const fallback = { countryCode: null as string | null, callingCode: '91' };

  if (!ip || /^(::1|127\.|10\.|192\.168\.|::ffff:127\.)/.test(ip)) {
    sendSuccess(res, 'Detected.', fallback);
    return;
  }

  const hit = detectCache.get(ip);
  if (hit && hit.expires > Date.now()) {
    sendSuccess(res, 'Detected.', hit.value);
    return;
  }

  const iso = await getIpCountryCode(ip);
  const callingCode = getCallingCodeForCountry(iso);
  const value = callingCode ? { countryCode: iso, callingCode } : { countryCode: iso, callingCode: '91' };

  if (detectCache.size >= DETECT_CACHE_MAX) detectCache.clear();
  detectCache.set(ip, { value, expires: Date.now() + (iso ? 60 : 10) * 60 * 1000 });

  sendSuccess(res, 'Detected.', value);
};
