const required = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`\n❌ Missing required environment variable: ${key}\n   Add it to your .env file.\n`);
  }
  return value;
};

const optional = (key: string, fallback = ''): string => {
  return process.env[key] || fallback;
};

export const env = {
  PORT:     parseInt(process.env.PORT || '5000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Required — server won't start without these
  MONGODB_URI: required('MONGODB_URI'),
  JWT_SECRET:  required('JWT_SECRET'),
  JWT_EXPIRES_IN: optional('JWT_EXPIRES_IN', '7d'),

  // Optional — only needed for image uploads (profile pictures)
  CLOUDINARY_CLOUD_NAME: optional('CLOUDINARY_CLOUD_NAME'),
  CLOUDINARY_API_KEY:    optional('CLOUDINARY_API_KEY'),
  CLOUDINARY_API_SECRET: optional('CLOUDINARY_API_SECRET'),

  // Can hold multiple comma-separated origins (used for CORS in app.ts /
  // socket.ts so several live frontend domains work at once). For anything
  // that needs to build a single clickable link (payment return URLs,
  // password-reset emails), use PRIMARY_FRONTEND_URL below instead — it's
  // always just the first (main) domain in the list.
  FRONTEND_URL: optional('FRONTEND_URL', 'http://localhost:3000'),

  // NEW — Cashfree Payment Gateway (production keys).
  // Required now since payment collection is a core, always-on feature —
  // the server intentionally refuses to start without these configured,
  // the same way it refuses to start without MONGODB_URI/JWT_SECRET.
  CASHFREE_APP_ID:     required('CASHFREE_APP_ID'),
  CASHFREE_SECRET_KEY: required('CASHFREE_SECRET_KEY'),

  // NEW — our own backend's public URL, used to build the Cashfree
  // `notify_url` (webhook target). Render provides RENDER_EXTERNAL_URL
  // automatically, so this normally needs no manual configuration at all;
  // BACKEND_URL is only a manual override/fallback for other hosts.
  BACKEND_URL: optional('BACKEND_URL', optional('RENDER_EXTERNAL_URL', 'http://localhost:5000')),

  // NEW — Brevo (transactional email API), used only for forgot-password
  // emails. Switched from Gmail SMTP because Render's free tier blocks
  // outbound SMTP ports (25/465/587) as of Sept 2025 — Brevo sends over
  // HTTPS (port 443), which isn't affected.
  // Optional (not `required()`) so the server doesn't refuse to start if it's
  // missing — forgotPassword() will throw a clear error at request-time
  // instead, since email isn't as core to boot-up as DB/JWT/payment config.
  // BREVO_SENDER_EMAIL must be verified under Brevo → Senders (Single Sender
  // Verification) — NOT a full domain, just one email address you own.
  BREVO_API_KEY:      optional('BREVO_API_KEY'),
  BREVO_SENDER_EMAIL: optional('BREVO_SENDER_EMAIL'),

  // NEW — Web Push (browser/phone push notifications, even when the site
  // isn't open). VAPID keypair identifies our server to push services
  // (Google FCM for Chrome/Android, Apple's push service for Safari/iOS,
  // etc.) — same public/private-key idea as everything else here, just for
  // a different protocol. Optional so the server still boots without it;
  // pushNotification sends simply no-op (logged) if unconfigured.
  VAPID_PUBLIC_KEY:  optional('VAPID_PUBLIC_KEY'),
  VAPID_PRIVATE_KEY: optional('VAPID_PRIVATE_KEY'),
  VAPID_SUBJECT:     optional('VAPID_SUBJECT', 'mailto:admin@mailzeon.com'),

  // NEW — Abstract API (abstractapi.com) Email Reputation product. Used to
  // catch workers who accept a custom-email order, quietly go create that
  // exact account for themselves outside the platform, and just let the
  // 10-minute timer expire without ever submitting credentials — see
  // utils/emailVerification.ts. Switched from Email Awesome (their
  // infrastructure went down, never came back, support never replied).
  //
  // ABSTRACT_EMAIL_API_KEYS (preferred): comma-separated list of ANY
  // number of Abstract Email Reputation API keys (from separate Abstract
  // accounts) — the code automatically rotates between them and skips
  // any that hit their monthly 100-request quota. See the big comment
  // block at the bottom of emailVerification.ts for exactly how to add
  // more keys later.
  // ABSTRACT_API_KEY (legacy): still works on its own as a single key if
  // the multi-key var above isn't set — kept only for backward
  // compatibility, prefer the plural one for anything new.
  // Both optional: the check is silently skipped (treated as
  // inconclusive) if neither is configured, so the server still works
  // fine without it.
  ABSTRACT_EMAIL_API_KEYS: optional('ABSTRACT_EMAIL_API_KEYS'),
  ABSTRACT_API_KEY: optional('ABSTRACT_API_KEY'),

  // NEW — IP Intelligence (VPN/proxy/Tor detection), used at worker
  // registration to flag suspicious signups for admin review — see
  // utils/ipIntelligence.ts. Tried in order:
  //   1. Abstract IP Intelligence — ANY number of rotating keys via
  //      ABSTRACT_IP_API_KEYS (comma-separated), 1000 free/month each.
  //      ABSTRACT_IP_API_KEY (singular) still works alone as a legacy
  //      single-key fallback if the plural var isn't set.
  //   2. proxycheck.io (1000 free/day with a free key, 100/day without)
  //      — final fallback once every configured Abstract key is
  //      exhausted for the month
  // All optional — the check is silently skipped if none are configured,
  // exactly like the email-verification check above.
  ABSTRACT_IP_API_KEYS: optional('ABSTRACT_IP_API_KEYS'),
  ABSTRACT_IP_API_KEY: optional('ABSTRACT_IP_API_KEY'),
  PROXYCHECK_API_KEY:  optional('PROXYCHECK_API_KEY'),

  // NEW — Abstract Phone Intelligence, used to require a real (non-VOIP,
  // non-fake) phone number at registration and profile updates — see
  // utils/phoneVerification.ts. Unlike the other Abstract keys above, this
  // one is NOT optional in spirit: if not configured, phone verification
  // fails closed (see phoneVerification.ts's checkFailed behavior) and
  // nobody will be able to register or verify a phone at all.
  //
  // ABSTRACT_PHONE_API_KEYS (preferred): comma-separated list of ANY
  // number of Abstract Phone Intelligence API keys (from separate
  // Abstract accounts) — automatically rotates between them and skips any
  // that hit their monthly quota. See the big comment block at the bottom
  // of phoneVerification.ts for exactly how to add more keys later.
  // ABSTRACT_PHONE_API_KEY (legacy): still works on its own as a single
  // key if the multi-key var above isn't set — kept only for backward
  // compatibility, prefer the plural one for anything new.
  ABSTRACT_PHONE_API_KEYS: optional('ABSTRACT_PHONE_API_KEYS'),
  ABSTRACT_PHONE_API_KEY: optional('ABSTRACT_PHONE_API_KEY'),
} as const;

// The single "main" domain to use for building links (payment redirects,
// email URLs). Just the first entry of FRONTEND_URL, trailing slash removed.
export const PRIMARY_FRONTEND_URL = env.FRONTEND_URL
  .split(',')[0]
  .trim()
  .replace(/\/$/, '');
