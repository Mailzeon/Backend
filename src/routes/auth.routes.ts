import { Router } from 'express';
import {
  register, login, logout, getMe, changePassword, forgotPassword, resetPassword,
  telegramCheckUser, telegramLogin, telegramLink,
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authLimiter } from '../middleware/rateLimiter.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  registerSchema, loginSchema, changePasswordSchema,
  forgotPasswordSchema, resetPasswordSchema,
  telegramCheckSchema, telegramLoginSchema, telegramLinkSchema,
} from '../validators/auth.validator';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login',    authLimiter, validate(loginSchema),    login);
// New: clears the httpOnly session cookie. No auth middleware needed — see
// controller comment for why.
router.post('/logout', logout);
router.get('/me', authenticate, getMe);

// New: lets any logged-in user (including the seeded admin) change their password.
router.put('/change-password', authenticate, validate(changePasswordSchema), changePassword);

// New: forgot/reset password flow — both rate-limited with the same strict
// authLimiter used for login/register, since both are unauthenticated
// endpoints that could otherwise be abused (email-bombing / token brute-force).
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password',  authLimiter, validate(resetPasswordSchema),  resetPassword);

// Telegram Mini App — rate-limited same as register/login, since both are
// unauthenticated entry points. /telegram/check is called first by the
// frontend to decide whether to show a role picker (brand-new user) or
// skip straight to login (returning user) — see app/telegram/page.tsx.
router.post('/telegram/check', authLimiter, validate(telegramCheckSchema), telegramCheckUser);
router.post('/telegram',       authLimiter, validate(telegramLoginSchema), telegramLogin);
router.post('/telegram/link',  authLimiter, validate(telegramLinkSchema),  telegramLink);

export default router;
