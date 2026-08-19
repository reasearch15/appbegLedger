export const STAFF_CB = {
  CREDIT: 'op:cr:',
  ASSIGN: 'op:as:',
  ASSIGN_CONFIRM: 'op:ac:',
  ASK: 'op:ak:',
  FREEZE: 'op:fr:',
  UNFREEZE: 'op:uf:',
  RETRY: 'op:rt:',
  FP_GIVE: 'op:fg:',
  FP_DECLINE: 'op:fd:',
  FP_CONFIRM: 'op:fc:',
  FP_MSG: 'op:fm:',
  CONF_ON: 'op:c1',
  CONF_OFF: 'op:c0',
  STAFF_ADD: 'op:sa',
  STAFF_LIST: 'op:sl',
  STAFF_REVOKE: 'op:sx:',
  CTRL: 'op:cc',
  PENDING_PAYMENTS: 'op:pp',
  PENDING_FREEPLAY: 'op:pr',
  REVIEW: 'op:rv:'
};

export function isStaffCallback(data = '') {
  return String(data || '').startsWith('op:');
}

export function controlCenterText(modeOn, role) {
  return [
    '👑 ROYAL VIP CONTROL CENTER',
    `⚡ Confidence Mode: ${modeOn ? 'ON 🟢' : 'OFF 🔴'}`,
    '',
    `Your role: ${role || 'none'}`
  ].join('\n');
}

export function controlCenterButtons(role, { canToggle = false, canManage = false } = {}) {
  const rows = [];
  if (canToggle) {
    rows.push([{ text: '⚡ CONFIDENCE', callback_data: STAFF_CB.CTRL }]);
  }
  rows.push([{ text: '💰 PENDING PAYMENTS', callback_data: STAFF_CB.PENDING_PAYMENTS }]);
  rows.push([{ text: '🎁 FREEPLAY REQUESTS', callback_data: STAFF_CB.PENDING_FREEPLAY }]);
  if (canManage) {
    rows.push([{ text: '👥 STAFF MANAGEMENT', callback_data: STAFF_CB.STAFF_LIST }]);
  }
  return { inline_keyboard: rows };
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
    case 'frozen':
      return '❄️ FROZEN';
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
