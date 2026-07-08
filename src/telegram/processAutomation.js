import { createReplySender } from './messageDelivery.js';
import { handleAutomationAction, handleIncomingAutomation } from './automationEngine.js';

export async function processAutomationForContact({
  store,
  user,
  message,
  inserted = true,
  rootDir,
  bot,
  io
}) {
  if (!inserted || !message?.text) return { handled: false };
  const sendReply = await createReplySender({ store, user, rootDir, bot });
  const result = await handleIncomingAutomation({
    sendReply,
    store,
    user,
    message,
    inserted
  });
  if (result?.handled) {
    emitAutomationUpdates(io, user);
  }
  return result;
}

export async function processAutomationActionForContact({
  store,
  user,
  action,
  rootDir,
  bot,
  io
}) {
  const sendReply = await createReplySender({ store, user, rootDir, bot });
  const result = await handleAutomationAction({ sendReply, store, user, action });
  if (result?.handled) {
    emitAutomationUpdates(io, user);
  }
  return result;
}

function emitAutomationUpdates(io, user) {
  io.emit('message:new', { userId: user.id, contactId: user.id, telegramId: user.telegram_id });
  io.emit('contacts:changed');
  io.emit('users:changed');
  io.emit('players:changed');
}
