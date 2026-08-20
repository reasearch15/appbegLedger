/**
 * Public Royal VIP Hub is a storefront only.
 *
 * PLAY     -> https://t.me/<BOT_USERNAME>?start=play
 * FREEPLAY -> https://t.me/<BOT_USERNAME>?start=freeplay
 *
 * AppbegLedger may create/edit the canonical storefront post in the configured
 * Hub channel. Do not put payment, Confidence Mode, Staff Management, or
 * conversations in the public channel. Identity always comes from ctx.from.id.
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

export const ROYAL_VIP_HUB_STOREFRONT_TEXT = [
  '👑 ROYAL VIP HUB',
  'Play, deposit, request Freeplay and contact Royal VIP through our official bot.'
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
