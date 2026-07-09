import { createAppBegPlayerViaApi } from '../appbeg/createPlayerClient.js';
import { createReplySender } from '../telegram/messageDelivery.js';

const SUCCESS_MESSAGE = '🎉 Your AppBeg account has been created. Your game usernames are now being prepared by our team.';

function registrationInfoForCreate(info = {}) {
  const username = String(info.preferred_appbeg_username || info.appbeg_username || '').trim();
  const password = String(info.appbeg_password || '').trim();
  const referralCode = String(info.referral_code || info.referralCode || '').trim();

  if (!username) throw new Error('AppBeg username is missing from registration info.');
  if (!password) throw new Error('AppBeg password is missing from registration info.');
  if (!info.ready_to_create_player) throw new Error('Contact is not ready for AppBeg player creation.');
  if (info.appbeg_creation_complete) throw new Error('AppBeg player has already been created for this contact.');

  return { username, password, referralCode: referralCode || null };
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

  console.log(`[ledger] ledger_create_player_requested contact=${id} username=${username}`);

  await store.logEvent({
    telegramUserId: id,
    eventType: 'ledger_create_player_requested',
    title: 'AppBeg Player Creation Requested',
    body: `Staff requested AppBeg player creation for ${username}.`,
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
      ready_to_create_player: false
    };

    const updatedContact = await store.markAppBegPlayerCreated({
      userId: id,
      playerUid: result.playerUid,
      username: result.username || username,
      registrationInfo: nextInfo,
      actorName
    });

    console.log(`[ledger] ledger_create_player_success contact=${id} playerUid=${result.playerUid || 'n/a'}`);

    await store.logEvent({
      telegramUserId: id,
      eventType: 'ledger_create_player_success',
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
    console.log(`[ledger] ledger_create_player_failed contact=${id} error=${error.message}`);

    await store.logEvent({
      telegramUserId: id,
      eventType: 'ledger_create_player_failed',
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
