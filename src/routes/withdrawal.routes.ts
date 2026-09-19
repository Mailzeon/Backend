import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { upload } from '../middleware/upload.middleware';
import { cloudinary } from '../config/cloudinary';
import { withdrawalService } from '../services/withdrawal.service';
import { sendSuccess, sendError } from '../utils/response';
import { Request, Response } from 'express';
import { UploadApiResponse } from 'cloudinary';

const router = Router();
router.use(authenticate);

// Worker: create withdrawal request
router.post('/', requireRole('worker'), async (req: Request, res: Response) => {
  const { amount, paymentMethod, upiId, upiQrCode, upiVerifiedName, bankDetails } = req.body;
  if (!amount || !paymentMethod) { sendError(res, 'Amount and payment method required.', 400); return; }
  const wr = await withdrawalService.create(req.user!._id.toString(), {
    amount: Number(amount), paymentMethod, upiId, upiQrCode, upiVerifiedName, bankDetails,
  });
  sendSuccess(res, 'Withdrawal request submitted. Will be processed within 24 hours.', wr, 201);
});

// Worker: upload their UPI QR code screenshot — a separate upload step
// (same memory-buffer-straight-to-Cloudinary pattern as
// user.controller.ts's profile-image upload) so the frontend can show an
// upload progress state and get back a URL to include in the actual
// POST / above. Not tied to a fixed per-worker path (unlike the profile
// image, which overwrites) — each request's QR is kept as its own
// Cloudinary asset, so admin can always see exactly what QR a PAST
// request was submitted with even if the worker's UPI details change
// later for a future request.
router.post('/upload-qr', requireRole('worker'), upload.single('image'), async (req: Request, res: Response) => {
  if (!req.file) { sendError(res, 'No image file provided.', 400); return; }

  const result = await new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { public_id: `withdrawal-qr/${req.user!._id.toString()}-${Date.now()}`, folder: 'mailzeon' },
      (error, uploadResult) => {
        if (error || !uploadResult) return reject(error ?? new Error('Image upload failed.'));
        resolve(uploadResult);
      }
    );
    stream.end(req.file!.buffer);
  });

  sendSuccess(res, 'QR code uploaded.', { url: result.secure_url });
});

// Worker: my requests
router.get('/my', requireRole('worker'), async (req: Request, res: Response) => {
  const reqs = await withdrawalService.getMyRequests(req.user!._id.toString());
  sendSuccess(res, 'Withdrawal requests fetched.', reqs);
});

export default router;
