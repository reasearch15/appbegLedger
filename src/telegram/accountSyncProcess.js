import path from 'node:path';
import { createWorkerSupervisor } from './workerSupervisor.js';

let activeSupervisor = null;

export async function startTelegramAccountSync({ rootDir, store, io }) {
  await store.updateTelegramAccountSyncState({
    status: 'disabled',
    last_error: null
  });
  console.log('Personal Telegram account sync is disabled. Official Bot API is the only user contact channel.');
  return null;

  if (process.env.TELEGRAM_ACCOUNT_SYNC_ENABLED !== 'true') {
    await store.updateTelegramAccountSyncState({ status: 'disabled' });
    console.log('Business Telegram account sync is disabled.');
    return null;
  }

  const apiId = process.env.TELEGRAM_ACCOUNT_API_ID;
  const apiHash = process.env.TELEGRAM_ACCOUNT_API_HASH;
  if (!apiId || !apiHash) {
    await store.updateTelegramAccountSyncState({
      status: 'misconfigured',
      last_error: 'TELEGRAM_ACCOUNT_API_ID and TELEGRAM_ACCOUNT_API_HASH are required.'
    });
    console.warn('Business Telegram account sync is missing API credentials.');
    return null;
  }

  if (activeSupervisor) {
    console.log('[telethon] Stopping previous account sync worker before starting a new one.');
    await activeSupervisor.stop();
    activeSupervisor = null;
  }

  const scriptPath = path.join(rootDir, 'scripts', 'telegram_account_sync.py');
  const supervisor = createWorkerSupervisor({
    name: 'telethon',
    command: 'python',
    args: [scriptPath, 'sync'],
    cwd: rootDir,
    env: {
      ...process.env,
      DATABASE_PATH: process.env.DATABASE_PATH || './data/royal-vip-coadmin.sqlite',
      SYNC_NOTIFY_URL: `http://localhost:${process.env.PORT || 4300}/api/internal/telegram-account-sync/notify`
    },
    onBeforeLaunch: async () => {
      await store.updateTelegramAccountSyncState({
        status: 'starting',
        last_started_at: new Date().toISOString(),
        last_error: null
      });
    },
    onStdout: (data) => {
      console.log(`[telethon] ${String(data).trim()}`);
    },
    onStderr: (data) => {
      console.warn(`[telethon] ${String(data).trim()}`);
    },
    onExit: ({ code }) => {
      if (code === 2) {
        void store.updateTelegramAccountSyncState({
          status: 'error',
          last_error: 'Another account sync worker is already running. Stop stale python/node processes and restart.'
        });
        io.emit('sync:changed');
        return;
      }
      void store.updateTelegramAccountSyncState({
        status: 'reconnecting',
        last_error: `Telethon worker exited with code ${code}`
      });
      io.emit('sync:changed');
    },
    shouldReconnect: ({ code }) => code !== 2
  });

  activeSupervisor = supervisor;
  supervisor.start();

  return supervisor;
}

export async function stopTelegramAccountSync() {
  if (!activeSupervisor) return;
  await activeSupervisor.stop();
  activeSupervisor = null;
}
