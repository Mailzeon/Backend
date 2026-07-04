import { z } from 'zod';

export const updateSettingSchema = z.object({
  value: z.string()
    .trim()
    .min(1, 'Value is required')
    .max(50, 'Value is too long'),
});
