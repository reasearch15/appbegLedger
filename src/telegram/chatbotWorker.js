import { processBotJob } from './chatbotProcessor.js';

/**
 * Concurrent per-contact chatbot worker.
 * Claims independent jobs and never mixes state across telegram users.
 */
export function startChatbotWorker({ store, io, concurrency = Number(process.env.CHATBOT_CONCURRENCY || 5) }) {
  const enabled = process.env.CHATBOT_ENABLED !== 'false';
  if (!enabled) {
    console.log('[chatbot] worker disabled (CHATBOT_ENABLED=false)');
    return { stop: async () => {} };
  }

  let stopped = false;
  let tickPromise = null;
  const workerId = `node-chatbot-${process.pid}`;
  const pollMs = Number(process.env.CHATBOT_POLL_MS || 700);

  console.log(`[chatbot] worker starting concurrency=${concurrency} id=${workerId}`);

  void store.resetStuckBotJobs('Worker restart').catch((error) => {
    console.warn('[chatbot] reset stuck jobs failed:', error.message);
  });

  async function tick() {
    if (stopped) return;
    try {
      const claimed = [];
      for (let i = 0; i < concurrency; i += 1) {
        const job = await store.claimNextBotJob(workerId);
        if (!job) break;
        console.log(`[chatbot] bot job claimed id=${job.id} contact=${job.contact_id}`);
        claimed.push(job);
      }

      if (claimed.length) {
        await Promise.all(claimed.map((job) => processBotJob(store, job, { io })));
      }
    } catch (error) {
      console.error('[chatbot] worker tick failed:', error);
    }
  }

  const timer = setInterval(() => {
    if (tickPromise) return;
    tickPromise = tick().finally(() => {
      tickPromise = null;
    });
  }, pollMs);

  // Run an immediate pass so the first queued jobs don't wait a full poll.
  tickPromise = tick().finally(() => {
    tickPromise = null;
  });

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (tickPromise) await tickPromise;
      console.log('[chatbot] worker stopped');
    }
  };
}
