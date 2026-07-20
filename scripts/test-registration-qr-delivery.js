import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideBotReply } from '../src/telegram/chatbotEngine.js';
import { handlePaymentRegistrationQr } from '../src/telegram/registrationQrSend.js';
import {
  paymentQrCaption,
  resolvePaymentQrTelegramInput
} from '../src/payments/methodUtils.js';
import { createBotPhotoSender } from '../src/telegram/messageDelivery.js';

function createTempPng() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-qr-'));
  const filePath = path.join(dir, 'qr.png');
  fs.writeFileSync(filePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ));
  return { dir, filePath };
}

function createQrStore({
  methods = [{ id: 1, name: 'Chime', key: 'chime' }],
  qrsByMethod = {
    1: [{ id: 10, file_path: null, is_active: true, is_default: true, updated_at: '2026-01-02T00:00:00.000Z' }]
  },
  activeWindow = null
} = {}) {
  let window = activeWindow;
  let windowsCreated = 0;
  let status = 'Collecting Info';
  let state = {
    current_flow: 'bot_registration',
    current_step: 'first_deposit_amount',
    registration_info: {
      payment_name: 'Amy fei',
      payment_display_name: 'Amy fei',
      first_deposit_amount: 9
    }
  };
  const outgoing = [];

  return {
    methods,
    outgoing,
    get windowsCreated() { return windowsCreated; },
    get status() { return status; },
    get state() { return state; },
    async listActivePaymentMethodsForRegistration() {
      return methods;
    },
    async getActiveDefaultPaymentQr(methodId) {
      const list = (qrsByMethod[methodId] || []).filter((q) => q.is_active && q.is_default && q.file_path);
      return list.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
    },
    async getNewestActivePaymentQr(methodId) {
      const list = (qrsByMethod[methodId] || []).filter((q) => q.is_active && q.file_path);
      return list.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
    },
    async getActivePaymentQrForRegistration(methodId) {
      return (await this.getActiveDefaultPaymentQr(methodId))
        || (await this.getNewestActivePaymentQr(methodId));
    },
    async getRegistrationDefaultPaymentQr() {
      for (const method of methods) {
        const qr = await this.getActivePaymentQrForRegistration(method.id);
        if (qr?.file_path) {
          return {
            paymentMethodId: method.id,
            paymentMethodName: method.name,
            paymentMethodKey: method.key,
            qr
          };
        }
      }
      return null;
    },
    async getActiveRegistrationPaymentWindow() {
      return window;
    },
    async createRegistrationPaymentWindow(payload) {
      windowsCreated += 1;
      window = {
        id: 100 + windowsCreated,
        status: 'active',
        flow_type: payload.flowType || 'registration',
        expires_at: new Date(Date.now() + 7 * 60 * 1000).toISOString(),
        ...payload
      };
      return window;
    },
    async getAutomationState() {
      return { ...state, registration_info: { ...state.registration_info } };
    },
    async ensureAutomationState() {
      return this.getAutomationState();
    },
    async updateAutomationState(contactId, patch) {
      if (patch.currentStep !== undefined) state.current_step = patch.currentStep;
      if (patch.currentFlow !== undefined) state.current_flow = patch.currentFlow;
      if (patch.registrationInfo) {
        state.registration_info = { ...state.registration_info, ...patch.registrationInfo };
      }
      return this.getAutomationState();
    },
    async updateRegistrationStatus(_id, next) {
      status = next;
    },
    async storeOutgoingMessage(payload) {
      outgoing.push(payload);
      return payload;
    },
    async getContactPreferredMessageSource() {
      return 'bot_api';
    }
  };
}

async function run() {
  console.log('Registration QR delivery tests');

  const { filePath } = createTempPng();
  const relativePath = path.relative(process.cwd(), filePath).split(path.sep).join('/');

  // Caption includes payment name + $amount
  const caption = paymentQrCaption({
    paymentMethodName: 'Chime',
    firstDepositAmount: 9,
    paymentDisplayName: 'Amy fei'
  });
  assert.match(caption, /Please send \$9 using the QR code above/);
  assert.match(caption, /Payment Name: Amy fei/);
  assert.match(caption, /Amount: \$9/);
  assert.match(caption, /7 minutes/);
  console.log('ok caption includes payment name and amount');

  // Local filesystem resolve
  const local = resolvePaymentQrTelegramInput(filePath);
  assert.equal(local.ok, true);
  assert.equal(local.type, 'file');
  assert.ok(fs.existsSync(local.absolutePath));
  console.log('ok local filesystem QR resolves');

  // Public URL resolve
  const url = resolvePaymentQrTelegramInput('https://cdn.example.com/qr.png');
  assert.equal(url.ok, true);
  assert.equal(url.type, 'url');
  assert.equal(url.mediaPath, 'https://cdn.example.com/qr.png');
  console.log('ok public URL QR resolves');

  // Relative path resolve
  const rel = resolvePaymentQrTelegramInput(relativePath);
  assert.equal(rel.ok, true);
  console.log('ok relative filesystem QR resolves');

  // Decision: valid amount resolves default method + QR payload
  const decisionStore = createQrStore({
    qrsByMethod: {
      1: [{ id: 10, file_path: filePath, is_active: true, is_default: true, updated_at: '2026-01-02' }]
    }
  });
  const decision = await decideBotReply({
    store: decisionStore,
    contact: {
      id: 1,
      telegram_id: 1001,
      registration_status: 'Collecting Info',
      telegram_sync_source: 'bot_api',
      active_messaging_source: 'bot_api'
    },
    messageText: '9.01'
  });
  assert.equal(decision.kind, 'registration_send_payment_qr');
  assert.equal(decision.sendPaymentQr.firstDepositAmount, 9.01);
  assert.equal(decision.sendPaymentQr.creditedDepositAmount, 10);
  assert.equal(decision.sendPaymentQr.paymentMethodId, 1);
  assert.equal(decision.sendPaymentQr.paymentDisplayName, 'Amy fei');
  assert.equal(decision.setStatus, undefined);
  assert.equal(decision.statePatch.currentStep, 'first_deposit_amount');
  assert.equal(decision.logEvent.event, 'registration_amount_accepted');
  console.log('ok valid amount resolves active default payment method');

  // Inactive QR ignored; newest active used as fallback
  const fallbackStore = createQrStore({
    qrsByMethod: {
      1: [
        { id: 1, file_path: filePath, is_active: false, is_default: true, updated_at: '2026-01-03' },
        { id: 2, file_path: filePath, is_active: true, is_default: false, updated_at: '2026-01-01' },
        { id: 3, file_path: filePath, is_active: true, is_default: false, updated_at: '2026-01-02' }
      ]
    }
  });
  const fallbackQr = await fallbackStore.getActivePaymentQrForRegistration(1);
  assert.equal(fallbackQr.id, 3);
  console.log('ok inactive QR ignored; newest active used');

  // Default preferred over newer non-default
  const defaultStore = createQrStore({
    qrsByMethod: {
      1: [
        { id: 5, file_path: filePath, is_active: true, is_default: true, updated_at: '2026-01-01' },
        { id: 6, file_path: filePath, is_active: true, is_default: false, updated_at: '2026-01-09' }
      ]
    }
  });
  const preferred = await defaultStore.getActivePaymentQrForRegistration(1);
  assert.equal(preferred.id, 5);
  console.log('ok active default QR preferred');

  // Photo sender uses source path + persists bot_api
  let sentPhoto = null;
  const mockBot = {
    telegram: {
      async sendPhoto(chatId, photo, options) {
        sentPhoto = { chatId, photo, options };
        return { message_id: 555, reply_markup: options.reply_markup || null };
      }
    }
  };
  const photoStore = createQrStore();
  const sendPhoto = createBotPhotoSender(mockBot, photoStore);
  await sendPhoto({
    user: { id: 1, telegram_id: 1001 },
    text: caption,
    mediaPath: filePath,
    buttons: [[{ text: 'Cancel Registration', data: 'register:cancel_request' }]]
  });
  assert.ok(sentPhoto.photo?.source);
  assert.match(sentPhoto.options.caption, /Payment Name: Amy fei/);
  assert.equal(photoStore.outgoing[0].source, 'bot_api');
  console.log('ok local filesystem QR sends using source path');
  console.log('ok bot reply is persisted with source=bot_api');

  // URL photo send
  sentPhoto = null;
  await sendPhoto({
    user: { id: 1, telegram_id: 1001 },
    text: caption,
    mediaPath: 'https://cdn.example.com/qr.png'
  });
  assert.equal(sentPhoto.photo, 'https://cdn.example.com/qr.png');
  console.log('ok public URL QR sends correctly');

  // Successful send creates window after photo
  const sendStore = createQrStore({
    qrsByMethod: {
      1: [{ id: 10, file_path: filePath, is_active: true, is_default: true, updated_at: '2026-01-02' }]
    }
  });
  const sendBot = {
    telegram: {
      async sendPhoto(_chatId, _photo, options = {}) {
        return { message_id: 777, reply_markup: options.reply_markup || null };
      },
      async sendMessage(_chatId, _text, options = {}) {
        return { message_id: 778, reply_markup: options?.reply_markup || null };
      }
    }
  };
  const ok = await handlePaymentRegistrationQr({
    store: sendStore,
    contact: { id: 1, telegram_id: 1001, registration_status: 'Collecting Info' },
    sendPaymentQr: {
      paymentMethodId: 1,
      paymentMethodName: 'Chime',
      paymentDisplayName: 'Amy fei',
      firstDepositAmount: 9.01,
      creditedDepositAmount: 10
    },
    bot: sendBot
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.windowCreated, true);
  assert.equal(sendStore.windowsCreated, 1);
  assert.equal(sendStore.status, 'Waiting For Payment');
  assert.equal(sendStore.state.current_step, 'await_payment');
  assert.equal(ok.messageId, 777);
  console.log('ok QR is sent as photo and window created after success');

  // Duplicate amount / retry reuses window
  const again = await handlePaymentRegistrationQr({
    store: sendStore,
    contact: { id: 1, telegram_id: 1001, registration_status: 'Waiting For Payment' },
    sendPaymentQr: {
      paymentMethodId: 1,
      paymentMethodName: 'Chime',
      paymentDisplayName: 'Amy fei',
      firstDepositAmount: 9.01,
      creditedDepositAmount: 10
    },
    bot: sendBot
  });
  assert.equal(again.ok, true);
  assert.equal(again.windowCreated, false);
  assert.equal(sendStore.windowsCreated, 1);
  console.log('ok duplicate amount does not create duplicate payment windows');

  // Missing QR does not create window
  const missingStore = createQrStore({
    qrsByMethod: { 1: [] }
  });
  const missing = await handlePaymentRegistrationQr({
    store: missingStore,
    contact: { id: 2, telegram_id: 1002, registration_status: 'Collecting Info' },
    sendPaymentQr: {
      paymentMethodId: 1,
      paymentMethodName: 'Chime',
      paymentDisplayName: 'Amy fei',
      firstDepositAmount: 9.01,
      creditedDepositAmount: 10
    },
    bot: sendBot
  });
  assert.equal(missing.ok, false);
  assert.equal(missingStore.windowsCreated, 0);
  assert.equal(missingStore.state.current_step, 'first_deposit_amount');
  assert.notEqual(missingStore.status, 'Waiting For Payment');
  console.log('ok payment window is not created when QR lookup fails');

  // 7-minute expiry still set on created window
  const expiresAt = new Date(ok.paymentWindow.expires_at).getTime();
  const delta = expiresAt - Date.now();
  assert.ok(delta > 6 * 60 * 1000 && delta <= 7 * 60 * 1000 + 2000);
  console.log('ok 7-minute expiry still works');

  console.log('ALL REGISTRATION QR CHECKS PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
