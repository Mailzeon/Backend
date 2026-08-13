import { z } from 'zod';

export const registerSchema = z.object({
  name: z.string()
    .trim()
    .min(2, 'Name must be at least 2 characters')
    .max(50, 'Name must be under 50 characters'),
  email: z.string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address'),
  password: z.string()
    .min(6, 'Password must be at least 6 characters')
    .max(100, 'Password is too long'),
  role: z.enum(['customer', 'worker'], {
    errorMap: () => ({ message: 'Role must be customer or worker' }),
  }),
  // NEW — mandatory for both roles (see auth.service.ts register(), which
  // verifies this is a real, non-VOIP number via Abstract Phone Validation
  // before the account is even created — see utils/phoneVerification.ts).
  phone: z.string()
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
  // Optional — invalid/unknown codes are silently ignored at the service
  // layer (see auth.service.ts register()), never rejected here.
  referralCode: z.string().trim().max(20).optional(),
  // NEW — browser fingerprint from the frontend (see lib/fingerprint.ts),
  // used alongside IP for the anti-evasion lock system (see
  // utils/ipIntelligence.ts / LockedDevice.model.ts). MUST be declared
  // here explicitly — this schema strips any key not listed, and this
  // exact codebase has been bitten by that before (acknowledgedNoPhone).
  deviceId: z.string().trim().max(200).optional(),
});

export const loginSchema = z.object({
  email: z.string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address'),
  password: z.string()
    .min(1, 'Password is required'),
  deviceId: z.string().trim().max(200).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string()
    .min(6, 'New password must be at least 6 characters')
    .max(100, 'Password is too long'),
});

export const forgotPasswordSchema = z.object({
  email: z.string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z.string()
    .min(6, 'New password must be at least 6 characters')
    .max(100, 'Password is too long'),
});
