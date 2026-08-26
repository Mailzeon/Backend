import { z } from 'zod';

// Must match the frontend's lib/emailDomains.ts EMAIL_DOMAINS list exactly.
export const EMAIL_DOMAINS = [
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
  'protonmail.com', 'aol.com', 'zoho.com', 'yandex.com', 'gmx.com',
  'live.com', 'mail.com',
] as const;

// REWORKED for custom customer pricing + wallet-credit split payment.
// `amount`: Zod only enforces a bare sanity floor of ₹1 here (must be a
//   positive amount) — it must NOT hardcode the real business minimum,
//   because that lives in the admin-configurable minimumOrderAmount setting,
//   which can be set to ANY value (including below ₹15). The actual minimum
//   is enforced dynamically in order.service.ts against the live setting.
//   (Previously this was `.min(15, ...)`, which silently overrode admin's
//   setting whenever they lowered it below ₹15 — always rejecting with the
//   Zod message before the service's live check ever ran.)
// `phone`: REMOVED — phone is now mandatory + verified at registration/
//   profile level (see auth.validator.ts / user.routes.ts PUT /profile),
//   so order.service.ts createOrder() just reads it off the customer's
//   profile directly instead of collecting it here.
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
  // NEW: customer opts in to pay with their Mailzeon wallet credit (from a
  // previous refund) instead of Cashfree. Only applied if the balance
  // fully covers the order amount — see order.service.ts createOrder().
  useWalletCredit: z.boolean().optional(),
}).refine(
  (data) => data.emailType !== 'custom' || (!!data.customLocalPart && data.customLocalPart.length > 0),
  { message: 'Enter your custom email name', path: ['customLocalPart'] }
);

// ── Bulk ordering ────────────────────────────────────────────────────────
// One payment, N individually-marketplace-visible orders — see
// order.service.ts createBulkOrder() / models/OrderBatch.model.ts. `amount`
// here is PER order (same shared price across the whole batch), not the
// total — the real minimum-amount check against the live setting still
// happens in the service layer, same reasoning as createOrderSchema above.
// `quantity`'s upper bound is a defensive Zod-level sanity cap only — the
// REAL, admin-adjustable ceiling (maxBulkOrderQuantity) is enforced live in
// the service layer, exactly like minimumOrderAmount is for amount.
export const createBulkOrderSchema = z.object({
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
  amount: z.coerce.number({ invalid_type_error: 'Amount must be a number' })
    .min(1, 'Amount must be at least ₹1')
    .max(100000, 'For orders above ₹1,00,000 per account please contact support'),
  quantity: z.coerce.number({ invalid_type_error: 'Quantity must be a number' })
    .int('Quantity must be a whole number')
    .min(2, 'Bulk orders need at least 2 accounts — for just one, use the regular order form')
    .max(200, 'That\'s too many for one batch — please contact support for very large orders'),
  // Required (and length-checked against quantity) only when emailType is
  // 'custom' — one local-part per account, e.g. ["shopfront1", "shopfront2"].
  // Each becomes its own separate order requesting that exact address.
  customLocalParts: z.array(
    z.string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/, 'Use only letters, numbers, dots, underscores or hyphens')
  ).optional(),
  useWalletCredit: z.boolean().optional(),
}).refine(
  (data) => data.emailType !== 'custom' || (data.customLocalParts && data.customLocalParts.length === data.quantity),
  { message: 'Enter one custom email name per account', path: ['customLocalParts'] }
);

// NEW: pre-payment availability check — customer picks a domain + custom
// name and hits "Check" BEFORE the amount/pay step. Same shape as the
// custom-email half of createOrderSchema above, just without the rest of
// the order fields.
export const checkEmailSchema = z.object({
  domain: z.enum(EMAIL_DOMAINS, {
    errorMap: () => ({ message: 'Select a valid email domain' }),
  }),
  customLocalPart: z.string()
    .trim()
    .toLowerCase()
    .min(1, 'Enter a name to check')
    .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/, 'Use only letters, numbers, dots, underscores or hyphens'),
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
  // BUG FIX: this field was missing from the schema entirely. The
  // validate() middleware REPLACES req.body with the parsed result, so any
  // key not listed here gets silently stripped before the controller ever
  // sees it — the checkbox was working perfectly on the frontend, but the
  // backend always received `undefined` regardless, causing the false
  // "you must confirm..." rejection even when checked.
  acknowledgedNoPhone: z.literal(true, {
    errorMap: () => ({ message: 'You must confirm this account has no phone number linked.' }),
  }),
});

// Grace-window resubmission after a "wrong password" dispute — see
// order.service.ts resubmitCredentials(). Same shape minus
// acknowledgedNoPhone: this is a correction to an already-submitted order,
// not a first submission, so re-asking that specific checkbox again isn't
// meaningful here.
export const resubmitCredentialsSchema = z.object({
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

export const submitCodeSchema = z.object({
  code: z.string()
    .trim()
    .min(1, 'Verification code is required')
    .max(20, 'Verification code is too long'),
});

export const reportProblemSchema = z.object({
  // BUG FIX (Aug 2026): 'account_not_found' was added to the Dispute
  // model, DisputeReason type, and the frontend's dropdown — but never
  // added here. Zod's enum rejects anything not explicitly listed, so
  // every customer selecting "Account doesn't exist / couldn't find it"
  // got a hard 400 error and their dispute was silently never created.
  reason: z.enum(['wrong_password', 'account_not_found', 'unable_to_login', 'account_issue', 'other'])
    .default('other'),
  description: z.string()
    .trim()
    .max(500, 'Description must be under 500 characters')
    .optional(),
});
