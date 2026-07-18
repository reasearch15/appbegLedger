import assert from 'node:assert/strict';
import {
  PAYMENT_WINDOW_MINUTES,
  PAYMENT_SEARCH_MINUTES,
  paymentWindowMinutes,
  paymentSearchMinutes,
  computePaymentFreezeAt,
  PAYMENT_WINDOW_FLOW,
  ROUTING_STATUS,
  UNMATCHED_REASON
} from '../src/payments/constants.js';
import {
  findMatchingActivePaymentWindow,
  isEligibleActivePaymentWindow,
  windowMatchesParsed
} from '../src/payments/paymentWindowMatcher.js';
import { reprocessPaymentEvent, routePaymentEvent } from '../src/payments/router.js';
import { parsePaymentMessage } from '../src/payments/parser.js';

function makeWindow(overrides = {}) {
  return {
    id: 1,
    contact_id: 10,
    telegram_user_id: '100',
    payment_display_name: 'Amy Fei',
    first_deposit_amount: 9,
    flow_type: PAYMENT_WINDOW_FLOW.REGISTRATION,
    status: 'active',
    status_raw: 'active',
    matched_payment_event_id: null,
    expires_at: new Date(Date.now() + 7 * 60 * 1000).toISOString(),
    payment_method_key: 'chime',
    ...overrides
  };
}

function paymentText(name = 'Amy Fei', amount = 9) {
  return [
    `You received $${amount} from ${name}`,
    '3:00 PM - 12 Jul 2026'
  ].join('\n');
}

function createRouterStore({ windows = [] } = {}) {
  const payments = new Map();
  const logs = [];

  return {
    windows,
    payments,
    logs,
    async getPaymentEvent(id) {
      const payment = payments.get(Number(id));
      return payment ? { ...payment } : null;
    },
    async ensurePaymentIdempotencyKey(id, key) {
      const payment = payments.get(Number(id));
      if (payment) payment.idempotency_key = key;
    },
    async applyPaymentParseResult(id, parsedResult) {
      const payment = payments.get(Number(id));
      if (!payment) return;
      payment.parsed_amount = parsedResult?.amount ?? null;
      payment.parsed_sender_name = parsedResult?.payment_sender_name ?? null;
      payment.parsed_payment_app = parsedResult?.payment_app ?? null;
    },
    async updatePaymentRouting(id, patch) {
      const payment = payments.get(Number(id));
      Object.assign(payment, patch);
      return { ...payment };
    },
    async logPaymentRouting(id, step, message, metadata = {}) {
      logs.push({ id, step, message, metadata });
    },
    async resetPaymentRoutingForReprocess(id) {
      const payment = payments.get(Number(id));
      Object.assign(payment, {
        routing_status: 'unrouted',
        routing_owner: null,
        routing_reason: null,
        contact_id: null,
        registration_payment_window_id: null,
        routed_at: null,
        handled_by: null,
        freeze_at: null,
        unmatched_reason: null,
        frozen_at: null,
        matched_at: null
      });
      return { ...payment };
    },
    async listActiveRegistrationPaymentWindows() {
      const now = Date.now();
      return windows.filter((w) => (
        w.status === 'active'
        && new Date(w.expires_at).getTime() > now
        && ['registration', 'deposit'].includes(w.flow_type || 'registration')
        && (w.matched_payment_event_id == null || w.matched_payment_event_id === '')
      ));
    },
    async claimPaymentWindowMatch(windowId, paymentEventId) {
      const window = windows.find((w) => w.id === windowId);
      if (!window) return { ok: false, reason: 'claim_failed', window: null };
      if ((window.status === 'matched' || window.status_raw === 'completed')
        && Number(window.matched_payment_event_id) === Number(paymentEventId)) {
        return { ok: true, reason: 'already_matched', window };
      }
      if (window.status !== 'active') return { ok: false, reason: 'claim_failed', window };
      if (!(new Date(window.expires_at).getTime() > Date.now())) {
        return { ok: false, reason: 'claim_failed', window };
      }
      if (window.matched_payment_event_id != null) {
        return { ok: false, reason: 'window_already_matched', window };
      }
      window.status = 'matched';
      window.status_raw = 'completed';
      window.matched_payment_event_id = paymentEventId;
      window.completed_at = new Date().toISOString();
      return { ok: true, reason: 'matched', window };
    },
    async getRegistrationPaymentWindow(id) {
      return windows.find((w) => w.id === id) || null;
    },
    async getUserProfile(id) {
      return { id, telegram_id: 1000 + id, registration_status: 'Collecting Info' };
    },
    async getAutomationState() {
      return { registration_info: {}, current_flow: null, current_step: null };
    },
    async updateRegistrationInfo() {},
    async updateAutomationState() {},
    async updateRegistrationStatus() {},
    async completeRegistrationPaymentWindow() {},
    async getAutoRegistrationBotSettings() {
      return { enabled: false };
    },
    async logEvent() {}
  };
}

async function run() {
  console.log('Active-window-only payment matcher tests');

  assert.equal(PAYMENT_WINDOW_MINUTES, 7);
  assert.equal(PAYMENT_SEARCH_MINUTES, 15);
  assert.equal(paymentWindowMinutes(), 7);
  assert.equal(paymentSearchMinutes(), 15);
  console.log('ok window=7m search/freeze=15m constants');

  const parsed = parsePaymentMessage(paymentText());
  assert.ok(parsed);
  assert.equal(parsed.amount, 9);
  assert.equal(parsed.payment_sender_name, 'Amy Fei');
  console.log('ok payment parser sample');

  const activeReg = makeWindow({ id: 1, flow_type: 'registration' });
  const activeDep = makeWindow({ id: 2, contact_id: 20, flow_type: 'deposit' });
  assert.equal(isEligibleActivePaymentWindow(activeReg), true);
  assert.equal(isEligibleActivePaymentWindow(activeDep), true);
  assert.equal(findMatchingActivePaymentWindow([activeReg], parsed).result, 'exact_match');
  assert.equal(findMatchingActivePaymentWindow([activeDep], parsed).result, 'exact_match');
  console.log('ok active registration window matches');
  console.log('ok active normal deposit window matches');

  const expiredReg = makeWindow({
    id: 3,
    status: 'active',
    expires_at: new Date(Date.now() - 1000).toISOString()
  });
  const expiredDep = makeWindow({
    id: 4,
    flow_type: 'deposit',
    status: 'active',
    expires_at: new Date(Date.now() - 1000).toISOString()
  });
  assert.equal(isEligibleActivePaymentWindow(expiredReg), false);
  assert.equal(isEligibleActivePaymentWindow(expiredDep), false);
  assert.equal(findMatchingActivePaymentWindow([expiredReg], parsed).result, 'no_match');
  assert.equal(findMatchingActivePaymentWindow([expiredDep], parsed).result, 'no_match');
  console.log('ok expired registration window does not match');
  console.log('ok expired deposit window does not match');

  const cancelled = makeWindow({ id: 5, status: 'cancelled', status_raw: 'cancelled' });
  const completed = makeWindow({
    id: 6,
    status: 'matched',
    status_raw: 'completed',
    matched_payment_event_id: 999
  });
  const manual = makeWindow({ id: 7, status: 'manual_review', status_raw: 'manual_review' });
  assert.equal(isEligibleActivePaymentWindow(cancelled), false);
  assert.equal(isEligibleActivePaymentWindow(completed), false);
  assert.equal(isEligibleActivePaymentWindow(manual), false);
  assert.equal(findMatchingActivePaymentWindow([cancelled, completed, manual], parsed).result, 'no_match');
  console.log('ok cancelled window does not match');
  console.log('ok completed window does not match');

  // Registered user profile / historical name without active deposit window
  const historicalOnly = [];
  assert.equal(findMatchingActivePaymentWindow(historicalOnly, parsed).result, 'no_match');
  assert.equal(
    findMatchingActivePaymentWindow([
      makeWindow({
        id: 8,
        flow_type: 'deposit',
        status: 'expired',
        status_raw: 'expired',
        payment_display_name: 'Amy Fei'
      })
    ], parsed).result,
    'no_match'
  );
  console.log('ok registered user without an active deposit window does not match');
  console.log('ok old payment-name history does not match');

  // Wrong amount / wrong name among active windows
  assert.equal(windowMatchesParsed(activeReg, { ...parsed, amount: 8 }), false);
  assert.equal(windowMatchesParsed(activeReg, { ...parsed, payment_sender_name: 'Other' }), false);

  // Conservative surname-initial matching.
  {
    const amyField = makeWindow({ id: 21, payment_display_name: 'Amy Field', first_deposit_amount: 5 });
    const amyInitial = parsePaymentMessage(paymentText('Amy F.', 5));
    const match = findMatchingActivePaymentWindow([amyField], amyInitial);
    assert.equal(match.result, 'exact_match');
    assert.equal(match.window.id, 21);
    assert.equal(match.matchMethod, 'surname_initial');
    console.log('ok Amy Field matches Amy F. by surname initial');
  }
  {
    const amyField = makeWindow({ id: 22, payment_display_name: 'amy field', first_deposit_amount: 5 });
    const amyInitial = parsePaymentMessage(paymentText('AMY F', 5));
    const match = findMatchingActivePaymentWindow([amyField], amyInitial);
    assert.equal(match.result, 'exact_match');
    assert.equal(match.matchMethod, 'surname_initial');
    console.log('ok surname initial match is case-insensitive and period optional');
  }
  {
    const amyField = makeWindow({ id: 23, payment_display_name: 'Amy Field', first_deposit_amount: 5 });
    assert.equal(findMatchingActivePaymentWindow([amyField], parsePaymentMessage(paymentText('Amy S.', 5))).result, 'no_match');
    assert.equal(findMatchingActivePaymentWindow([amyField], parsePaymentMessage(paymentText('Amy', 5))).result, 'no_match');
    assert.equal(findMatchingActivePaymentWindow([amyField], parsePaymentMessage(paymentText('A. Field', 5))).result, 'no_match');
    assert.equal(findMatchingActivePaymentWindow([amyField], parsePaymentMessage(paymentText('Amy Franks', 5))).result, 'no_match');
    console.log('ok unsafe abbreviated-name variants do not auto-match');
  }
  {
    const windows = [
      makeWindow({ id: 24, payment_display_name: 'Amy Field', first_deposit_amount: 5 }),
      makeWindow({ id: 25, payment_display_name: 'Amy Foster', first_deposit_amount: 5 })
    ];
    const match = findMatchingActivePaymentWindow(windows, parsePaymentMessage(paymentText('Amy F.', 5)));
    assert.equal(match.result, 'ambiguous_match');
    assert.equal(match.unmatchedReason, UNMATCHED_REASON.AMBIGUOUS_ABBREVIATED_NAME);
    console.log('ok duplicate surname-initial candidates are ambiguous');
  }
  {
    const amyField = makeWindow({ id: 26, payment_display_name: 'Amy Field', first_deposit_amount: 6 });
    assert.equal(findMatchingActivePaymentWindow([amyField], parsePaymentMessage(paymentText('Amy F.', 5))).result, 'no_match');
    console.log('ok different amounts do not match by surname initial');
  }
  {
    const expired = makeWindow({
      id: 27,
      payment_display_name: 'Amy Field',
      first_deposit_amount: 5,
      expires_at: new Date(Date.now() - 1000).toISOString()
    });
    assert.equal(findMatchingActivePaymentWindow([expired], parsePaymentMessage(paymentText('Amy F.', 5))).result, 'no_match');
    console.log('ok expired windows do not match by surname initial');
  }
  {
    const exact = makeWindow({ id: 28, payment_display_name: 'Amy F', first_deposit_amount: 5 });
    const initial = makeWindow({ id: 29, payment_display_name: 'Amy Field', first_deposit_amount: 5 });
    const match = findMatchingActivePaymentWindow([exact, initial], parsePaymentMessage(paymentText('Amy F', 5)));
    assert.equal(match.result, 'exact_match');
    assert.equal(match.window.id, 28);
    assert.equal(match.matchMethod, 'exact_name');
    console.log('ok exact full-name match is preferred over surname-initial match');
  }

  // Router: active registration match
  {
    const windows = [makeWindow({ id: 101, flow_type: 'registration' })];
    const store = createRouterStore({ windows });
    store.payments.set(1, {
      id: 1,
      message_text: paymentText(),
      telegram_group_id: 'g1',
      telegram_message_id: 1,
      message_date: new Date().toISOString(),
      routed_at: null,
      routing_status: 'unrouted'
    });
    const result = await routePaymentEvent(store, 1);
    assert.equal(result.outcome, ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED);
    assert.equal(windows[0].matched_payment_event_id, 1);
    console.log('ok router matches active registration window');
  }

  // Router: active registration match using surname initial
  {
    const windows = [makeWindow({ id: 111, flow_type: 'registration', payment_display_name: 'Amy Field', first_deposit_amount: 5 })];
    const store = createRouterStore({ windows });
    store.payments.set(11, {
      id: 11,
      message_text: paymentText('Amy F.', 5),
      telegram_group_id: 'g1',
      telegram_message_id: 11,
      message_date: new Date().toISOString(),
      routed_at: null,
      routing_status: 'unrouted'
    });
    const result = await routePaymentEvent(store, 11);
    assert.equal(result.outcome, ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED);
    assert.equal(windows[0].matched_payment_event_id, 11);
    assert.equal(store.payments.get(11).unmatched_reason, null);
    assert.equal(store.logs.some((log) => log.metadata?.matchingMethod === 'surname_initial'), true);
    console.log('ok router matches active registration window by surname initial');
  }

  // Reprocess uses same improved matching logic.
  {
    const windows = [makeWindow({ id: 112, flow_type: 'registration', payment_display_name: 'Amy Field', first_deposit_amount: 5 })];
    const store = createRouterStore({ windows });
    store.payments.set(12, {
      id: 12,
      message_text: paymentText('Amy F', 5),
      telegram_group_id: 'g1',
      telegram_message_id: 12,
      message_date: new Date().toISOString(),
      routed_at: new Date().toISOString(),
      routing_status: ROUTING_STATUS.SEARCHING,
      unmatched_reason: UNMATCHED_REASON.NAME_MISMATCH
    });
    const result = await reprocessPaymentEvent(store, 12);
    assert.equal(result.outcome, ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED);
    assert.equal(windows[0].matched_payment_event_id, 12);
    console.log('ok reprocess uses surname-initial matching logic');
  }

  // A claimed window cannot be claimed by a second payment.
  {
    const windows = [makeWindow({ id: 113, flow_type: 'registration', payment_display_name: 'Amy Field', first_deposit_amount: 5 })];
    const store = createRouterStore({ windows });
    store.payments.set(13, {
      id: 13,
      message_text: paymentText('Amy F.', 5),
      telegram_group_id: 'g1',
      telegram_message_id: 13,
      message_date: new Date().toISOString(),
      routed_at: null,
      routing_status: 'unrouted'
    });
    store.payments.set(14, {
      id: 14,
      message_text: paymentText('Amy F.', 5),
      telegram_group_id: 'g1',
      telegram_message_id: 14,
      message_date: new Date().toISOString(),
      routed_at: null,
      routing_status: 'unrouted'
    });
    assert.equal((await routePaymentEvent(store, 13)).outcome, ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED);
    assert.equal((await routePaymentEvent(store, 14)).outcome, ROUTING_STATUS.SEARCHING);
    assert.equal(windows[0].matched_payment_event_id, 13);
    console.log('ok claimed payment window cannot be claimed twice');
  }

  // Router: active deposit match
  {
    const windows = [makeWindow({ id: 201, flow_type: 'deposit', contact_id: 55 })];
    const store = createRouterStore({ windows });
    store.payments.set(2, {
      id: 2,
      message_text: paymentText(),
      telegram_group_id: 'g1',
      telegram_message_id: 2,
      message_date: new Date().toISOString(),
      routed_at: null,
      routing_status: 'unrouted'
    });
    const result = await routePaymentEvent(store, 2);
    assert.equal(result.outcome, ROUTING_STATUS.DEPOSIT_WINDOW_MATCHED);
    console.log('ok router matches active deposit window');
  }

  // Router: expired window stays searching (not matched)
  {
    const windows = [makeWindow({
      id: 301,
      status: 'active',
      expires_at: new Date(Date.now() - 5000).toISOString()
    })];
    const store = createRouterStore({ windows });
    store.payments.set(3, {
      id: 3,
      message_text: paymentText(),
      telegram_group_id: 'g1',
      telegram_message_id: 3,
      message_date: new Date().toISOString(),
      routed_at: null,
      routing_status: 'unrouted'
    });
    const result = await routePaymentEvent(store, 3);
    assert.equal(result.outcome, ROUTING_STATUS.SEARCHING);
    assert.equal(result.payment.routing_status, ROUTING_STATUS.SEARCHING);
    assert.ok(result.payment.freeze_at);
    assert.equal(result.payment.routed_at, null);
    console.log('ok expired window does not auto-match; payment stays searching');
  }

  // Router: no window + registered history name cannot match
  {
    const store = createRouterStore({ windows: [] });
    store.payments.set(4, {
      id: 4,
      message_text: paymentText('Historical Name', 50),
      telegram_group_id: 'g1',
      telegram_message_id: 4,
      message_date: new Date().toISOString(),
      routed_at: null,
      routing_status: 'unrouted'
    });
    const result = await routePaymentEvent(store, 4);
    assert.equal(result.outcome, ROUTING_STATUS.SEARCHING);
    assert.equal(result.unmatchedReason, UNMATCHED_REASON.NO_ACTIVE_WINDOW);
    console.log('ok payment without active window enters searching');
  }

  // Freeze after 15 minutes with no active window
  {
    const store = createRouterStore({ windows: [] });
    const started = new Date(Date.now() - 16 * 60 * 1000);
    store.payments.set(5, {
      id: 5,
      message_text: paymentText(),
      telegram_group_id: 'g1',
      telegram_message_id: 5,
      message_date: started.toISOString(),
      freeze_at: computePaymentFreezeAt(started),
      routed_at: null,
      routing_status: ROUTING_STATUS.SEARCHING
    });
    const result = await routePaymentEvent(store, 5, { now: new Date() });
    assert.equal(result.outcome, ROUTING_STATUS.FROZEN);
    assert.equal(result.unmatchedReason, UNMATCHED_REASON.NO_ACTIVE_WINDOW);
    assert.ok(result.payment.routed_at);
    console.log('ok payment freezes after 15 minutes when no active window appears');
  }

  // Searching payment can still match if window appears before freeze
  {
    const windows = [];
    const store = createRouterStore({ windows });
    const started = new Date();
    store.payments.set(6, {
      id: 6,
      message_text: paymentText(),
      telegram_group_id: 'g1',
      telegram_message_id: 6,
      message_date: started.toISOString(),
      freeze_at: computePaymentFreezeAt(started),
      routed_at: null,
      routing_status: ROUTING_STATUS.SEARCHING
    });
    let result = await routePaymentEvent(store, 6);
    assert.equal(result.outcome, ROUTING_STATUS.SEARCHING);
    windows.push(makeWindow({ id: 601, flow_type: 'registration' }));
    result = await routePaymentEvent(store, 6);
    assert.equal(result.outcome, ROUTING_STATUS.REGISTRATION_PAYMENT_MATCHED);
    console.log('ok searching payment matches when active window appears before freeze');
  }

  // Ambiguous active windows -> manual review
  {
    const windows = [
      makeWindow({ id: 701, flow_type: 'registration' }),
      makeWindow({ id: 702, contact_id: 11, flow_type: 'deposit' })
    ];
    const store = createRouterStore({ windows });
    store.payments.set(7, {
      id: 7,
      message_text: paymentText(),
      telegram_group_id: 'g1',
      telegram_message_id: 7,
      message_date: new Date().toISOString(),
      routed_at: null,
      routing_status: 'unrouted'
    });
    const result = await routePaymentEvent(store, 7);
    assert.equal(result.outcome, ROUTING_STATUS.MANUAL_REVIEW);
    assert.equal(result.unmatchedReason, UNMATCHED_REASON.AMBIGUOUS_MATCH);
    console.log('ok multiple active windows go to manual review');
  }

  // Ambiguous surname-initial active windows -> manual review with explicit reason.
  {
    const windows = [
      makeWindow({ id: 801, payment_display_name: 'Amy Field', first_deposit_amount: 5 }),
      makeWindow({ id: 802, payment_display_name: 'Amy Foster', first_deposit_amount: 5 })
    ];
    const store = createRouterStore({ windows });
    store.payments.set(8, {
      id: 8,
      message_text: paymentText('Amy F.', 5),
      telegram_group_id: 'g1',
      telegram_message_id: 8,
      message_date: new Date().toISOString(),
      routed_at: null,
      routing_status: 'unrouted'
    });
    const result = await routePaymentEvent(store, 8);
    assert.equal(result.outcome, ROUTING_STATUS.MANUAL_REVIEW);
    assert.equal(result.unmatchedReason, UNMATCHED_REASON.AMBIGUOUS_ABBREVIATED_NAME);
    assert.equal(store.payments.get(8).unmatched_reason, UNMATCHED_REASON.AMBIGUOUS_ABBREVIATED_NAME);
    console.log('ok ambiguous surname-initial windows go to manual review');
  }

  console.log('ALL ACTIVE-WINDOW MATCHER CHECKS PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
