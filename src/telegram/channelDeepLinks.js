/**
 * Public Royal VIP channel is a storefront only.
 * After deploy, add these URL buttons on the channel (manual Telegram setup):
 *
 *   PLAY     -> https://t.me/<BOT_USERNAME>?start=play
 *   FREEPLAY -> https://t.me/<BOT_USERNAME>?start=freeplay
 *
 * Do not put payment, Confidence Mode, Staff Management, or conversations
 * in the public channel. Identity always comes from ctx.from.id.
 */
export function royalVipBotDeepLinks(botUsername) {
  const username = String(botUsername || '').replace(/^@/, '').trim();
  if (!username) {
    return {
      play: null,
      freeplay: null
    };
  }
  return {
    play: `https://t.me/${username}?start=play`,
    freeplay: `https://t.me/${username}?start=freeplay`
  };
}
