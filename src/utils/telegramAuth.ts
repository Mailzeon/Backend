import crypto from 'crypto';
import { env } from '../config/env';

// Telegram's documented verification algorithm for Mini App initData:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
//   secret_key        = HMAC_SHA256(bot_token, key="WebAppData")
//   data_check_string = every field EXCEPT hash, sorted alphabetically by
//                        key, joined as "key=value" lines with \n
//   expected_hash      = HMAC_SHA256(data_check_string, key=secret_key), hex
//
// If expected_hash matches the hash Telegram sent, the payload is
// guaranteed to have come from Telegram and not be tampered with — this
// is the ONLY thing that makes it safe to trust the user id inside
// initData enough to log someone in with zero password.
export interface TelegramInitDataUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

export interface VerifiedTelegramData {
  user: TelegramInitDataUser;
  authDate: number;
}

// initData older than this is rejected — closes the window on someone
// capturing a genuine initData string once (e.g. via a compromised device
// or a leaked screenshot/log) and replaying it indefinitely to log in as
// that person forever. Telegram re-signs a fresh initData basically every
// time the Mini App is opened, so a legitimate user is never affected.
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60; // 24 hours

export const verifyTelegramInitData = (initData: string): VerifiedTelegramData => {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error('Telegram login is not configured on this server (missing TELEGRAM_BOT_TOKEN).');
  }
  if (!initData || typeof initData !== 'string') {
    throw new Error('Missing Telegram init data.');
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('Invalid Telegram init data — no hash present.');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Constant-time comparison — a naive `===` here would leak timing
  // information an attacker could theoretically use to brute-force the
  // hash character-by-character. Extremely low real-world risk for this
  // app, but it's a one-line fix and there's no reason not to.
  const hashBuffer = Buffer.from(hash, 'hex');
  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  if (
    hashBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(hashBuffer, expectedBuffer)
  ) {
    throw new Error('Telegram signature verification failed — this login attempt did not genuinely come from Telegram.');
  }

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (!authDate || ageSeconds > MAX_INIT_DATA_AGE_SECONDS) {
    throw new Error('This Telegram login has expired. Please relaunch the app from Telegram.');
  }

  const userRaw = params.get('user');
  if (!userRaw) throw new Error('Invalid Telegram init data — no user present.');

  let user: TelegramInitDataUser;
  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new Error('Invalid Telegram init data — malformed user payload.');
  }
  if (!user?.id) throw new Error('Invalid Telegram init data — missing user id.');

  return { user, authDate };
};
