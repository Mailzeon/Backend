import 'dotenv/config';
import http from 'http';
import { app }                  from './app';
import { connectDatabase }      from './config/database';
import { initSocket }           from './socket/socket';
import { startAutoCompleteJob } from './utils/autoComplete';
import { startAutoApproveHeldJob } from './utils/autoApproveHeld';
import { recoverOrderTimers }   from './utils/recoverTimers';
import { startKeepAlive }       from './utils/keepAlive';
import { seedDefaultSettings }  from './models/Settings.model';
import { seedAdminUser }        from './utils/seedAdmin';
import { backfillWasEverApproved } from './utils/backfillwaseverapproved';
import { backfillEmailVerification } from './utils/backfillEmailVerification';
import { backfillPhoneVerification } from './utils/backfillPhoneVerification';
import { env }                  from './config/env';

const server = http.createServer(app);
initSocket(server);

const start = async (): Promise<void> => {
  try {
    await connectDatabase();
    await seedDefaultSettings();
    await seedAdminUser();
    await backfillWasEverApproved();
    await recoverOrderTimers();

    server.listen(env.PORT, () => {
      console.log('');
      console.log('🚀 ─────────────────────────────────────────');
      console.log(`   Server  : http://localhost:${env.PORT}`);
      console.log(`   Health  : http://localhost:${env.PORT}/health`);
      console.log(`   Mode    : ${env.NODE_ENV}`);
      console.log('─────────────────────────────────────────────');
      console.log('');
    });

    startAutoCompleteJob();
    startAutoApproveHeldJob();
    startKeepAlive();

    // NOT awaited on purpose — this makes one external API call per
    // not-yet-checked existing user (with a deliberate small delay
    // between each), which could take a while as the user base grows.
    // The server should start accepting requests immediately; this just
    // runs quietly in the background afterward. See
    // utils/backfillEmailVerification.ts for why this is safe to fire
    // every restart (naturally becomes a no-op once everyone's checked).
    backfillEmailVerification().catch(err =>
      console.error('[Startup] Email verification backfill failed:', err)
    );
    // Same reasoning as above — see utils/backfillPhoneVerification.ts.
    // Fixes everyone stranded by the just-patched "unchanged number
    // silently skips verification" bug, without needing them to
    // manually revisit their profile.
    backfillPhoneVerification().catch(err =>
      console.error('[Startup] Phone verification backfill failed:', err)
    );
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err);
  process.exit(1);
});

start();
