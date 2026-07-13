import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { verifyPayment } from '../controllers/payment.controller';

const router = Router();

// Only the GET verify-on-return endpoint lives here — the POST webhook is
// mounted separately and earlier in app.ts (before the global JSON body
// parser) since it needs the raw request body for signature verification.
router.get('/verify/:orderId', authenticate, requireRole('customer'), verifyPayment);

export default router;
