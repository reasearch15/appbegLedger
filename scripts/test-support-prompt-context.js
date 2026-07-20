import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDataStore } from '../src/db/index.js';
import { generateCustomerSupportReply } from '../src/telegram/customerSupportAi.js';
import { buildSupportContext } from '../src/telegram/supportContext.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'appbeg-support-context-'));
const store = await createDataStore({ dialect: 'sqlite', databasePath: path.join(dir, 'test.sqlite') });

const guest = await store.upsertTelegramUser({
  id: 88101,
  first_name: 'Guest',
  username: 'guest_context',
  is_bot: false
});
await store.ensureAutomationState(guest.id);

const guestContext = await buildSupportContext({ store, contact: guest });
assert.equal(guestContext.registration.isRegistered, false);
assert.equal(guestContext.contact.telegramId, 88101);
assert.equal(Array.isArray(guestContext.conversation.recentMessages), true);

const customPrompt = 'Use short Royal VIP support replies. Never invent payment status.';
const savedPrompt = await store.updateCustomerSupportPrompt(customPrompt, 'Tester');
assert.equal(savedPrompt.prompt, customPrompt);

const guestReply = await generateCustomerSupportReply({
  store,
  contact: guest,
  messageText: 'How do I register?'
});
assert.match(guestReply.aiRequest, /SYSTEM POLICY/);
assert.match(guestReply.aiRequest, /BUSINESS SUPPORT PROMPT/);
assert.match(guestReply.aiRequest, /VERIFIED APPLICATION CONTEXT/);
assert.match(guestReply.aiRequest, /CURRENT USER MESSAGE/);
assert.match(guestReply.aiRequest, /Use short Royal VIP support replies/);
assert.equal(guestReply.verifiedContext.registration.isRegistered, false);

const registered = await store.upsertTelegramUser({
  id: 88102,
  first_name: 'Registered',
  username: 'registered_context',
  is_bot: false
});
await store.db.prepare(`
  UPDATE telegram_users
  SET registration_status = 'Registered',
      appbeg_account_id = 'playeruid123456',
      appbeg_link_status = 'linked'
  WHERE id = ?
`).run(registered.id);
await store.ensureAutomationState(registered.id);
const previousAppBegStore = globalThis.appbegStore;
globalThis.appbegStore = {
  configured: true,
  async getPlayerByUid() {
    return { uid: 'playeruid123456', status: 'active', username: 'RoyalUser01' };
  }
};
const registeredContact = await store.getUserProfile(registered.id);
const registeredContext = await buildSupportContext({ store, contact: registeredContact });
assert.equal(registeredContext.registration.isRegistered, true);
assert.equal(registeredContext.player.exists, true);
globalThis.appbegStore = previousAppBegStore;

await store.close?.();
console.log('ok support prompt and verified context are built correctly');
