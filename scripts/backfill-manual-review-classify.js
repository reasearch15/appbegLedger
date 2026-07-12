/**
 * Preview / apply reclassification of noisy Manual Review payment rows.
 *
 * Usage:
 *   node scripts/backfill-manual-review-classify.js            # preview
 *   node scripts/backfill-manual-review-classify.js --apply     # write changes
 */
import assert from 'node:assert/strict';
import { createDataStore } from '../src/db/index.js';
import {
  classifyPaymentGroupMessage,
  shouldAutoIgnore,
  MANUAL_REVIEW_REASON
} from '../src/payments/messageClassifier.js';
import { ROUTING_STATUS, UNMATCHED_REASON } from '../src/payments/constants.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  const store = await createDataStore();
  const rows = await store.db.prepare(`
    SELECT id, message_text, routing_status, unmatched_reason, message_date, registration_payment_window_id
    FROM payment_events
    WHERE routing_status IN ('manual_review', 'parse_failed', 'route_failed', 'ignored', 'untouched_unmatched', 'expired_deposit')
       OR (routing_status = 'manual_review')
    ORDER BY id ASC
  `).all();

  const summary = {
    totalCandidates: rows.length,
    ambiguous: 0,
    malformed: 0,
    cashout: 0,
    nonPayment: 0,
    reclassifyIgnored: 0,
    retainReview: 0,
    freezeOld: 0,
    unchanged: 0
  };

  for (const row of rows) {
    const classification = classifyPaymentGroupMessage(row.message_text);
    const unmatched = row.unmatched_reason;

    if (unmatched === UNMATCHED_REASON.AMBIGUOUS_MATCH || unmatched === 'multiple_active_matching_windows') {
      summary.ambiguous += 1;
      summary.retainReview += 1;
      continue;
    }

    if (classification.kind === 'cashout') {
      summary.cashout += 1;
      summary.reclassifyIgnored += 1;
      if (APPLY && row.routing_status !== ROUTING_STATUS.IGNORED) {
        await store.markPaymentIgnored(row.id, {
          staffName: 'SystemBackfill',
          unmatchedReason: MANUAL_REVIEW_REASON.CASHOUT_MESSAGE
        });
      }
      continue;
    }

    if (shouldAutoIgnore(classification)) {
      summary.nonPayment += 1;
      summary.reclassifyIgnored += 1;
      if (APPLY && row.routing_status !== ROUTING_STATUS.IGNORED) {
        await store.markPaymentIgnored(row.id, {
          staffName: 'SystemBackfill',
          unmatchedReason: classification.reason || MANUAL_REVIEW_REASON.NON_PAYMENT_MESSAGE
        });
      }
      continue;
    }

    if (classification.kind === 'payment_like') {
      summary.malformed += 1;
      summary.retainReview += 1;
      if (APPLY && !row.unmatched_reason) {
        await store.updatePaymentRouting(row.id, {
          unmatched_reason: classification.reason || MANUAL_REVIEW_REASON.MALFORMED_PAYMENT_MESSAGE
        });
      }
      continue;
    }

    summary.unchanged += 1;
  }

  console.log(JSON.stringify({
    mode: APPLY ? 'apply' : 'preview',
    ...summary,
    note: APPLY
      ? 'Changes applied. Cashout/non-payment rows marked ignored; ambiguous/malformed retained for Manual Review.'
      : 'Preview only. Re-run with --apply to write changes.'
  }, null, 2));

  assert.ok(summary.totalCandidates >= 0);
  if (typeof store.close === 'function') await store.close();
  else if (store.db?.close) await store.db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
