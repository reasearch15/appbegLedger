export const STAFF_CB = {
  CREDIT: 'op:cr:',
  ASSIGN: 'op:as:',
  ASSIGN_CONFIRM: 'op:ac:',
  ASK: 'op:ak:',
  FREEZE: 'op:fr:',
  UNFREEZE: 'op:uf:',
  IGNORE: 'op:ig:',
  IGNORE_CONFIRM: 'op:ic:',
  RETRY: 'op:rt:',
  FP_GIVE: 'op:fg:',
  FP_DECLINE: 'op:fd:',
  FP_CONFIRM: 'op:fc:',
  FP_MSG: 'op:fm:',
  CONFIDENCE: 'op:cm',
  CONF_ON: 'op:c1',
  CONF_OFF: 'op:c0',
  STAFF_ADD: 'op:sa',
  STAFF_LIST: 'op:sl',
  STAFF_REVOKE: 'op:sx:',
  STAFF_RETRY: 'op:st:',
  CTRL: 'op:cc',
  HUB: 'op:hm',
  HUB_REFRESH: 'op:hr',
  HUB_STATUS: 'op:hs',
  PENDING_PAYMENTS: 'op:pp',
  PENDING_FREEPLAY: 'op:pr',
  REVIEW: 'op:rv:'
};

export function isStaffCallback(data = '') {
  return String(data || '').startsWith('op:');
}

const PAYMENT_REVIEW_CALLBACK_PREFIXES = [
  STAFF_CB.CREDIT,
  STAFF_CB.ASSIGN,
  STAFF_CB.ASSIGN_CONFIRM,
  STAFF_CB.ASK,
  STAFF_CB.FREEZE,
  STAFF_CB.UNFREEZE,
  STAFF_CB.IGNORE,
  STAFF_CB.IGNORE_CONFIRM,
  STAFF_CB.RETRY,
  STAFF_CB.REVIEW,
  STAFF_CB.PENDING_PAYMENTS
];

export function isPaymentReviewCallback(data = '') {
  const raw = String(data || '');
  if (!raw) return false;
  return PAYMENT_REVIEW_CALLBACK_PREFIXES.some((prefix) => raw === prefix || raw.startsWith(prefix));
}

/**
 * Telegraf sendMessage/reply extra must use Bot API `reply_markup`.
 * Staff card helpers return `{ inline_keyboard }`; wrap that shape here
 * so auto-pushed payment cards actually render buttons.
 */
export function asTelegramSendExtra(extra = undefined) {
  if (!extra || typeof extra !== 'object') return extra;
  if (extra.reply_markup) return extra;
  if (Array.isArray(extra.inline_keyboard)) {
    const { inline_keyboard, ...rest } = extra;
    return { ...rest, reply_markup: { inline_keyboard } };
  }
  return extra;
}

export function sharedControlCenterText() {
  return [
    '👑 ROYAL VIP CONTROL CENTER',
    'Manage Royal VIP operations securely.'
  ].join('\n');
}

export function sharedControlCenterButtons() {
  return {
    inline_keyboard: [[{ text: 'OPEN CONTROL CENTER', callback_data: STAFF_CB.CTRL }]]
  };
}

export function controlCenterText(modeOn, role) {
  return [
    '👑 ROYAL VIP CONTROL CENTER',
    `⚡ Confidence Mode: ${modeOn ? 'ON 🟢' : 'OFF 🔴'}`,
    '',
    `Your role: ${role || 'none'}`
  ].join('\n');
}

export function controlCenterButtons(role, { canToggle = false, canManage = false, canManageHub = false } = {}) {
  const rows = [];
  if (canToggle) {
    rows.push([{ text: '⚡ CONFIDENCE MODE', callback_data: STAFF_CB.CONFIDENCE }]);
  }
  if (canManage) {
    rows.push([{ text: '👥 STAFF MANAGEMENT', callback_data: STAFF_CB.STAFF_LIST }]);
  }
  if (canManageHub) {
    rows.push([{ text: '👑 HUB MANAGEMENT', callback_data: STAFF_CB.HUB }]);
  }
  rows.push([{ text: '💰 PAYMENTS', callback_data: STAFF_CB.PENDING_PAYMENTS }]);
  rows.push([{ text: '🎁 FREEPLAY', callback_data: STAFF_CB.PENDING_FREEPLAY }]);
  return { inline_keyboard: rows };
}

export function hubManagementText() {
  return '👑 HUB MANAGEMENT';
}

export function hubManagementButtons() {
  return {
    inline_keyboard: [
      [{ text: '🔄 REFRESH HUB', callback_data: STAFF_CB.HUB_REFRESH }],
      [{ text: '👁 VIEW HUB STATUS', callback_data: STAFF_CB.HUB_STATUS }]
    ]
  };
}

export function confidenceToggleButtons() {
  return {
    inline_keyboard: [[
      { text: '🟢 TURN ON', callback_data: STAFF_CB.CONF_ON },
      { text: '🔴 TURN OFF', callback_data: STAFF_CB.CONF_OFF }
    ]]
  };
}

export function staffManagementButtons() {
  return {
    inline_keyboard: [
      [{ text: '➕ ADD STAFF', callback_data: STAFF_CB.STAFF_ADD }],
      [{ text: '👥 CURRENT STAFF', callback_data: STAFF_CB.STAFF_LIST }]
    ]
  };
}

export function staffHubAccessLine(role) {
  const status = String(role?.telegram_channel_admin_status || '').trim();
  if (role?.role === 'root_admin') return 'Hub DM Access: ✅';
  if (status === 'active') return 'Hub DM Access: ✅';
  if (status === 'skipped_root' || status === 'skipped_creator') return 'Hub DM Access: ✅';
  return 'Hub DM Access: ⚠️ Pending';
}

export function paymentStatusLabel(status) {
  switch (String(status || '')) {
    case 'deposit_window_matched':
    case 'registered_player_deposit':
    case 'appbeg_owned':
      return '🟢 AUTO-CREDITED';
    case 'needs_confirmation':
    case 'manual_review':
      return '🟡 NEEDS CONFIRMATION';
    case 'ambiguous':
      return '🔴 AMBIGUOUS';
    case 'unmatched':
    case 'searching':
    case 'unrouted':
      return '⚪ UNMATCHED';
    case 'ignored':
    case 'duplicate_ignored':
      return '🚫 IGNORED';
    case 'credit_failed':
      return '🔴 CREDIT FAILED';
    default:
      return status || 'unknown';
  }
}

export function paymentCardText(payment = {}, extra = {}) {
  const name = payment.parsed_sender_name || 'Unknown';
  const amount = payment.parsed_amount != null ? `$${Number(payment.parsed_amount).toFixed(2)}` : '—';
  const status = extra.statusLabel || paymentStatusLabel(payment.routing_status);
  const reasons = extra.reasons?.length ? ['Reasons:', ...extra.reasons.map((line) => `• ${line}`)] : [];
  return [
    extra.title || '💵 PAYMENT',
    `Payment Name: ${name}`,
    `Amount: ${amount}`,
    extra.recipient ? `Possible recipient: ${extra.recipient}` : null,
    extra.payer ? `Payer: ${extra.payer}` : null,
    `Status: ${status}`,
    ...reasons
  ].filter(Boolean).join('\n');
}

export function paymentCardButtons(paymentId, { frozen = false, creditFailed = false } = {}) {
  if (creditFailed) {
    return { inline_keyboard: [[{ text: '🔄 RETRY CREDIT', callback_data: `${STAFF_CB.RETRY}${paymentId}` }]] };
  }
  return {
    inline_keyboard: [
      [
        { text: '✅ CREDIT', callback_data: `${STAFF_CB.CREDIT}${paymentId}` },
        { text: '🔎 ASSIGN PLAYER', callback_data: `${STAFF_CB.ASSIGN}${paymentId}` }
      ],
      [
        { text: '💬 ASK PLAYER', callback_data: `${STAFF_CB.ASK}${paymentId}` },
        frozen
          ? { text: '🔓 UNFREEZE', callback_data: `${STAFF_CB.UNFREEZE}${paymentId}` }
          : { text: '❄️ FREEZE', callback_data: `${STAFF_CB.FREEZE}${paymentId}` }
      ],
      [
        { text: '🚫 IGNORE', callback_data: `${STAFF_CB.IGNORE}${paymentId}` }
      ]
    ]
  };
}

export function assignConfirmText({ payment, recipientUsername, amount }) {
  return [
    'Assign:',
    `Payment: ${payment?.parsed_sender_name || 'Unknown'}`,
    `Amount: ${amount != null ? `$${Number(amount).toFixed(2)}` : '—'}`,
    `Recipient: ${recipientUsername || 'Unknown'}`,
    '',
    'Confirm to credit the recipient. Payment identity learns the payer, not the recipient.'
  ].join('\n');
}

export function assignConfirmButtons(paymentId) {
  return {
    inline_keyboard: [[
      { text: '✅ CONFIRM & CREDIT', callback_data: `${STAFF_CB.ASSIGN_CONFIRM}${paymentId}` },
      { text: '❌ CANCEL', callback_data: STAFF_CB.CTRL }
    ]]
  };
}

export function ignoreConfirmText(payment = {}) {
  const amount = payment.parsed_amount != null ? `$${Number(payment.parsed_amount).toFixed(2)}` : '—';
  return [
    '🚫 IGNORE PAYMENT EVENT',
    `Payment Name: ${payment.parsed_sender_name || 'Unknown'}`,
    `Amount: ${amount}`,
    '',
    'This event is not a deposit credit event.',
    'Ignore is not Freeze. The event is kept, but it will not be credited.'
  ].join('\n');
}

export function ignoreConfirmButtons(paymentId) {
  return {
    inline_keyboard: [[
      { text: '✅ CONFIRM IGNORE', callback_data: `${STAFF_CB.IGNORE_CONFIRM}${paymentId}` },
      { text: '❌ CANCEL', callback_data: STAFF_CB.CTRL }
    ]]
  };
}

export function freeplayCardText(request = {}) {
  return [
    '🎁 FREEPLAY REQUEST',
    `Player: ${request.username || 'Unknown'}`,
    request.question ? `Note: ${request.question}` : null
  ].filter(Boolean).join('\n');
}

export function freeplayCardButtons(requestId, contactId = null) {
  const rows = [[
    { text: '✅ GIVE', callback_data: `${STAFF_CB.FP_GIVE}${requestId}` },
    { text: '❌ DECLINE', callback_data: `${STAFF_CB.FP_DECLINE}${requestId}` }
  ]];
  if (contactId) {
    rows.push([{ text: '💬 MESSAGE PLAYER', callback_data: `${STAFF_CB.FP_MSG}${contactId}` }]);
  }
  return { inline_keyboard: rows };
}

export function freeplayConfirmText(username, amount) {
  return `Give $${Number(amount).toFixed(2)} Freeplay to ${username || 'this player'}?`;
}

export function freeplayConfirmButtons(requestId) {
  return {
    inline_keyboard: [[
      { text: `✅ CONFIRM`, callback_data: `${STAFF_CB.FP_CONFIRM}${requestId}` },
      { text: '❌ CANCEL', callback_data: STAFF_CB.CTRL }
    ]]
  };
}

export function freeplayIssuedPlayerText(amount) {
  return `Your Freeplay of $${Number(amount).toFixed(2)} has been issued.`;
}

export function freeplayNotLoadedStaffText({ username, amount, approvedBy, reason = null } = {}) {
  return [
    '🔴 FREEPLAY NOT LOADED',
    `Player: ${username || 'Unknown'}`,
    `Amount: $${Number(amount).toFixed(2)}`,
    `Approved by: ${approvedBy || 'Staff'}`,
    '',
    reason || 'AppBeg Freeplay issuance is not configured.'
  ].join('\n');
}
