import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole, requireApprovedWorker } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createOrderSchema, createBulkOrderSchema, submitCredentialsSchema, resubmitCredentialsSchema, checkEmailSchema,
  submitNumberSchema, submitCodeSchema, reportProblemSchema,
} from '../validators/order.validator';
import {
  createOrder, createBulkOrder, cancelOrder, getMarketplace, acceptOrder, submitCredentials, resubmitCredentials,
  submitVerificationNumber, confirmVerificationNumber,
  requestVerificationCode, submitVerificationCode,
  confirmSuccess, reportProblem, getOrder, getMyOrders, getAssignedOrders,
  checkEmail,
} from '../controllers/order.controller';

const router = Router();
router.use(authenticate);

// Customer routes
// NOTE: /check-email must be registered BEFORE '/:id' below — otherwise
// Express would match it as { id: 'check-email' } on the GET /:id route.
// It's a POST here so there's no clash either way, but keeping it grouped
// with the other customer routes for readability.
router.post('/check-email',           requireRole('customer'), validate(checkEmailSchema), checkEmail);
router.post('/',                      requireRole('customer'), validate(createOrderSchema), createOrder);
router.post('/bulk',                  requireRole('customer'), validate(createBulkOrderSchema), createBulkOrder);
router.get('/my',                     requireRole('customer'), getMyOrders);
router.patch('/:id/cancel',           requireRole('customer'), cancelOrder);
router.patch('/:id/submit-number',    requireRole('customer'), validate(submitNumberSchema), submitVerificationNumber);
router.patch('/:id/request-code',     requireRole('customer'), requestVerificationCode);
router.patch('/:id/confirm',          requireRole('customer'), confirmSuccess);
router.patch('/:id/dispute',          requireRole('customer'), validate(reportProblemSchema), reportProblem);

// Worker routes (approved workers only for action routes)
router.get('/marketplace',            requireRole('worker'), getMarketplace);
router.get('/assigned',               requireRole('worker'), getAssignedOrders);
router.patch('/:id/accept',           requireApprovedWorker, acceptOrder);
router.patch('/:id/credentials',      requireApprovedWorker, validate(submitCredentialsSchema), submitCredentials);
router.patch('/:id/resubmit-credentials', requireApprovedWorker, validate(resubmitCredentialsSchema), resubmitCredentials);
router.patch('/:id/confirm-number',   requireApprovedWorker, confirmVerificationNumber);
router.patch('/:id/submit-code',      requireApprovedWorker, validate(submitCodeSchema), submitVerificationCode);

// Shared
router.get('/:id',                    requireRole('customer','worker','admin'), getOrder);

export default router;
