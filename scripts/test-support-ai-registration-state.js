import { buildSupportAiDecision, detectUnregisteredPlayIntent } from '../src/telegram/supportAiContactContext.js';
import { selectBestTrainingMatch } from '../src/telegram/supportAiTrainingRetrieval.js';
import { resolveSupportAiRegistrationState } from '../src/telegram/supportAiRegistrationState.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const registeredContext = {
  contact_id: 1,
  is_registered: true,
  was_registered: true,
  registration_phase: 'registered',
  underlying_registration_phase: 'registered',
  registration_state: 'registered',
  appbeg_username: 'Rajex01',
  appbeg_player_uid: 'player-uid-12345678',
  registration_status: 'Registered',
  current_step: null
};

const unregisteredContext = {
  contact_id: 2,
  is_registered: false,
  was_registered: false,
  registration_phase: 'not_registered',
  underlying_registration_phase: 'not_registered',
  registration_state: 'unregistered',
  appbeg_username: null,
  appbeg_player_uid: null,
  registration_status: 'New',
  current_step: null
};

console.log('Test A: registered contact wants to play');
const testA = buildSupportAiDecision({
  messageText: 'I want to play',
  contactContext: registeredContext
});
assert(testA.intent === 'registered_support', `expected registered_support, got ${testA.intent}`);
assert(!/register/i.test(testA.reply_text), 'registered reply must not offer registration');
assert(/log in|play/i.test(testA.reply_text), 'registered reply should mention login/play');

console.log('Test B: unregistered contact wants to play');
const testB = buildSupportAiDecision({
  messageText: 'I want to play',
  contactContext: unregisteredContext
});
assert(testB.intent === 'wants_registration', `expected wants_registration, got ${testB.intent}`);
assert(testB.recommended_action === 'start_registration_flow', 'should recommend registration flow');
assert(/register/i.test(testB.reply_text), 'unregistered reply should guide registration');

console.log('Test C: registered contact asks to register again');
const testC = buildSupportAiDecision({
  messageText: 'Register me',
  contactContext: registeredContext
});
assert(testC.intent === 'registered_support', `expected registered_support, got ${testC.intent}`);
assert(/already have/i.test(testC.reply_text), 'should explain account already exists');
assert(!/which payment app/i.test(testC.reply_text), 'must not start registration');

console.log('Test D: training examples separated by registration state');
const registeredExample = {
  id: 10,
  customer_message: 'I want to play',
  normalized_customer_message: 'i want to play',
  detected_intent: 'registered_support',
  final_staff_reply: 'Log in to your Royal VIP account and open Play.',
  staff_reply: 'Log in to your Royal VIP account and open Play.',
  approved: true,
  was_registered: true,
  registration_step: null,
  feedback: 'good'
};
const unregisteredExample = {
  id: 11,
  customer_message: 'I want to play',
  normalized_customer_message: 'i want to play',
  detected_intent: 'wants_registration',
  final_staff_reply: 'Sure, I can help you get registered first. Which payment app will you use?',
  staff_reply: 'Sure, I can help you get registered first. Which payment app will you use?',
  approved: true,
  was_registered: false,
  registration_step: null,
  feedback: 'good'
};

const registeredPick = selectBestTrainingMatch([registeredExample, unregisteredExample], {
  customerMessage: 'I want to play',
  intent: 'registered_support',
  contactContext: registeredContext
});
assert(registeredPick.reply === registeredExample.final_staff_reply, 'registered contact should get registered training example');

const unregisteredPick = selectBestTrainingMatch([registeredExample, unregisteredExample], {
  customerMessage: 'I want to play',
  intent: 'wants_registration',
  contactContext: unregisteredContext
});
assert(unregisteredPick.reply === unregisteredExample.final_staff_reply, 'unregistered contact should get unregistered training example');

console.log('Test E: registration state resolver prefers UID over status label');
const resolved = await resolveSupportAiRegistrationState({
  contact: {
    id: 99,
    registration_status: 'Registered',
    appbeg_account_id: null,
    appbeg_link_status: null
  },
  info: {},
  flow: null,
  step: null,
  paymentWindow: null,
  manualStaffTakeover: false
});
assert(resolved.is_registered === false, 'status Registered alone must not mark contact registered');

console.log('Test F: how do I play is unregistered play intent');
assert(detectUnregisteredPlayIntent('How do I play?'), 'how do I play should match unregistered play intent');

console.log('All support AI registration state tests passed.');
