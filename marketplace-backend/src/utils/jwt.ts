import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { UserRole, JwtPayload } from '../types';

/**
 * Sign a new JWT for a user after login or register.
 */
export const signToken = (userId: Types.ObjectId, role: UserRole): string => {
  return jwt.sign(
    { userId: userId.toString(), role } satisfies JwtPayload,
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );
};

/**
 * Verify a JWT and return the decoded payload.
 * Throws if the token is invalid or expired.
 */
export const verifyToken = (token: string): JwtPayload => {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
};
