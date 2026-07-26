import { Router } from 'express';
import {
  register, login, getMe, changePassword, forgotPassword, resetPassword,
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authLimiter } from '../middleware/rateLimiter.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  registerSchema, loginSchema, changePasswordSchema,
  forgotPasswordSchema, resetPasswordSchema,
} from '../validators/auth.validator';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login',    authLimiter, validate(loginSchema),    login);
router.get('/me', authenticate, getMe);

// New: lets any logged-in user (including the seeded admin) change their password.
router.put('/change-password', authenticate, validate(changePasswordSchema), changePassword);

// New: forgot/reset password flow — both rate-limited with the same strict
// authLimiter used for login/register, since both are unauthenticated
// endpoints that could otherwise be abused (email-bombing / token brute-force).
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password',  authLimiter, validate(resetPasswordSchema),  resetPassword);

export default router;
