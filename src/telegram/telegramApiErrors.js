export function telegramErrorText(error) {
  return String(
    error?.description
    || error?.response?.description
    || error?.message
    || error
    || ''
  );
}

export function isMessageNotModifiedError(error) {
  return /message is not modified/i.test(telegramErrorText(error));
}

export function isMessageNotFoundError(error) {
  return /message to edit not found|message to be edited not found|message not found|message to delete not found/i
    .test(telegramErrorText(error));
}

export function isTopicClosedError(error) {
  return /TOPIC_CLOSED|topic is closed|forum topic is closed/i.test(telegramErrorText(error));
}

export function isPermissionDeniedError(error) {
  return /not enough rights|CHAT_WRITE_FORBIDDEN|have no rights|bot is not a member|bot was kicked|forbidden|unauthorized/i
    .test(telegramErrorText(error));
}

export function isAlreadyPinnedError(error) {
  return /CHAT_NOT_MODIFIED|already pinned|message is already pinned/i.test(telegramErrorText(error));
}

export function isChatNotFoundError(error) {
  return /chat not found|chat_id is empty/i.test(telegramErrorText(error));
}
