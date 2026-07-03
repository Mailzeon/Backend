import { Router } from 'express';
import { register, login, getMe, changePassword } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authLimiter } from '../middleware/rateLimiter.middleware';
import { validate } from '../middleware/validate.middleware';
import { registerSchema, loginSchema, changePasswordSchema } from '../validators/auth.validator';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login',    authLimiter, validate(loginSchema),    login);
router.get('/me', authenticate, getMe);

// New: lets any logged-in user (including the seeded admin) change their password.
router.put('/change-password', authenticate, validate(changePasswordSchema), changePassword);

export default router;
