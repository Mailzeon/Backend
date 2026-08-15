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

  // NOTE: the raw token is no longer included in the response body — it now
  // lives only in the httpOnly cookie set above, which client-side
  // JavaScript can't read. Only the non-sensitive user object goes to the
  // frontend, which is all authStore.setAuth() needs.
  sendSuccess(res, message, { user }, 201);
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const { email, password, deviceId } = req.body;
  const { user, token } = await authService.login(email, password, req.ip, deviceId, req.headers['user-agent']);
  setAuthCookie(res, token);
  sendSuccess(res, 'Logged in successfully.', { user });
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
