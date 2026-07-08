import {
  normalizeAppBegUsername,
  normalizePaymentTag,
  registrationCompletionStatus,
  WELCOME_BUTTONS,
  WELCOME_MESSAGE,
  welcomeCooldownMs,
  isUnregisteredStatus
} from '../registration/utils.js';
import { buildMenu } from './menuEngine.js';

const REGISTRATION_STEPS = ['appbeg_username', 'payment_tag', 'confirm'];

const STEP_PROMPTS = {
  appbeg_username: 'What is your AppBeg username?',
  payment_tag: 'What payment name/tag should we use for you?'
};

const STEP_FIELDS = {
  appbeg_username: 'preferred_appbeg_username',
  payment_tag: 'payment_tag'
};

export async function handleIncomingAutomation({ sendReply, store, user, message, inserted }) {
  if (!inserted || !message?.text) return { handled: false };

  await store.ensureAutomationState(user.id);
  const automationState = await store.getAutomationState(user.id);
  if (automationState?.current_flow === 'registration_info') {
    return await continueRegistrationFlow({ sendReply, store, user, message, automationState });
  }

  const ruleMatch = findMatchingRule(await store.listAutomationRules(), user, message.text);
  if (ruleMatch) {
    return await executeRule({ sendReply, store, user, message, rule: ruleMatch.rule, matchedKeyword: ruleMatch.keyword });
  }

  await store.logAutomationDecision({
    userId: user.id,
    incomingTelegramMessageId: message.message_id,
    actionTaken: 'no_match',
    metadata: { text: message.text }
  });

  if (isUnregisteredStatus(user.registration_status) && await canSendAutoWelcome(store, user.id)) {
    return await sendWelcomeRegisterPrompt({ sendReply, store, user, message, reason: 'catch_all' });
  }

  return { handled: false };
}

export async function handleAutomationAction({ sendReply, store, user, action }) {
  const state = await store.ensureAutomationState(user.id);

  if (action === 'nav:cancel' && state.current_flow) {
    await store.cancelAutomationFlow(user.id, 'Bot');
    const response = 'Registration was canceled. You can tap Register anytime to start again.';
    await sendAutomationText({ sendReply, store, user, response });
    await store.logAutomationDecision({
      userId: user.id,
      actionTaken: 'flow_canceled',
      responseSent: response,
      metadata: { action }
    });
    return { handled: true };
  }

  if (action === 'flow:registration_info') {
    return await startRegistrationFlow({ sendReply, store, user, actorName: 'Bot' });
  }

  if (action === 'flow:registration_confirm') {
    return await completeRegistrationFlow({ sendReply, store, user, actorName: 'Bot' });
  }

  if (action === 'flow:registration_edit_appbeg') {
    await store.updateAutomationState(user.id, { currentFlow: 'registration_info', currentStep: 'appbeg_username' });
    const response = STEP_PROMPTS.appbeg_username;
    await sendAutomationText({
      sendReply,
      store,
      user,
      response,
      buttons: [[{ label: 'Cancel', action: 'nav:cancel' }]]
    });
    return { handled: true };
  }

  if (action === 'flow:registration_edit_payment') {
    await store.updateAutomationState(user.id, { currentFlow: 'registration_info', currentStep: 'payment_tag' });
    const response = STEP_PROMPTS.payment_tag;
    await sendAutomationText({
      sendReply,
      store,
      user,
      response,
      buttons: [[{ label: 'Cancel', action: 'nav:cancel' }]]
    });
    return { handled: true };
  }

  if (action?.startsWith('keyword:')) {
    const keyword = action.slice('keyword:'.length);
    const ruleMatch = findMatchingRule(await store.listAutomationRules(), user, keyword);
    if (ruleMatch) {
      return await executeRule({
        sendReply,
        store,
        user,
        message: { text: keyword, message_id: null },
        rule: ruleMatch.rule,
        matchedKeyword: ruleMatch.keyword
      });
    }
  }

  return null;
}

export async function startRegistrationFlow({ sendReply, store, user, actorName = 'Bot' }) {
  await store.assignCoadminToUser(user.id, actorName);
  const telegramSnapshot = {
    telegram_user_id: user.telegram_id,
    telegram_username: user.username || null,
    telegram_display_name: user.display_name,
    telegram_phone: user.phone_number || null,
    registration_method: 'telegram'
  };
  const state = await store.startAutomationFlow(user.id, 'registration_info', actorName);
  await store.updateRegistrationInfo(user.id, { ...telegramSnapshot, ...(state.registration_info || {}) }, actorName);
  const response = STEP_PROMPTS.appbeg_username;
  await sendAutomationText({
    sendReply,
    store,
    user,
    response,
    buttons: [[{ label: 'Cancel', action: 'nav:cancel' }]]
  });
  await store.updateAutomationState(user.id, {
    lastAutomationResponse: response,
    lastAutomationAt: new Date().toISOString()
  });
  await store.logAutomationDecision({
    userId: user.id,
    actionTaken: 'start_flow',
    responseSent: response,
    metadata: { flowKey: 'registration_info', step: 'appbeg_username' }
  });
  return { handled: true };
}

async function continueRegistrationFlow({ sendReply, store, user, message, automationState }) {
  const text = String(message.text || '').trim();
  if (['cancel', '/cancel'].includes(text.toLowerCase())) {
    await store.cancelAutomationFlow(user.id, 'Bot');
    const response = 'Registration was canceled. You can tap Register anytime to start again.';
    await sendAutomationText({ sendReply, store, user, response });
    await store.logAutomationDecision({
      userId: user.id,
      incomingTelegramMessageId: message.message_id,
      actionTaken: 'flow_canceled',
      responseSent: response
    });
    return { handled: true };
  }

  const step = automationState.current_step || REGISTRATION_STEPS[0];
  if (step === 'confirm') {
    const response = buildConfirmSummary(user, automationState.registration_info);
    await sendAutomationText({
      sendReply,
      store,
      user,
      response,
      buttons: confirmButtons()
    });
    return { handled: true };
  }

  const field = STEP_FIELDS[step];
  const registrationInfo = { ...(automationState.registration_info || {}) };
  registrationInfo[field] = text;
  if (field === 'payment_tag') {
    registrationInfo.payment_tag_normalized = normalizePaymentTag(text);
  }
  if (field === 'preferred_appbeg_username') {
    registrationInfo.preferred_appbeg_username_normalized = normalizeAppBegUsername(text);
  }

  const duplicateError = await store.checkRegistrationDuplicates({
    appbegUsername: registrationInfo.preferred_appbeg_username,
    paymentTag: registrationInfo.payment_tag,
    excludeUserId: user.id
  });
  if (duplicateError) {
    await sendAutomationText({ sendReply, store, user, response: duplicateError });
    return { handled: true };
  }

  await store.updateRegistrationInfo(user.id, registrationInfo, 'Automation');

  const currentIndex = REGISTRATION_STEPS.indexOf(step);
  const nextStep = REGISTRATION_STEPS[currentIndex + 1] || null;
  if (nextStep === 'confirm') {
    const response = buildConfirmSummary(user, registrationInfo);
    await store.updateAutomationState(user.id, {
      currentFlow: 'registration_info',
      currentStep: 'confirm',
      registrationInfo,
      lastAutomationResponse: response,
      lastAutomationAt: new Date().toISOString()
    });
    await sendAutomationText({ sendReply, store, user, response, buttons: confirmButtons() });
    await store.logAutomationDecision({
      userId: user.id,
      incomingTelegramMessageId: message.message_id,
      actionTaken: 'flow_step_saved',
      responseSent: response,
      metadata: { flowKey: 'registration_info', savedField: field, nextStep: 'confirm' }
    });
    return { handled: true };
  }

  if (nextStep) {
    const response = STEP_PROMPTS[nextStep];
    await store.updateAutomationState(user.id, {
      currentFlow: 'registration_info',
      currentStep: nextStep,
      registrationInfo,
      lastAutomationResponse: response,
      lastAutomationAt: new Date().toISOString()
    });
    await sendAutomationText({
      sendReply,
      store,
      user,
      response,
      buttons: [[{ label: 'Cancel', action: 'nav:cancel' }]]
    });
    await store.logAutomationDecision({
      userId: user.id,
      incomingTelegramMessageId: message.message_id,
      actionTaken: 'flow_step_saved',
      responseSent: response,
      metadata: { flowKey: 'registration_info', savedField: field, nextStep }
    });
    return { handled: true };
  }

  return await completeRegistrationFlow({ sendReply, store, user, actorName: 'Automation', registrationInfo });
}

async function completeRegistrationFlow({ sendReply, store, user, actorName = 'Automation', registrationInfo = null }) {
  const state = await store.getAutomationState(user.id);
  const info = registrationInfo || state?.registration_info || {};
  const duplicateError = await store.checkRegistrationDuplicates({
    appbegUsername: info.preferred_appbeg_username,
    paymentTag: info.payment_tag,
    excludeUserId: user.id
  });
  if (duplicateError) {
    await sendAutomationText({ sendReply, store, user, response: duplicateError });
    return { handled: true };
  }

  const completionStatus = registrationCompletionStatus();
  await store.completeRegistration({
    userId: user.id,
    registrationInfo: info,
    registrationStatus: completionStatus,
    registrationMethod: 'telegram',
    actorName
  });

  const response = completionStatus === 'Registered'
    ? 'You are now registered with Royal VIP. Welcome!'
    : 'Your registration details were saved. A staff member will review them soon.';
  await store.updateAutomationState(user.id, {
    currentFlow: null,
    currentStep: null,
    registrationInfo: info,
    lastAutomationResponse: response,
    lastAutomationAt: new Date().toISOString()
  });
  await sendAutomationText({ sendReply, store, user, response });
  await store.logAutomationDecision({
    userId: user.id,
    actionTaken: 'flow_completed',
    responseSent: response,
    metadata: { flowKey: 'registration_info', completionStatus }
  });
  return { handled: true };
}

async function sendWelcomeRegisterPrompt({ sendReply, store, user, message, reason = 'keyword' }) {
  await store.markAutoWelcomeSent(user.id);
  await sendAutomationText({
    sendReply,
    store,
    user,
    response: WELCOME_MESSAGE,
    buttons: WELCOME_BUTTONS
  });
  await store.logAutomationDecision({
    userId: user.id,
    incomingTelegramMessageId: message?.message_id,
    actionTaken: reason === 'catch_all' ? 'auto_welcome_catch_all' : 'auto_welcome',
    responseSent: WELCOME_MESSAGE,
    metadata: { reason }
  });
  return { handled: true };
}

async function executeRule({ sendReply, store, user, message, rule, matchedKeyword }) {
  if (rule.intent_key) {
    await store.setAutomationIntent(user.id, rule.intent_key, true);
  }
  if (rule.conversation_status) {
    await store.updateConversationStatus(user.id, rule.conversation_status, 'Automation');
  }
  await store.updateAutomationState(user.id, {
    lastMatchedKeyword: matchedKeyword,
    lastRuleId: rule.id,
    lastAutomationResponse: rule.response_message,
    lastAutomationAt: new Date().toISOString()
  });

  if (rule.response_type === 'start_flow' && rule.flow_key === 'registration_info') {
    await store.logAutomationDecision({
      userId: user.id,
      incomingTelegramMessageId: message.message_id,
      matchedKeyword,
      rule,
      actionTaken: 'start_flow',
      responseSent: rule.response_message,
      metadata: { flowKey: rule.flow_key }
    });
    return await startRegistrationFlow({ sendReply, store, user, actorName: 'Automation' });
  }

  let response = rule.response_message || '';
  let buttons = rule.buttons || [];
  if (rule.response_type === 'menu') {
    if (rule.name === 'Guest Welcome' || (isUnregisteredStatus(user.registration_status) && !response)) {
      if (!(await canSendAutoWelcome(store, user.id))) {
        return { handled: true };
      }
      await store.markAutoWelcomeSent(user.id);
      response = WELCOME_MESSAGE;
      buttons = WELCOME_BUTTONS;
    } else if (!response) {
      const menu = buildMenu({ screenName: 'Home', registered: user.registration_status === 'Registered' });
      response = menu.text;
    }
  }

  await sendAutomationText({
    sendReply,
    store,
    user,
    response,
    buttons,
    messageType: buttons?.length ? 'buttons' : 'text'
  });
  await store.logAutomationDecision({
    userId: user.id,
    incomingTelegramMessageId: message.message_id,
    matchedKeyword,
    rule,
    actionTaken: rule.response_type,
    responseSent: response,
    metadata: { intentKey: rule.intent_key || null }
  });
  return { handled: true };
}

async function sendAutomationText({ sendReply, store, user, response, buttons = [], messageType = 'text' }) {
  await sendReply({ user, text: response, buttons, messageType });
}

function buildConfirmSummary(user, registrationInfo = {}) {
  const username = registrationInfo.telegram_username ? `@${registrationInfo.telegram_username}` : 'Not set';
  return [
    'Please confirm your registration details:',
    '',
    `Telegram: ${registrationInfo.telegram_display_name || user.display_name}`,
    `Username: ${username}`,
    `Telegram ID: ${registrationInfo.telegram_user_id || user.telegram_id}`,
    `Phone: ${registrationInfo.telegram_phone || user.phone_number || 'Not provided'}`,
    `AppBeg username: ${registrationInfo.preferred_appbeg_username || 'Not set'}`,
    `Payment name/tag: ${registrationInfo.payment_tag || 'Not set'}`
  ].join('\n');
}

function confirmButtons() {
  return [
    [{ label: 'Confirm', action: 'flow:registration_confirm' }],
    [{ label: 'Edit AppBeg Username', action: 'flow:registration_edit_appbeg' }, { label: 'Edit Payment Tag', action: 'flow:registration_edit_payment' }],
    [{ label: 'Cancel', action: 'nav:cancel' }]
  ];
}

async function canSendAutoWelcome(store, userId) {
  const state = await store.getAutomationState(userId);
  if (!state?.last_auto_welcome_at) return true;
  const elapsed = Date.now() - new Date(state.last_auto_welcome_at).getTime();
  return elapsed >= welcomeCooldownMs();
}

function findMatchingRule(rules, user, rawText) {
  const text = normalize(rawText);
  const status = normalizeStatus(user.registration_status);
  for (const rule of rules) {
    if (!statusMatches(rule.contact_status_condition, status)) continue;
    for (const keyword of rule.keywords) {
      const normalizedKeyword = normalize(keyword);
      if (
        (rule.match_type === 'exact' && text === normalizedKeyword) ||
        (rule.match_type === 'contains' && text.includes(normalizedKeyword)) ||
        (rule.match_type === 'starts_with' && text.startsWith(normalizedKeyword))
      ) {
        return { rule, keyword };
      }
    }
  }
  return null;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeStatus(status) {
  const normalized = normalize(status).replace(/\s+/g, '_');
  if (normalized === 'pending_verification' || normalized === 'pending') return 'pending';
  if (normalized === 'collecting_info') return 'collecting';
  if (normalized === 'new') return 'new';
  if (normalized === 'registered') return 'registered';
  if (normalized === 'suspended') return 'suspended';
  return normalized;
}

function statusMatches(condition, status) {
  const normalizedCondition = normalize(condition);
  if (normalizedCondition === 'any') return true;
  if (normalizedCondition === 'new') return status === 'new' || status === 'collecting';
  if (normalizedCondition === 'pending') return status === 'pending';
  return normalizedCondition === status;
}
