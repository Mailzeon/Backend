import { Request, Response, NextFunction } from 'express';

interface AppError extends Error {
  statusCode?: number;
  code?:       number;
  name:        string;
  path?:       string;
  value?:      string;
}

export const errorMiddleware = (
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  let message    = err.message || 'Internal server error';
  let statusCode = err.statusCode || 500;

  // Mongoose: Duplicate key (e.g. duplicate email)
  if (err.code === 11000) {
    message    = 'A record with this information already exists.';
    statusCode = 409;
  }

  // Mongoose: Validation error
  if (err.name === 'ValidationError') {
    statusCode = 400;
  }

  // Mongoose: Invalid ObjectId in URL (e.g. /orders/not-a-valid-id)
  if (err.name === 'CastError') {
    message    = `Invalid ID format.`;
    statusCode = 400;
  }

  // JWT: Invalid token signature
  if (err.name === 'JsonWebTokenError') {
    message    = 'Invalid token. Please log in again.';
    statusCode = 401;
  }

  // JWT: Token expired
  if (err.name === 'TokenExpiredError') {
    message    = 'Your session has expired. Please log in again.';
    statusCode = 401;
  }

  // Log in development only
  if (process.env.NODE_ENV === 'development') {
    console.error(`[Error] ${statusCode}:`, err.message);
    console.error(err.stack);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
