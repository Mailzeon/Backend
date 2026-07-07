import { z } from 'zod';

// Must match the frontend's lib/emailDomains.ts EMAIL_DOMAINS list exactly.
export const EMAIL_DOMAINS = [
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
  'protonmail.com', 'aol.com', 'zoho.com', 'yandex.com', 'gmx.com',
  'live.com', 'mail.com',
] as const;

export const createOrderSchema = z.object({
  serviceName: z.string()
    .trim()
    .min(3, 'Service name must be at least 3 characters')
    .max(200, 'Service name must be under 200 characters'),
  domain: z.enum(EMAIL_DOMAINS, {
    errorMap: () => ({ message: 'Select a valid email domain' }),
  }),
  emailType: z.enum(['random', 'custom'], {
    errorMap: () => ({ message: 'Choose random or custom email' }),
  }),
  // Only required when emailType === 'custom' — enforced by .refine() below.
  customLocalPart: z.string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/, 'Use only letters, numbers, dots, underscores or hyphens')
    .optional(),
}).refine(
  (data) => data.emailType !== 'custom' || (!!data.customLocalPart && data.customLocalPart.length > 0),
  { message: 'Enter your custom email name', path: ['customLocalPart'] }
);

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
