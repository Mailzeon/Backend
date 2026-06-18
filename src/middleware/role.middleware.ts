import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../types';
import { sendError } from '../utils/response';

/**
 * requireRole(...roles)
 * Use after `authenticate`. Allows only users whose role is in the list.
 *
 * @example
 * router.get('/admin/stats', authenticate, requireRole('admin'), handler)
 * router.get('/wallet',      authenticate, requireRole('worker'), handler)
 */
export const requireRole = (...roles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, 'Authentication required.', 401);
      return;
    }

    if (!roles.includes(req.user.role as UserRole)) {
      sendError(res, 'You do not have permission to access this resource.', 403);
      return;
    }

    next();
  };
};

/**
 * requireApprovedWorker
 * Extra guard for worker-only routes that require admin approval.
 * Workers can log in and view their dashboard, but cannot accept orders
 * until an admin sets isApproved = true on their account.
 *
 * @example
 * router.patch('/orders/:id/accept', authenticate, requireApprovedWorker, handler)
 */
export const requireApprovedWorker = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    sendError(res, 'Authentication required.', 401);
    return;
  }

  if (req.user.role !== 'worker') {
    sendError(res, 'Only workers can access this resource.', 403);
    return;
  }

  if (!req.user.isApproved) {
    sendError(
      res,
      'Your account is pending admin approval. You will receive a notification once approved.',
      403
    );
    return;
  }

  next();
};
