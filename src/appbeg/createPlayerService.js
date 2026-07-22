import { createAppBegPlayerViaApi } from '../appbeg/createPlayerClient.js';
import { createReplySender } from '../telegram/messageDelivery.js';
import { validateAppBegPassword, validateAppBegUsername } from '../registration/appbegValidation.js';
import { centsToDollars, parseMoneyToCents, registrationCreditCents } from '../registration/utils.js';
import { registeredMenuButtons } from '../telegram/botRegistrationState.js';
import { PAYMENT_WINDOW_FLOW } from '../payments/constants.js';
import { royalVipCredentialSnapshot } from '../telegram/accountView.js';

export const POST_REGISTRATION_READY_MESSAGE = [
  '🎉 Your Royal VIP account is ready!',
  '',
  'Please tap “Royal VIP” below and log in using your Royal VIP username and password.',
  '',
  'After logging in:',
  '• Tap “Play” to access and recharge your games.',
  '• Open “Vault” to view your game usernames and passwords.',
  '• You can manage your games and cash outs directly from Royal VIP.',
  '',
  'To make another deposit later, tap the “Deposit” button here in Telegram and follow the payment instructions.',
  '',
  'Keep your Royal VIP password private.'
].join('\n');

function registrationInfoForCreate(info = {}) {
  const usernameResult = validateAppBegUsername(info.preferred_appbeg_username || info.appbeg_username);
  if (!usernameResult.ok) throw new Error(usernameResult.error);

  const passwordResult = validateAppBegPassword(info.appbeg_password);
  if (!passwordResult.ok) throw new Error(passwordResult.error);

  if (!info.payment_confirmed) {
    throw new Error('Payment has not been confirmed for this registration.');
  }
  if (info.appbeg_creation_complete) {
    throw new Error('AppBeg player has already been created for this contact.');
  }

  const referralCode = String(info.referral_code || info.referralCode || '').trim();

  return {
    username: usernameResult.username,
    password: passwordResult.password,
    referralCode: referralCode || null
  };
}

async function sendTelegramText(store, contact, text, buttons = []) {
  const sendReply = await createReplySender({
    store,
    user: contact,
    bot: globalThis.telegramBot || null
  });
  await sendReply({ user: contact, text, buttons });
}

async function findExistingEquivalentPlayer(username, coadminUid) {
  const appbeg = globalThis.appbegStore;
  if (!appbeg?.configured || typeof appbeg.getPlayerByUsername !== 'function') return null;
  const player = await appbeg.getPlayerByUsername(username);
  if (!player) return null;
  const playerUsername = String(player.username || '').trim().toLowerCase();
  if (playerUsername !== String(username || '').trim().toLowerCase()) return null;
  const playerCoadmin = String(player.coadmin_uid || player.created_by || '').trim();
  if (coadminUid && playerCoadmin && playerCoadmin !== coadminUid) {
    throw new Error('Existing AppBeg player username belongs to a different coadmin.');
  }
  return {
    ok: true,
    playerUid: player.uid || player.player_uid || player.id,
    username: player.username || username,
    resumed: true
  };
}

async function createOrResumeAppBegPlayer({
  info,
  username,
  password,
  referralCode,
  coadminUid,
  ledgerContactId,
  telegramUserId
}) {
  if (info.appbeg_player_uid && !info.appbeg_creation_complete) {
    return {
      ok: true,
      playerUid: info.appbeg_player_uid,
      username: info.preferred_appbeg_username || username,
      resumed: true
    };
  }

  try {
    return await createAppBegPlayerViaApi({
      username,
      password,
      referralCode,
      coadminUid,
      ledgerContactId,
      telegramUserId
    });
  } catch (error) {
    if (!/already|exists|duplicate/i.test(String(error.message || ''))) throw error;
    const existing = await findExistingEquivalentPlayer(username, coadminUid);
    if (!existing?.playerUid) throw error;
    return existing;
  }
}

export async function createAppBegPlayerForContact(store, {
  contactId,
  actorName = 'Staff',
  io = null
}) {
  const id = Number(contactId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid contact id.');

  const contact = await store.getUserProfile(id);
  if (!contact) throw new Error('Contact not found.');

  const automation = await store.getAutomationState(id);
  const info = automation?.registration_info || {};
  const { username, password, referralCode } = registrationInfoForCreate(info);

  const settings = await store.getCoadminSettings();
  const coadminUid = String(
    info?.appbeg_coadmin_uid
    || settings?.appbeg_coadmin_uid
    || ''
  ).trim();
  if (!coadminUid) {
    throw new Error('AppBeg coadmin UID is not configured in Settings.');
  }

  console.log(`[ledger] create_player_requested contact=${id} username=${username}`);

  await store.logEvent({
    telegramUserId: id,
    eventType: 'create_player_requested',
    title: 'AppBeg Player Creation Requested',
    body: `AppBeg player creation requested for ${username}.`,
    actorName,
    metadata: {
      username,
      referralCode,
      coadminUid,
      ledgerContactId: id,
      telegramUserId: contact.telegram_id
    }
  });

  try {
    const result = await createOrResumeAppBegPlayer({
      info,
      username,
      password,
      referralCode,
      coadminUid,
      ledgerContactId: id,
      telegramUserId: contact.telegram_id
    });

    if (result.resumed) {
      console.log(`[ledger] create_player_resumed contact=${id} playerUid=${result.playerUid || 'n/a'}`);
    }

    const nextInfo = royalVipCredentialSnapshot({
      info: {
        ...info,
        preferred_appbeg_username: result.username || username,
        appbeg_player_uid: result.playerUid,
        appbeg_creation_complete: true,
        created_by_coadmin_uid: coadminUid,
        ready_to_create_player: false,
        registration_confirmed: true
      },
      username: result.username || username,
      password,
      playerUid: result.playerUid,
      telegramUserId: contact.telegram_id
    });

    if (typeof store.creditRegisteredDeposit !== 'function') {
      throw new Error('AppBeg deposit credit helper is not available.');
    }

    const windowId = Number(nextInfo.registration_payment_window_id);
    if (!Number.isInteger(windowId) || windowId <= 0) {
      throw new Error('Matched registration payment window is required before creating the account.');
    }
    const window = await store.getRegistrationPaymentWindow(windowId);
    if (!window) throw new Error('Matched registration payment window was not found.');
    if ((window.flow_type || PAYMENT_WINDOW_FLOW.REGISTRATION) !== PAYMENT_WINDOW_FLOW.REGISTRATION) {
      throw new Error('Matched payment window is not a registration payment.');
    }
    if (Number(window.contact_id) !== id) {
      throw new Error('Matched registration payment window belongs to a different contact.');
    }
    if (window.status !== 'matched' && window.status_raw !== 'completed') {
      throw new Error('Registration payment window has not been matched.');
    }
    if (!window.matched_payment_event_id) {
      throw new Error('Registration payment window does not have a matched payment event.');
    }
    const creditCents = window.credited_deposit_cents != null
      ? Number(window.credited_deposit_cents)
      : registrationCreditCents(parseMoneyToCents(String(window.first_deposit_amount)));
    const creditAmount = window.credited_deposit_amount != null
      ? Number(window.credited_deposit_amount)
      : Number(centsToDollars(creditCents));
    if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
      throw new Error('Matched registration payment amount must be positive.');
    }

    console.log(
      `[ledger] registration_credit_started contact=${id} payment=${window.matched_payment_event_id} ` +
      `window=${windowId} player=${result.playerUid || 'n/a'} amount=${creditAmount}`
    );
    await store.creditRegisteredDeposit({
      contactId: id,
      amount: creditAmount,
      paymentEventId: Number(window.matched_payment_event_id),
      windowId,
      actorName,
      flowType: PAYMENT_WINDOW_FLOW.REGISTRATION,
      playerUid: result.playerUid
    });

    const updatedContact = await store.markAppBegPlayerCreated({
      userId: id,
      playerUid: result.playerUid,
      username: result.username || username,
      registrationInfo: nextInfo,
      actorName
    });

    console.log(`[ledger] create_player_success contact=${id} playerUid=${result.playerUid || 'n/a'}`);

    await store.logEvent({
      telegramUserId: id,
      eventType: 'create_player_success',
      title: 'AppBeg Player Created',
      body: `AppBeg player ${result.username || username} created successfully.`,
      actorName,
      metadata: {
        playerUid: result.playerUid,
        username: result.username || username
      }
    });

    try {
      await sendTelegramText(store, contact, POST_REGISTRATION_READY_MESSAGE, registeredMenuButtons());
    } catch (messageError) {
      console.warn('[appbeg-create-player] success message failed:', messageError.message);
    }

    if (io) {
      io.emit('contacts:changed');
      io.emit('users:changed');
      io.emit('contact:changed', { contactId: id, userId: id });
      io.emit('players:changed');
      io.emit('player:updated', { playerId: id });
    }

    return {
      ok: true,
      playerUid: result.playerUid,
      username: result.username || username,
      contact: updatedContact
    };
  } catch (error) {
    console.log(`[ledger] create_player_failed contact=${id} error=${error.message}`);

    await store.logEvent({
      telegramUserId: id,
      eventType: 'create_player_failed',
      title: 'AppBeg Player Creation Failed',
      body: error.message || 'AppBeg player creation failed.',
      actorName,
      metadata: {
        username,
        status: error.status || null
      }
    });
    throw error;
  }
}
