import { paymentAppsMatch, paymentNamesMatch } from './matchUtils.js';

function playerPaymentApp(info = {}) {
  return info.payment_method_name || info.payment_app || info.preferred_game || '';
}

export function registeredPlayerMatchesParsed(player, parsed) {
  if (!player || player.registration_status !== 'Registered') return false;
  const info = player.registration_info || {};
  const savedApp = playerPaymentApp(info);
  const parsedApp = parsed.payment_app;

  if (savedApp && parsedApp && !paymentAppsMatch(savedApp, parsedApp)) {
    return false;
  }

  if (info.payment_display_name && paymentNamesMatch(info.payment_display_name, parsed.payment_sender_name)) {
    return true;
  }

  if (info.payment_tag && paymentNamesMatch(info.payment_tag, parsed.payment_sender_name)) {
    return true;
  }

  return false;
}

export async function findRegisteredPlayerMatch(store, parsed) {
  const players = await store.listRegisteredPlayersForPaymentMatch();
  const matches = players.filter((player) => registeredPlayerMatchesParsed(player, parsed));
  if (!matches.length) return null;
  return matches[0];
}
