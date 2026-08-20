/**
 * Public Royal VIP Hub is a storefront only.
 *
 * PLAY        -> https://t.me/<BOT_USERNAME>?start=play
 * FREEPLAY    -> https://t.me/<BOT_USERNAME>?start=freeplay
 *
 * Private support uses native Channel Direct Messages on Royal Vip Hub.
 * `/start support` remains a private-bot fallback/deep-link. Do not put
 * payment, Confidence Mode, Staff Management, or conversations in the
 * public channel.
 */
export function royalVipBotDeepLinks(botUsername) {
  const username = String(botUsername || '').replace(/^@/, '').trim();
  if (!username) {
    return {
      play: null,
      support: null,
      freeplay: null
    };
  }
  return {
    play: `https://t.me/${username}?start=play`,
    support: `https://t.me/${username}?start=support`,
    freeplay: `https://t.me/${username}?start=freeplay`
  };
}

export const ROYAL_VIP_HUB_STOREFRONT_TEXT = [
  '👑 ROYAL VIP HUB',
  'Play or request Freeplay below.',
  'Message Royal Vip Hub directly for private support.'
].join('\n');

export function royalVipHubStorefrontMarkup(botUsername) {
  const links = royalVipBotDeepLinks(botUsername);
  if (!links.play || !links.freeplay) return null;
  return {
    inline_keyboard: [
      [{ text: '🔴 PLAY', url: links.play }],
      [{ text: '🎁 FREEPLAY', url: links.freeplay }]
    ]
  };
}
