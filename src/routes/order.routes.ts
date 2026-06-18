import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole, requireApprovedWorker } from '../middleware/role.middleware';
import {
  createOrder, getMarketplace, acceptOrder, submitCredentials,
  requestVerificationCode, submitVerificationCode, requestNewCode,
  confirmSuccess, reportProblem, getOrder, getMyOrders, getAssignedOrders,
} from '../controllers/order.controller';

const router = Router();
router.use(authenticate);

// Customer routes
router.post('/',                            requireRole('customer'), createOrder);
router.get('/my',                           requireRole('customer'), getMyOrders);
router.patch('/:id/request-code',           requireRole('customer'), requestVerificationCode);
router.patch('/:id/request-new-code',       requireRole('customer'), requestNewCode);
router.patch('/:id/confirm',                requireRole('customer'), confirmSuccess);
router.patch('/:id/dispute',                requireRole('customer'), reportProblem);

// Worker routes (approved workers only for action routes)
router.get('/marketplace',                  requireRole('worker'), getMarketplace);
router.get('/assigned',                     requireRole('worker'), getAssignedOrders);
router.patch('/:id/accept',                 requireApprovedWorker, acceptOrder);
router.patch('/:id/credentials',            requireApprovedWorker, submitCredentials);
router.patch('/:id/submit-code',            requireApprovedWorker, submitVerificationCode);

// Shared
router.get('/:id',                          requireRole('customer','worker','admin'), getOrder);

export default router;
