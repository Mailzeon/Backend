import { Response } from 'express';

// ─── Response shape ───────────────────────────────────────────────────────────
interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
}

/**
 * Send a successful JSON response.
 * @example sendSuccess(res, 'Order created', order, 201)
 */
export const sendSuccess = <T>(
  res: Response,
  message: string,
  data?: T,
  statusCode = 200
): Response => {
  return res.status(statusCode).json({
    success: true,
    message,
    ...(data !== undefined && { data }),
  } satisfies ApiResponse<T>);
};

/**
 * Send an error JSON response.
 * @example sendError(res, 'Order not found', 404)
 */
export const sendError = (
  res: Response,
  message: string,
  statusCode = 400
): Response => {
  return res.status(statusCode).json({
    success: false,
    message,
  } satisfies ApiResponse);
};
