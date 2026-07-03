import { Request, Response } from 'express';
import { authService } from '../services/auth.service';
import { sendSuccess } from '../utils/response';

// Manual validation checks below are now redundant for well-formed requests
// since the `validate(schema)` middleware runs first and guarantees shape —
// kept minimal here as the controller no longer needs to re-check them.

export const register = async (req: Request, res: Response): Promise<void> => {
  const { name, email, password, role } = req.body;

  const result = await authService.register({ name, email, password, role });
  const message = role === 'worker'
    ? 'Account created! Your account is pending admin approval. You will be notified once approved.'
    : 'Account created successfully! Welcome to Marketplace.';

  sendSuccess(res, message, result, 201);
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;
  const result = await authService.login(email, password);
  sendSuccess(res, 'Logged in successfully.', result);
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
