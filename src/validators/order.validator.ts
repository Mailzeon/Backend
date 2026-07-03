import { z } from 'zod';

export const createOrderSchema = z.object({
  serviceName: z.string()
    .trim()
    .min(3, 'Service name must be at least 3 characters')
    .max(200, 'Service name must be under 200 characters'),
});

export const submitCredentialsSchema = z.object({
  // These represent third-party account credentials, not the platform's
  // own login — so we keep them as plain non-empty strings, not z.string().email().
  email: z.string()
    .trim()
    .min(1, 'Email / username is required')
    .max(200, 'Value is too long'),
  password: z.string()
    .trim()
    .min(1, 'Password is required')
    .max(200, 'Password is too long'),
  notes: z.string()
    .trim()
    .max(1000, 'Notes must be under 1000 characters')
    .optional(),
});

export const submitCodeSchema = z.object({
  code: z.string()
    .trim()
    .min(1, 'Verification code is required')
    .max(20, 'Verification code is too long'),
});

export const reportProblemSchema = z.object({
  reason: z.enum(['wrong_password', 'unable_to_login', 'account_issue', 'other'])
    .default('other'),
  description: z.string()
    .trim()
    .max(500, 'Description must be under 500 characters')
    .optional(),
});
