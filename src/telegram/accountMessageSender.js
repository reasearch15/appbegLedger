export function sendViaBusinessAccount() {
  throw new Error('Direct Telethon sends are disabled. Queue business account messages through telegram_outbound_messages.');
}
