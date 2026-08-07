import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User.model';
import { verifyToken } from '../utils/jwt';
import { sendError } from '../utils/response';
import { AUTH_COOKIE_NAME } from '../utils/cookies';

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Primary: httpOnly cookie set by setAuthCookie() on login/register —
    // JavaScript (and therefore any XSS payload) can never read this.
    // Fallback: Authorization header — kept only for resilience (e.g. a
    // non-browser API client); nothing in this codebase sends it anymore
    // after the httpOnly cookie migration, so this path is normally unused.
    const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
    const authHeader  = req.headers.authorization;
    const headerToken  = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;
    const token = cookieToken || headerToken;

    if (!token) {
      sendError(res, 'Authentication required. Please log in.', 401);
      return;
    }

    const decoded = verifyToken(token);

    // Fetch user WITHOUT password — password is never needed after login
    const user = await User.findById(decoded.userId);
    if (!user) {
      sendError(res, 'User no longer exists.', 401);
      return;
    }
    if (user.isDeleted) {
      sendError(res, 'This account has been deleted.', 401);
      return;
    }

    req.user = user;
    next();
  } catch {
    sendError(res, 'Invalid or expired token. Please log in again.', 401);
  }
};
