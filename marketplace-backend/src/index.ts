import 'dotenv/config';
import http from 'http';
import { app }                  from './app';
import { connectDatabase }      from './config/database';
import { initSocket }           from './socket/socket';
import { startAutoCompleteJob } from './utils/autoComplete';
import { recoverOrderTimers }   from './utils/recoverTimers';
import { seedDefaultSettings }  from './models/Settings.model';
import { seedAdminUser }        from './utils/seedAdmin';
import { env }                  from './config/env';

const server = http.createServer(app);
initSocket(server);

const start = async (): Promise<void> => {
  try {
    await connectDatabase();
    await seedDefaultSettings();
    await seedAdminUser();

    // Restart any in-memory timers that were lost during server restart
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
