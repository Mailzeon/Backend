import { z } from 'zod';

export const createRefundSchema = z.object({
  orderId: z.string().min(1, 'Order ID is required'),
  upiId: z.string()
    .trim()
    .min(3, 'UPI ID is required')
    .max(100, 'UPI ID is too long')
    .regex(/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/, 'Enter a valid UPI ID (e.g. yourname@okhdfcbank)'),
});
