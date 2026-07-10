const REGISTRATION_SENSITIVE_INTENTS = new Set([
  'wants_registration',
  'registration_progress',
  'registered_support',
  'deposit_question',
  'withdrawal_question',
  'login_help'
]);

export function normalizeCustomerMessage(text = '') {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildTrainingLookupKey({
  normalizedMessage,
  wasRegistered = false,
  registrationStep = null,
  intent = null
} = {}) {
  return [
    normalizedMessage || '',
    wasRegistered ? 'registered' : 'unregistered',
    registrationStep || 'none',
    intent || 'any'
  ].join('|');
}

export function exampleTrainingLookupKey(example) {
  const exampleRegistered = example.was_registered === true
    || example.was_registered === 1
    || example.was_registered === '1';
  return buildTrainingLookupKey({
    normalizedMessage: example.normalized_customer_message
      || normalizeCustomerMessage(example.customer_message),
    wasRegistered: exampleRegistered,
    registrationStep: example.registration_step || null,
    intent: example.detected_intent || null
  });
}

export function tokenizeMessage(text = '') {
  const normalized = normalizeCustomerMessage(text);
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

export function wordSimilarity(a = '', b = '') {
  const tokensA = new Set(tokenizeMessage(a));
  const tokensB = new Set(tokenizeMessage(b));
  if (!tokensA.size || !tokensB.size) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union ? intersection / union : 0;
}

export function getApprovedFinalReply(example) {
  if (!example?.approved) return null;
  const reply = String(example.final_staff_reply || example.staff_reply || '').trim();
  if (!reply) return null;
  if (example.ai_reply_rejected) {
    const rejectedAi = String(example.ai_reply || example.ai_draft_reply || '').trim();
    if (rejectedAi && rejectedAi === reply) return null;
  }
  return reply;
}

function exampleWasRegistered(example) {
  return example.was_registered === true
    || example.was_registered === 1
    || example.was_registered === '1';
}

function contactIsRegistered(contactContext = {}) {
  return Boolean(contactContext.is_registered ?? contactContext.was_registered);
}

export function isRegistrationContextCompatible(example, contactContext = {}) {
  const exampleRegistered = exampleWasRegistered(example);
  const currentRegistered = contactIsRegistered(contactContext);

  if (exampleRegistered !== currentRegistered) {
    return false;
  }

  if (example.registration_step && contactContext.current_step) {
    if (example.registration_step !== contactContext.current_step) {
      const paymentSteps = new Set(['await_payment_done', 'waiting_for_payment_confirmation']);
      if (paymentSteps.has(example.registration_step) || paymentSteps.has(contactContext.current_step)) {
        return false;
      }
    }
  }

  if (example.registration_status && contactContext.registration_status) {
    if (example.registration_status !== contactContext.registration_status) {
      if (REGISTRATION_SENSITIVE_INTENTS.has(String(example.detected_intent || ''))) {
        return false;
      }
    }
  }

  if (example.payment_window_status && contactContext.payment_window_status) {
    if (example.payment_window_status !== contactContext.payment_window_status) {
      const paymentPhases = new Set([
        'waiting_for_payment',
        'waiting_for_payment_confirmation',
        'payment_confirmed_collecting_account_info'
      ]);
      const phase = contactContext.registration_phase || contactContext.underlying_registration_phase;
      if (paymentPhases.has(phase)) return false;
    }
  }

  return true;
}

export function scoreTrainingExample(example, {
  normalizedMessage,
  customerMessage,
  intent,
  contactContext = {},
  language = null,
  contactId = null
} = {}) {
  if (!example?.approved) return -1;
  const finalReply = getApprovedFinalReply(example);
  if (!finalReply) return -1;

  if (!isRegistrationContextCompatible(example, contactContext)) {
    return -1;
  }

  const exampleNormalized = example.normalized_customer_message
    || normalizeCustomerMessage(example.customer_message);
  const currentRegistered = contactIsRegistered(contactContext);
  const lookupKey = buildTrainingLookupKey({
    normalizedMessage,
    wasRegistered: currentRegistered,
    registrationStep: contactContext.current_step || contactContext.registration_step || null,
    intent
  });
  const exampleKey = exampleTrainingLookupKey(example);
  let score = 0;

  if (lookupKey === exampleKey) {
    score += 1500;
  } else if (exampleNormalized && normalizedMessage && exampleNormalized === normalizedMessage) {
    score += 1000;
    if (exampleWasRegistered(example) === currentRegistered) score += 200;
    if ((example.registration_step || 'none') === (contactContext.current_step || contactContext.registration_step || 'none')) {
      score += 50;
    }
  } else {
    const similarity = wordSimilarity(customerMessage, example.customer_message);
    score += Math.round(similarity * 80);
  }

  if (intent && example.detected_intent === intent) {
    score += 100;
  }

  if (exampleWasRegistered(example) === currentRegistered) {
    score += 200;
  } else {
    return -1;
  }

  if ((example.registration_step || 'none') === (contactContext.current_step || contactContext.registration_step || 'none')) {
    score += 50;
  }

  if (language && example.language && example.language === language) {
    score += 10;
  }

  if (contactId && Number(example.contact_id) === Number(contactId)) {
    score += 20;
  }

  if (example.feedback === 'good' || example.reply_used === 'good') {
    score += 5;
  }

  return score;
}

export function selectBestTrainingMatch(examples, params, { minScore = 100 } = {}) {
  const normalizedMessage = params.normalizedMessage
    || normalizeCustomerMessage(params.customerMessage);
  const scored = (examples || [])
    .map((example) => ({
      example,
      score: scoreTrainingExample(example, { ...params, normalizedMessage }),
      finalReply: getApprovedFinalReply(example)
    }))
    .filter((item) => item.score >= 0 && item.finalReply)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return { matchType: null, reply: null, examples: [], best: null };
  }

  const best = scored[0];
  const exact = scored.find((item) => item.score >= 1000);
  if (exact) {
    return {
      matchType: 'exact',
      reply: exact.finalReply,
      examples: scored.slice(0, params.limit || 5).map((item) => item.example),
      best: exact.example,
      score: exact.score
    };
  }

  if (best.score >= minScore) {
    return {
      matchType: 'similar',
      reply: best.finalReply,
      examples: scored.slice(0, params.limit || 5).map((item) => item.example),
      best: best.example,
      score: best.score
    };
  }

  return {
    matchType: null,
    reply: null,
    examples: scored.slice(0, params.limit || 5).map((item) => item.example),
    best: null,
    score: best.score
  };
}

export function formatTrainingExamplesForContext(examples = []) {
  if (!examples.length) return '';
  const lines = examples.slice(0, 3).map((example, index) => {
    const reply = getApprovedFinalReply(example) || '';
    return [
      `Approved example ${index + 1}:`,
      `Customer: ${example.customer_message || ''}`,
      `Staff reply: ${reply}`,
      `Intent: ${example.detected_intent || 'unknown'}`,
      `Registered: ${exampleWasRegistered(example) ? 'yes' : 'no'}`,
      `Registration step: ${example.registration_step || 'none'}`
    ].join('\n');
  });
  return ['Approved staff training examples (matched to current user state):', ...lines].join('\n\n');
}
