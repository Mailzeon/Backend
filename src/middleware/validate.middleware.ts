import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { sendError } from '../utils/response';

/**
 * Validates req.body against a Zod schema before the request reaches
 * the controller. This is also the app's primary defense against
 * NoSQL injection — Zod's z.string() rejects any non-string value,
 * so a payload like { "email": { "$gt": "" } } is rejected outright
 * instead of reaching a Mongoose query.
 *
 * On success, req.body is REPLACED with the parsed (and coerced/trimmed)
 * data so downstream code can trust its shape.
 */
export const validate = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const field       = firstIssue.path.join('.') || 'body';
      sendError(res, `${field}: ${firstIssue.message}`, 400);
      return;
    }

    req.body = result.data;
    next();
  };
};
