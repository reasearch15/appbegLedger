import { isUnregisteredStatus } from '../registration/utils.js';

function looksLikePlayerUid(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text === String(value) && /^[A-Za-z0-9_-]{8,}$/.test(text)) return true;
  return text.length >= 12;
}

export async function resolveSupportAiRegistrationState({
  contact,
  info = {},
  flow = null,
  step = null,
  paymentWindow = null,
  manualStaffTakeover = false
}) {
  const appbegPlayerUid = info.appbeg_player_uid || contact.appbeg_account_id || null;
  const appbegUsername = info.preferred_appbeg_username || null;
  const linkStatus = String(contact.appbeg_link_status || '').trim().toLowerCase() || null;
  const statusSaysRegistered = contact.registration_status === 'Registered';
  const creationComplete = Boolean(info.appbeg_creation_complete);
  const hasValidUid = looksLikePlayerUid(appbegPlayerUid);

  let appbegPlayerExists = false;
  let accountStatus = 'unknown';

  if (hasValidUid && globalThis.appbegStore?.configured && globalThis.appbegStore.getPlayerByUid) {
    try {
      const player = await globalThis.appbegStore.getPlayerByUid(appbegPlayerUid);
      appbegPlayerExists = Boolean(player);
      if (player?.status === 'suspended' || contact.registration_status === 'Suspended') {
        accountStatus = 'suspended';
      } else if (player) {
        accountStatus = 'active';
      }
    } catch {
      appbegPlayerExists = false;
    }
  } else if (contact.registration_status === 'Suspended') {
    accountStatus = 'suspended';
  }

  const isLinked = linkStatus === 'linked'
    || (hasValidUid && appbegPlayerExists)
    || (hasValidUid && creationComplete);
  const isRegistered = hasValidUid && (isLinked || appbegPlayerExists || (creationComplete && statusSaysRegistered));
  const registrationStatusConflict = statusSaysRegistered && !isRegistered;

  let registrationState = 'unregistered';
  if (manualStaffTakeover) {
    registrationState = 'manual_staff_takeover';
  } else if (isRegistered) {
    registrationState = 'registered';
  } else if (creationComplete || (statusSaysRegistered && hasValidUid)) {
    registrationState = 'registration_complete_but_not_linked';
  } else if (flow === 'bot_registration' && step && step !== 'welcome') {
    registrationState = 'registration_in_progress';
  } else if (!isUnregisteredStatus(contact.registration_status) && contact.registration_status !== 'New') {
    registrationState = 'registration_in_progress';
  } else if (paymentWindow?.status === 'expired' && !info.payment_confirmed) {
    registrationState = 'registration_in_progress';
  } else {
    registrationState = 'unregistered';
  }

  console.log(`[support-ai] support_ai_registration_state_resolved contact=${contact.id} state=${registrationState} is_registered=${isRegistered} uid=${appbegPlayerUid || 'none'} link=${linkStatus || 'none'} player_exists=${appbegPlayerExists}`);
  if (registrationStatusConflict) {
    console.log(`[support-ai] support_ai_registration_state_conflict contact=${contact.id} registration_status=${contact.registration_status} is_registered=${isRegistered} uid=${appbegPlayerUid || 'none'}`);
  }
  if (isRegistered) {
    console.log(`[support-ai] support_ai_registered_context_loaded contact=${contact.id} username=${appbegUsername || 'n/a'} uid=${appbegPlayerUid || 'n/a'} account_status=${accountStatus}`);
  } else {
    console.log(`[support-ai] support_ai_unregistered_context_loaded contact=${contact.id} registration_status=${contact.registration_status || 'New'} step=${step || 'none'}`);
  }

  return {
    is_registered: isRegistered,
    was_registered: isRegistered,
    registration_state: registrationState,
    appbeg_player_uid: hasValidUid ? appbegPlayerUid : null,
    appbeg_username: appbegUsername,
    appbeg_link_status: contact.appbeg_link_status || null,
    account_status: accountStatus,
    registration_status: contact.registration_status || 'New',
    registration_step: step || null,
    appbeg_player_exists: appbegPlayerExists,
    registration_status_conflict: registrationStatusConflict,
    account_creation_complete: creationComplete && isRegistered
  };
}

export function formatSupportAiRegistrationPromptRules(contactContext = {}) {
  const registered = Boolean(contactContext.is_registered ?? contactContext.was_registered);
  const lines = [
    `is_registered: ${registered ? 'true' : 'false'}`,
    `registration_state: ${contactContext.registration_state || contactContext.registration_phase || 'unknown'}`,
    `appbeg_player_uid: ${contactContext.appbeg_player_uid || 'not linked'}`,
    `appbeg_username: ${contactContext.appbeg_username || 'not set'}`,
    `registration_status: ${contactContext.registration_status || 'unknown'}`,
    `registration_step: ${contactContext.current_step || contactContext.registration_step || 'none'}`,
    `account_status: ${contactContext.account_status || 'unknown'}`,
    '',
    'Draft rules:',
    registered
      ? '- Customer is a registered AppBeg player. Never offer new registration. Never ask them to create another account. Answer as an existing player (login, play, load coin, cashout, bonus, account help).'
      : '- Customer is not registered in AppBeg. Registration guidance is allowed. Use the deterministic registration flow when relevant.',
    registered
      ? '- If they ask to register again, explain they already have an account and offer login or account help.'
      : '- If they want to play, guide them through registration first.'
  ];
  return lines.join('\n');
}
