import { Router, Request, Response } from 'express';
import { env } from '../config/env';
import { telegramBotService } from '../services/telegramBot.service';

const router = Router();

// ── Telegram Bot webhook ─────────────────────────────────────────────────
// This bot has exactly ONE piece of logic: reply to /start with a welcome
// message + an "Open Mailzeon" button. There's no broader conversational
// bot behind this — every other interaction happens through the Mini App
// itself (see app/telegram/page.tsx on the frontend), not through chat
// messages. Any update that isn't a /start command is simply ignored.
//
// ── One-time setup (do this once, from a browser or curl, NOT through
//    BotFather chat) — tells Telegram to actually start sending updates
//    here: ────────────────────────────────────────────────────────────
//   https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<YOUR_RENDER_URL>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
// Replace <TELEGRAM_BOT_TOKEN> with your real bot token, <YOUR_RENDER_URL>
// with this backend's actual Render URL, and <TELEGRAM_WEBHOOK_SECRET>
// with whatever you set that env var to (any random string — must match
// exactly). Visiting that URL once in a browser is enough; Telegram
// replies with {"ok":true,"result":true,...} on success.
router.post('/webhook', async (req: Request, res: Response) => {
  // Verify this genuinely came from Telegram, not a random POST to a
  // public URL — only meaningful once TELEGRAM_WEBHOOK_SECRET is set (see
  // config/env.ts); skipped entirely if it's left unset.
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (receivedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      res.status(401).json({ success: false, message: 'Invalid secret token.' });
      return;
    }
  }

  // Always respond 200 immediately regardless of what the update contains
  // — Telegram retries a webhook repeatedly if it doesn't get a fast 2xx,
  // which would otherwise cause duplicate welcome messages piling up for
  // the same /start if our own processing was ever slow.
  res.status(200).json({ ok: true });

  try {
    const update = req.body;
    const text: string | undefined = update?.message?.text;
    const chatId: number | undefined = update?.message?.chat?.id;

    if (chatId && text?.trim().split(' ')[0] === '/start') {
      await telegramBotService.sendWelcomeMessage(chatId);
    }
  } catch (err) {
    console.error('[TelegramWebhook] Failed to process update:', err);
  }
});

export default router;
