import path from 'node:path';
import { createWorkerSupervisor } from './workerSupervisor.js';

let activeSupervisor = null;

export async function startPaymentTelegramSync({ rootDir, store, io }) {
  if (process.env.PAYMENT_TELEGRAM_SYNC_ENABLED !== 'true') {
    await store.updatePaymentSyncState({ status: 'disabled' });
    await store.logPaymentListener({
      eventType: 'payment_group_listener_started',
      message: 'Payment group listener disabled.'
    });
    console.log('Payment Telegram sync is disabled.');
    return null;
  }

  const apiId = process.env.PAYMENT_TELEGRAM_API_ID;
  const apiHash = process.env.PAYMENT_TELEGRAM_API_HASH;
  const group = process.env.PAYMENT_TELEGRAM_GROUP || process.env.PAYMENT_GROUP_CHAT_ID;
  const sessionPath = process.env.PAYMENT_TELEGRAM_SESSION || './data/appbeg-payment.session';
  if (!apiId || !apiHash || !group) {
    await store.updatePaymentSyncState({
      status: 'misconfigured',
      last_error: 'PAYMENT_TELEGRAM_API_ID, PAYMENT_TELEGRAM_API_HASH, and PAYMENT_TELEGRAM_GROUP/PAYMENT_GROUP_CHAT_ID are required.'
    });
    await store.logPaymentListener({
      level: 'error',
      eventType: 'payment_group_listener_started',
      message: 'Payment group listener is missing credentials or group configuration.'
    });
    console.warn('Payment group listener is missing credentials or group configuration.');
    return null;
  }

  if (activeSupervisor) {
    console.log('[payment-telethon] Stopping previous payment sync worker before starting a new one.');
    await activeSupervisor.stop();
    activeSupervisor = null;
  }

  const scriptPath = path.join(rootDir, 'scripts', 'payment_telegram_sync.py');
  const supervisor = createWorkerSupervisor({
    name: 'payment-telethon',
    command: 'python',
    args: [scriptPath, 'sync'],
    cwd: rootDir,
    env: {
      ...process.env,
      DATABASE_PATH: process.env.DATABASE_PATH || './data/royal-vip-coadmin.sqlite',
      PAYMENT_TELEGRAM_SESSION: sessionPath,
      PAYMENT_SYNC_NOTIFY_URL: `http://localhost:${process.env.PORT || 4300}/api/internal/payment-sync/notify`
    },
    onBeforeLaunch: async () => {
      await store.updatePaymentSyncState({
        status: 'starting',
        last_started_at: new Date().toISOString(),
        last_error: null
      });
      await store.logPaymentListener({
        eventType: 'payment_group_listener_started',
        message: 'Payment group listener worker starting.',
        metadata: { sessionPath, group }
      });
      console.log(`[payment-router] payment_group_listener_started session=${sessionPath} group=${group}`);
    },
    onStdout: (data) => {
      console.log(`[payment-telethon] ${String(data).trim()}`);
    },
    onStderr: (data) => {
      console.warn(`[payment-telethon] ${String(data).trim()}`);
    },
    onExit: ({ code }) => {
      void store.updatePaymentSyncState({
        status: 'reconnecting',
        last_error: `Payment Telethon worker exited with code ${code}`
      });
      void store.logPaymentListener({
        level: 'error',
        eventType: 'payment_group_listener_started',
        message: `Payment group listener worker exited with code ${code}`
      });
      io.emit('payments:changed');
      io.emit('payment-sync:changed');
    }
  });

  activeSupervisor = supervisor;
  supervisor.start();

  return supervisor;
}

export async function stopPaymentTelegramSync() {
  if (!activeSupervisor) return;
  await activeSupervisor.stop();
  activeSupervisor = null;
}
