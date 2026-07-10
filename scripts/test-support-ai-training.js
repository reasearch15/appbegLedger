import {
  normalizeCustomerMessage,
  selectBestTrainingMatch,
  getApprovedFinalReply,
  isRegistrationContextCompatible
} from '../src/telegram/supportAiTrainingRetrieval.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const wrongReply = 'You are already registered. Tell us what you need help with.';
const correctedReply = 'Sure, I can help you register. Which payment app will you use?';

const approvedBadExample = {
  id: 1,
  contact_id: 10,
  customer_message: 'I want to play',
  normalized_customer_message: normalizeCustomerMessage('I want to play'),
  detected_intent: 'wants_registration',
  ai_reply: wrongReply,
  ai_draft_reply: wrongReply,
  final_staff_reply: correctedReply,
  staff_reply: correctedReply,
  approved: true,
  feedback: 'bad',
  ai_reply_rejected: true,
  was_registered: false,
  registration_status: 'New',
  language: 'en'
};

const contactContext = {
  was_registered: false,
  registration_status: 'New',
  registration_phase: 'not_registered',
  underlying_registration_phase: 'not_registered'
};

console.log('Test 1: normalize exact message');
assert(
  normalizeCustomerMessage('I want to play') === 'i want to play',
  'normalization failed'
);

console.log('Test 2: rejected AI reply is excluded');
assert(
  getApprovedFinalReply(approvedBadExample) === correctedReply,
  'approved final reply should be staff correction'
);
assert(
  getApprovedFinalReply(approvedBadExample) !== wrongReply,
  'rejected AI reply must not be returned'
);

console.log('Test 3: exact match returns corrected reply');
const exactMatch = selectBestTrainingMatch([approvedBadExample], {
  customerMessage: 'I want to play',
  intent: 'wants_registration',
  contactContext,
  language: 'en',
  contactId: 99
});
assert(exactMatch.matchType === 'exact', `expected exact match, got ${exactMatch.matchType}`);
assert(exactMatch.reply === correctedReply, 'exact match must return staff corrected reply');

console.log('Test 4: registered context blocks unregistered training');
const registeredContext = {
  was_registered: true,
  registration_status: 'Registered',
  registration_phase: 'registered'
};
const blocked = selectBestTrainingMatch([approvedBadExample], {
  customerMessage: 'I want to play',
  intent: 'wants_registration',
  contactContext: registeredContext
});
assert(!blocked.reply, 'unregistered training must not apply to registered player');

console.log('Test 5: compatible context check');
assert(
  isRegistrationContextCompatible(approvedBadExample, contactContext),
  'unregistered example should match unregistered contact'
);
assert(
  !isRegistrationContextCompatible(approvedBadExample, registeredContext),
  'unregistered example must not match registered contact for registration intent'
);

console.log('Test 6: similar wording match');
const similarMatch = selectBestTrainingMatch([approvedBadExample], {
  customerMessage: 'i want to play!',
  intent: 'wants_registration',
  contactContext
});
assert(similarMatch.reply === correctedReply, 'similar message should still use corrected reply');

console.log('All support AI training retrieval tests passed.');
