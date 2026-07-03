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
});

export const loginSchema = z.object({
  email: z.string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address'),
  password: z.string()
    .min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string()
    .min(6, 'New password must be at least 6 characters')
    .max(100, 'Password is too long'),
});
