import { createDataStore } from '../src/db/index.js';

const apply = process.argv.includes('--apply');

const store = await createDataStore();

try {
  const users = await store.listUsers();
  const owned = typeof store.listAllVendorPlayers === 'function'
    ? await store.listAllVendorPlayers()
    : [];
  const ownedContactIds = new Set(owned.map((player) => Number(player.telegram_contact_id)));
  const candidates = [];

  for (const user of users) {
    if (ownedContactIds.has(Number(user.id))) continue;
    if (String(user.registration_status || '') !== 'Registered' && !user.appbeg_account_id) continue;
    const state = await store.getAutomationState(user.id).catch(() => null);
    const info = state?.registration_info || {};
    const playerUid = String(info.appbeg_player_uid || '').trim();
    if (!playerUid) continue;
    candidates.push({
      id: user.id,
      displayName: user.display_name,
      telegramId: user.telegram_id,
      playerUid
    });
  }

  let linked = 0;
  let skipped = 0;
  const details = [];

  for (const candidate of candidates) {
    if (!apply) {
      details.push({ ...candidate, action: 'preview' });
      continue;
    }
    const result = await store.linkVendorPlayerForContact({
      contactId: candidate.id,
      appbegPlayerUid: candidate.playerUid,
      actorName: 'VendorBackfill'
    });
    if (result.linked) linked += 1;
    else skipped += 1;
    details.push({
      ...candidate,
      linked: Boolean(result.linked),
      reason: result.reason,
      vendorCode: result.vendor?.vendor_code || result.mapping?.vendor_code || null
    });
  }

  console.log(JSON.stringify({
    apply,
    candidates: candidates.length,
    linked,
    skipped,
    details
  }, null, 2));
} finally {
  await store.db?.close?.();
}
