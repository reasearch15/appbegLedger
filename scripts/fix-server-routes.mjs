import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const replacements = [
  ["app.(, async (req, res) => {\n  res.json({\n    ok: true,\n    telegramListenerEnabled:", "app.get('/api/health', async (req, res) => {\n  res.json({\n    ok: true,\n    telegramListenerEnabled:"],
  ["app.(, async (req, res) => {\n  res.json({ users: await store.listUsers() });", "app.get('/api/users', async (req, res) => {\n  res.json({ users: await store.listUsers() });"],
  ["app.(, async (req, res) => {\n  res.json({ contacts: await store.listUsers() });", "app.get('/api/contacts', async (req, res) => {\n  res.json({ contacts: await store.listUsers() });"],
  ["app.(, async (req, res) => {\n  const user = await store.getUserProfile(Number(req.params.id));\n  if (!user) return res.status(404).json({ error: 'User not found.' });", "app.get('/api/users/:id', async (req, res) => {\n  const user = await store.getUserProfile(Number(req.params.id));\n  if (!user) return res.status(404).json({ error: 'User not found.' });"],
  ["app.(, async (req, res) => {\n  const user = await store.getUserProfile(Number(req.params.id));\n  if (!user) return res.status(404).json({ error: 'Contact not found.' });", "app.get('/api/contacts/:id', async (req, res) => {\n  const user = await store.getUserProfile(Number(req.params.id));\n  if (!user) return res.status(404).json({ error: 'Contact not found.' });"],
  ["app.(, async (req, res) => {\n  res.json({ tags: await store.listTags() });", "app.get('/api/tags', async (req, res) => {\n  res.json({ tags: await store.listTags() });"],
  ["app.(, async (req, res) => {\n  res.json({ quickReplies: await store.listQuickReplies() });", "app.get('/api/quick-replies', async (req, res) => {\n  res.json({ quickReplies: await store.listQuickReplies() });"],
  ["app.(, async (req, res) => {\n  res.json({ staff: await store.listStaffAssignees() });", "app.get('/api/staff-assignees', async (req, res) => {\n  res.json({ staff: await store.listStaffAssignees() });"],
  ["app.(, async (req, res) => {\n  res.json({\n    players: await store.listPlayers({", "app.get('/api/players', async (req, res) => {\n  res.json({\n    players: await store.listPlayers({"],
  ["app.(, async (req, res) => {\n  res.json({ stats: await store.getPlayerStats() });", "app.get('/api/players/stats', async (req, res) => {\n  res.json({ stats: await store.getPlayerStats() });"],
  ["app.(, async (req, res) => {\n  const detail = await store.getPlayerDetail(Number(req.params.id));", "app.get('/api/players/:id', async (req, res) => {\n  const detail = await store.getPlayerDetail(Number(req.params.id));"],
  ["app.(, async (req, res) => {\n  res.json({\n    settings: {\n      completionStatus:", "app.get('/api/settings/registration', async (req, res) => {\n  res.json({\n    settings: {\n      completionStatus:"],
  ["app.(, async (req, res) => {\n  res.json({ auditLog: await store.listSettingsAuditLog(", "app.get('/api/settings/audit-log', async (req, res) => {\n  res.json({ auditLog: await store.listSettingsAuditLog("],
  ["app.(, async (req, res) => {\n  try {\n    const duplicateError = await store.checkRegistrationDuplicates({", "app.post('/api/contacts/:id/registration/check-duplicates', async (req, res) => {\n  try {\n    const duplicateError = await store.checkRegistrationDuplicates({"],
  ["app.(, async (req, res) => {\n  try {\n    const contact = await store.manualRegister({", "app.post('/api/contacts/:id/registration/manual', async (req, res) => {\n  try {\n    const contact = await store.manualRegister({"],
  ["app.(, async (req, res) => {\n  try {\n    const contact = await store.updateRegistrationStatus(", "app.patch('/api/contacts/:id/registration-status', async (req, res) => {\n  try {\n    const contact = await store.updateRegistrationStatus("],
  ["app.(, async (req, res) => {\n  res.json({\n    sync: await store.getTelegramAccountSyncState(),", "app.get('/api/telegram-account-sync/status', async (req, res) => {\n  res.json({\n    sync: await store.getTelegramAccountSyncState(),"],
  ["app.(, async (req, res) => {\n  res.json({ sync: await store.getPaymentSyncState() });", "app.get('/api/payment-sync/status', async (req, res) => {\n  res.json({ sync: await store.getPaymentSyncState() });"],
  ["app.(, async (req, res) => {\n  res.json({ stats: await store.getPaymentStats() });", "app.get('/api/payment-stats', async (req, res) => {\n  res.json({ stats: await store.getPaymentStats() });"],
  ["app.(, async (req, res) => {\n  res.json({\n    payments: await store.listPaymentEvents({\n      limit: req.query.limit || 200,\n      status:", "app.get('/api/payments', async (req, res) => {\n  res.json({\n    payments: await store.listPaymentEvents({\n      limit: req.query.limit || 200,\n      status:"],
  ["app.(, async (req, res) => {\n  res.json({\n    payments: await store.listPaymentEvents({\n      limit: req.query.limit || 200,\n      exceptionsOnly: true,", "app.get('/api/payments/exceptions', async (req, res) => {\n  res.json({\n    payments: await store.listPaymentEvents({\n      limit: req.query.limit || 200,\n      exceptionsOnly: true,"],
  ["app.(, async (req, res) => {\n  const payment = await store.getPaymentEvent(Number(req.params.id));", "app.get('/api/payments/:id', async (req, res) => {\n  const payment = await store.getPaymentEvent(Number(req.params.id));"],
  ["app.(, async (req, res) => {\n  res.json({\n    deposits: await store.listDepositEvents({", "app.get('/api/deposit-events', async (req, res) => {\n  res.json({\n    deposits: await store.listDepositEvents({"],
  ["app.(, async (req, res) => {\n  try {\n    const deposit = startDepositEventForContact(store, {", "app.post('/api/contacts/:id/deposit-events', async (req, res) => {\n  try {\n    const deposit = await startDepositEventForContact(store, {"],
  ["app.(, async (req, res) => {\n  try {\n    const deposit = await store.cancelDepositEvent(Number(req.params.id), {", "app.post('/api/deposit-events/:id/cancel', async (req, res) => {\n  try {\n    const deposit = await store.cancelDepositEvent(Number(req.params.id), {"],
  ["app.(, async (req, res) => {\n  try {\n    const user = await store.updateRegistrationStatus(\n      Number(req.params.id),\n      req.body.registrationStatus,\n      req.body.staffName || 'Staff'\n    );\n    if (!user) return res.status(404).json({ error: 'User not found.' });", "app.patch('/api/users/:id/status', async (req, res) => {\n  try {\n    const user = await store.updateRegistrationStatus(\n      Number(req.params.id),\n      req.body.registrationStatus,\n      req.body.staffName || 'Staff'\n    );\n    if (!user) return res.status(404).json({ error: 'User not found.' });"],
  ["app.(, async (req, res) => {\n  try {\n    const contact = await store.updateConversationStatus(", "app.patch('/api/contacts/:id/conversation-status', async (req, res) => {\n  try {\n    const contact = await store.updateConversationStatus("],
  ["app.(, async (req, res) => {\n  const contact = await store.assignConversation(", "app.post('/api/contacts/:id/assign', async (req, res) => {\n  const contact = await store.assignConversation("],
  ["app.(, async (req, res) => {\n  const automationState = await store.cancelAutomationFlow(", "app.post('/api/contacts/:id/automation/cancel', async (req, res) => {\n  const automationState = await store.cancelAutomationFlow("],
  ["app.(, async (req, res) => {\n  const automationState = await store.resetAutomationState(", "app.post('/api/contacts/:id/automation/reset', async (req, res) => {\n  const automationState = await store.resetAutomationState("],
  ["app.(, async (req, res) => {\n  const automationState = await store.updateRegistrationInfo(", "app.patch('/api/contacts/:id/registration-info', async (req, res) => {\n  const automationState = await store.updateRegistrationInfo("],
  ["app.(, async (req, res) => {\n  const automationState = await store.markRegistrationInfoReviewed(", "app.post('/api/contacts/:id/registration-info/review', async (req, res) => {\n  const automationState = await store.markRegistrationInfoReviewed("],
  ["app.(, async (req, res) => {\n  try {\n    const note = await store.addNote(Number(req.params.id), {\n      staffName: req.body.staffName || 'Staff',\n      text: req.body.text ?? req.body.notes\n    });\n    if (!note) return res.status(404).json({ error: 'User not found.' });", "app.post('/api/users/:id/notes', async (req, res) => {\n  try {\n    const note = await store.addNote(Number(req.params.id), {\n      staffName: req.body.staffName || 'Staff',\n      text: req.body.text ?? req.body.notes\n    });\n    if (!note) return res.status(404).json({ error: 'User not found.' });"],
  ["app.(, async (req, res) => {\n  try {\n    const note = await store.addNote(Number(req.params.id), {\n      staffName: req.body.staffName || 'Staff',\n      text: req.body.text\n    });\n    if (!note) return res.status(404).json({ error: 'User not found.' });", "app.post('/api/users/:id/notes-legacy', async (req, res) => {\n  try {\n    const note = await store.addNote(Number(req.params.id), {\n      staffName: req.body.staffName || 'Staff',\n      text: req.body.text\n    });\n    if (!note) return res.status(404).json({ error: 'User not found.' });"],
  ["app.(, async (req, res) => {\n  const user = await store.setUserTags(Number(req.params.id), req.body.tagIds || [], req.body.staffName || 'Staff');\n  if (!user) return res.status(404).json({ error: 'User not found.' });", "app.patch('/api/users/:id/tags', async (req, res) => {\n  const user = await store.setUserTags(Number(req.params.id), req.body.tagIds || [], req.body.staffName || 'Staff');\n  if (!user) return res.status(404).json({ error: 'User not found.' });"],
  ["app.(, async (req, res) => {\n  try {\n    const note = await store.addNote(Number(req.params.id), {\n      staffName: req.body.staffName || 'Staff',\n      text: req.body.text\n    });\n    if (!note) return res.status(404).json({ error: 'Contact not found.' });", "app.post('/api/contacts/:id/notes', async (req, res) => {\n  try {\n    const note = await store.addNote(Number(req.params.id), {\n      staffName: req.body.staffName || 'Staff',\n      text: req.body.text\n    });\n    if (!note) return res.status(404).json({ error: 'Contact not found.' });"],
  ["app.(, async (req, res) => {\n  res.sendFile(path.join(publicDir, 'index.html'));", "app.get('*', (req, res) => {\n  res.sendFile(path.join(publicDir, 'index.html'));"]
];

for (const [from, to] of replacements) {
  if (!source.includes(from)) {
    console.warn('Missing pattern for route fix');
    continue;
  }
  source = source.replace(from, to);
}

source = source.replace(/app\.\(, async/g, 'app.UNFIXED(, async');
const unfixed = (source.match(/app\.UNFIXED/g) || []).length;
if (unfixed) {
  console.warn(`Warning: ${unfixed} routes remain unfixed`);
}

source = source.replace(
  'function coadminSettingsResponse({ settings, backfill = null, auditLog = null, message = null } = {}) {',
  'async function coadminSettingsResponse({ settings, backfill = null, auditLog = null, message = null } = {}) {'
);
source = source.replace(
  'function handleCoadminSettingsGet(req, res) {',
  'async function handleCoadminSettingsGet(req, res) {'
);
source = source.replace(
  'function handleCoadminSettingsSave(req, res) {',
  'async function handleCoadminSettingsSave(req, res) {'
);
source = source.replace(
  'function handleCoadminSettingsApply(req, res) {',
  'async function handleCoadminSettingsApply(req, res) {'
);
source = source.replace(
  'return coadminSettingsResponse(',
  'return await coadminSettingsResponse('
);

fs.writeFileSync(target, source);
console.log('Fixed server routes.');
