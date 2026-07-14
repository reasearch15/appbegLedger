/**
 * Smoke test for listOngoingWorkflows + /api/ongoing shaping.
 * Run: node scripts/test-ongoing-dashboard.js
 */
import { createDataStore } from '../src/db/index.js';
import { resolveDatabaseConfig } from '../src/db/config.js';
import { resolveOngoingUrgency } from '../src/ongoing/urgency.js';
import { formatWorkflowStepLabel } from '../src/ongoing/stepLabels.js';

async function main() {
  const dbConfig = resolveDatabaseConfig();
  const store = await createDataStore(dbConfig);
  const payload = await store.listOngoingWorkflows({ isAdmin: true });

  console.log('serverTime:', payload.serverTime);
  console.log('summary:', payload.summary);
  console.log('registrations:', payload.registrations.length);
  console.log('deposits:', payload.deposits.length);

  for (const item of [...payload.registrations, ...payload.deposits].slice(0, 5)) {
    console.log({
      flow: item.flow_type,
      name: item.display_name,
      step: item.current_step_label,
      started: item.window_started_at,
      expires: item.window_expires_at,
      remaining: item.remaining_seconds,
      urgency: item.urgency,
      aliases: {
        reg_start: item.registration_window_started_at,
        reg_end: item.registration_window_expires_at,
        dep_start: item.deposit_window_started_at,
        dep_end: item.deposit_window_expires_at
      }
    });
  }

  // Timer must come from DB, not be recomputed to a fresh duration
  const first = payload.registrations[0] || payload.deposits[0];
  if (first) {
    const again = await store.listOngoingWorkflows({ isAdmin: true });
    const match = [...again.registrations, ...again.deposits]
      .find((row) => Number(row.window_id) === Number(first.window_id));
    if (!match) {
      console.log('window left list between reads (ok if expired/matched)');
    } else {
      const sameStart = match.window_started_at === first.window_started_at;
      const sameEnd = match.window_expires_at === first.window_expires_at;
      console.log('persistent timestamps:', { sameStart, sameEnd });
      if (!sameStart || !sameEnd) {
        throw new Error('Window timestamps changed between reads — timer is not persistent');
      }
    }
  }

  console.log('step label:', formatWorkflowStepLabel('deposit_await_payment'));
  console.log('urgency 25s:', resolveOngoingUrgency(25));
  console.log('ok');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
