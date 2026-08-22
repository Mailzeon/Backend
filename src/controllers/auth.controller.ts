import { Request, Response } from 'express';
import { authService } from '../services/auth.service';
import { sendSuccess } from '../utils/response';
import { setAuthCookie, clearAuthCookie } from '../utils/cookies';

// Manual validation checks below are now redundant for well-formed requests
// since the `validate(schema)` middleware runs first and guarantees shape —
// kept minimal here as the controller no longer needs to re-check them.

export const register = async (req: Request, res: Response): Promise<void> => {
  const { name, email, password, role, phone, referralCode, deviceId } = req.body;

  const { user, token } = await authService.register(
    { name, email, password, role, phone, referralCode, deviceId },
    req.ip,
    req.headers['user-agent']
  );
  setAuthCookie(res, token);

  const message = role === 'worker'
    ? 'Account created! Your account is pending admin approval. You will be notified once approved.'
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
  const { email, password, deviceId } = req.body;
  const { user, token } = await authService.login(email, password, req.ip, deviceId, req.headers['user-agent']);
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
    initData, role, referralCode, req.ip, req.body.deviceId, req.headers['user-agent']
  );
  setAuthCookie(res, token);
  sendSuccess(res, 'Logged in via Telegram.', { user, token });
};
