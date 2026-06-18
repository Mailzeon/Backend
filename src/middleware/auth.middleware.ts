import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User.model';
import { verifyToken } from '../utils/jwt';
import { sendError } from '../utils/response';

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      sendError(res, 'Authentication required. Please log in.', 401);
      return;
    }

    const token   = authHeader.split(' ')[1];
    const decoded = verifyToken(token);

    // Fetch user WITHOUT password — password is never needed after login
    const user = await User.findById(decoded.userId);
    if (!user) {
      sendError(res, 'User no longer exists.', 401);
      return;
    }

    req.user = user;
    next();
  } catch {
    sendError(res, 'Invalid or expired token. Please log in again.', 401);
  }
};
