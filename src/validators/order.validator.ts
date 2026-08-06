import { z } from 'zod';

// Must match the frontend's lib/emailDomains.ts EMAIL_DOMAINS list exactly.
export const EMAIL_DOMAINS = [
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
  'protonmail.com', 'aol.com', 'zoho.com', 'yandex.com', 'gmx.com',
  'live.com', 'mail.com',
] as const;

// REWORKED for custom customer pricing + Cashfree phone requirement.
// `amount`: Zod only enforces a bare sanity floor of ₹1 here (must be a
//   positive amount) — it must NOT hardcode the real business minimum,
//   because that lives in the admin-configurable minimumOrderAmount setting,
//   which can be set to ANY value (including below ₹15). The actual minimum
//   is enforced dynamically in order.service.ts against the live setting.
//   (Previously this was `.min(15, ...)`, which silently overrode admin's
//   setting whenever they lowered it below ₹15 — always rejecting with the
//   Zod message before the service's live check ever ran.)
// `phone`: optional here because if the customer already has a phone saved
//   on their profile, the frontend won't send one — order.service.ts handles
//   requiring it only when there's no saved phone to fall back on.
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
  customLocalPart: z.string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/, 'Use only letters, numbers, dots, underscores or hyphens')
    .optional(),
  amount: z.coerce.number({ invalid_type_error: 'Amount must be a number' })
    .min(1, 'Amount must be at least ₹1')
    .max(100000, 'For orders above ₹1,00,000 please contact support'),
  phone: z.string()
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number')
    .optional(),
  // NEW: customer opts in to pay with their Mailzeon wallet credit (from a
  // previous refund) instead of Cashfree. Only applied if the balance
  // fully covers the order amount — see order.service.ts createOrder().
  useWalletCredit: z.boolean().optional(),
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

export const submitNumberSchema = z.object({
  number: z.string()
    .trim()
    .min(1, 'Verification number is required')
    .max(5, 'That doesn\'t look like a valid verification number')
    .regex(/^\d+$/, 'Verification number should contain digits only'),
});

export const reportProblemSchema = z.object({
  reason: z.enum(['wrong_password', 'unable_to_login', 'account_issue', 'other'])
    .default('other'),
  description: z.string()
    .trim()
    .max(500, 'Description must be under 500 characters')
    .optional(),
});
