import { Router, Request, Response } from 'express';
import { getPublicSettings } from '../services/order.service';
import { sendSuccess } from '../utils/response';

const router = Router();

// Public — intentionally NOT behind `authenticate`. The register page (before
// login) and every dashboard need to show the real, current order price and
// worker earning instead of a hardcoded number that goes stale the moment
// admin changes it from the Settings page. Neither value is sensitive.
router.get('/public', async (_req: Request, res: Response) => {
  const settings = await getPublicSettings();
  sendSuccess(res, 'Public settings fetched.', settings);
});

export default router;
