import { createAppBegPlayerViaApi } from '../appbeg/createPlayerClient.js';
import { createReplySender } from '../telegram/messageDelivery.js';
import { validateAppBegPassword, validateAppBegUsername } from '../registration/appbegValidation.js';

const SUCCESS_MESSAGE = '🎉 Your AppBeg account has been created. Your game usernames are now being prepared by our team.';

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

async function sendTelegramText(store, contact, text) {
  const sendReply = await createReplySender({
    store,
    user: contact,
    bot: globalThis.telegramBot || null
  });
  await sendReply({ user: contact, text });
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
  const coadminUid = String(settings?.appbeg_coadmin_uid || '').trim();
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
    const result = await createAppBegPlayerViaApi({
      username,
      password,
      referralCode,
      coadminUid,
      ledgerContactId: id,
      telegramUserId: contact.telegram_id
    });

    const nextInfo = {
      ...info,
      preferred_appbeg_username: result.username || username,
      appbeg_player_uid: result.playerUid,
      appbeg_creation_complete: true,
      created_by_coadmin_uid: coadminUid,
      ready_to_create_player: false,
      registration_confirmed: true
    };

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
      await sendTelegramText(store, contact, SUCCESS_MESSAGE);
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
