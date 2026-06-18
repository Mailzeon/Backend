import { Request, Response } from 'express';
import { authService } from '../services/auth.service';
import { sendSuccess, sendError } from '../utils/response';

export const register = async (req: Request, res: Response): Promise<void> => {
  const { name, email, password, role } = req.body;

  if (!name?.trim() || !email?.trim() || !password || !role) {
    sendError(res, 'Name, email, password, and role are required.', 400); return;
  }
  if (!['customer', 'worker'].includes(role)) {
    sendError(res, 'Role must be customer or worker.', 400); return;
  }
  if (password.length < 6) {
    sendError(res, 'Password must be at least 6 characters.', 400); return;
  }

  const result = await authService.register({ name, email, password, role });
  const message = role === 'worker'
    ? 'Account created! Your account is pending admin approval. You will be notified once approved.'
    : 'Account created successfully! Welcome to Marketplace.';

  sendSuccess(res, message, result, 201);
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;
  if (!email?.trim() || !password) {
    sendError(res, 'Email and password are required.', 400); return;
  }
  const result = await authService.login(email.trim(), password);
  sendSuccess(res, 'Logged in successfully.', result);
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  // req.user is populated by authenticate middleware
  sendSuccess(res, 'User fetched.', req.user);
};
