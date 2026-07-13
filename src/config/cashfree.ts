import { env } from './env';

/**
 * Cashfree Payment Gateway — Orders API (production).
 * Docs: https://www.cashfree.com/docs/payments/online/api-integration
 *
 * Using native `fetch` (Node 18+) instead of adding an SDK dependency —
 * keeps the request/response fully visible for debugging and signature work.
 */
export const CASHFREE_BASE_URL = 'https://api.cashfree.com/pg';
export const CASHFREE_API_VERSION = '2023-08-01';

export const cashfreeHeaders = (): Record<string, string> => ({
  'x-client-id':     env.CASHFREE_APP_ID,
  'x-client-secret': env.CASHFREE_SECRET_KEY,
  'x-api-version':   CASHFREE_API_VERSION,
  'Content-Type':    'application/json',
});
