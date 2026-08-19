import {
  SUPPORT_ACCOUNT_NOT_FOUND_TEXT,
  SUPPORT_DELIVERY_FAILED_TEXT,
  SUPPORT_REQUEST_SENT_TEXT,
  INQUIRY_REQUEST_SENT_TEXT,
  buildInquiryNotificationText,
  buildSupportRequestNotificationText,
  resolveAppBegUsernameForSupport
} from './supportNotificationBot.js';

export const CONTACT_SUPPORT_FLOW = 'contact_support';
export const SUPPORT_INQUIRY_STEP = 'awaiting_support_inquiry';
export const SUPPORT_TOPIC_PREFIX = 'bot:support:topic:';
export const SUPPORT_CUSTOM_INQUIRY_ACTION = 'bot:support:custom_inquiry';
export const SUPPORT_MENU_ACTION = 'bot:support:menu';

/**
 * Contact Support options.
 * notify=true  → human follow-up via separate support bot
 * notify=false → informational answer only
 */
export const CONTACT_SUPPORT_OPTIONS = [
  {
    key: 'password_help',
    label: '🔑 Password / Login Help',
    topic: 'Password / Login Help',
    notify: true
  },
  {
    key: 'deposit_help',
    label: '💰 Deposit / Payment Help',
    topic: 'Deposit / Payment Help',
    notify: true
  },
  {
    key: 'cashout_help',
    label: '🏧 Cashout Help',
    topic: 'Cashout Help',
    notify: true
  },
  {
    key: 'credentials_help',
    label: '🔐 Game Credentials Help',
    topic: 'Game Credentials Help',
    notify: true
  },
  {
    key: 'how_deposit',
    label: 'ℹ️ How do I deposit?',
    topic: 'How do I deposit?',
    notify: false,
    answer: [
      'How to deposit:',
      '',
      '1. Tap DEPOSIT from the bot main menu.',
      '2. Choose My Account or Another Player.',
      '3. Complete the payment using the QR / payment instructions. You do not enter an amount.',
      '4. Once your payment is verified, the recipient is credited.'
    ].join('\n')
  },
  {
    key: 'how_cashout',
    label: 'ℹ️ How do I cash out?',
    topic: 'How do I cash out?',
    notify: false,
    answer: [
      'How to cash out:',
      '',
      '1. Open Royal VIP and go to the Lobby.',
      '2. Tap Cashout.',
      '3. Choose QR or Payment App and submit your request.',
      '4. Wait for staff processing. Royal VIP shows Cashout Successful when complete.'
    ].join('\n')
  },
  {
    key: 'custom_inquiry',
    label: '✍️ Ask a Custom Question',
    topic: 'Custom Inquiry',
    notify: false,
    startsInquiry: true
  }
];

const OPTION_BY_KEY = new Map(CONTACT_SUPPORT_OPTIONS.map((option) => [option.key, option]));

export function isContactSupportAction(action = '') {
  const value = String(action || '').trim();
  return value === SUPPORT_MENU_ACTION
    || value === SUPPORT_CUSTOM_INQUIRY_ACTION
    || value.startsWith(SUPPORT_TOPIC_PREFIX)
    || value === 'staff:takeover'
    || value === 'bot:talk_to_staff'
    || value === 'menu:support';
}

export function isSupportInquiryStep(flow, step) {
  return String(flow || '') === CONTACT_SUPPORT_FLOW
    && String(step || '') === SUPPORT_INQUIRY_STEP;
}

export function contactSupportMenuButtons() {
  const rows = CONTACT_SUPPORT_OPTIONS.map((option) => ([{
    label: option.label,
    text: option.label,
    action: option.startsInquiry ? SUPPORT_CUSTOM_INQUIRY_ACTION : `${SUPPORT_TOPIC_PREFIX}${option.key}`,
    data: option.startsInquiry ? SUPPORT_CUSTOM_INQUIRY_ACTION : `${SUPPORT_TOPIC_PREFIX}${option.key}`
  }]));
  rows.push([{ label: '🏠 Main Menu', text: '🏠 Main Menu', action: 'bot:main_menu', data: 'bot:main_menu' }]);
  return rows;
}

export function buildContactSupportMenuDecision({ reason = 'menu_opened' } = {}) {
  return {
    kind: 'contact_support_menu',
    replies: [{
      text: [
        '☎ Contact Support',
        '',
        'Choose a topic below, or ask a custom question.',
        'Our support team will follow up when a request is submitted.'
      ].join('\n'),
      buttons: contactSupportMenuButtons()
    }],
    statePatch: {
      currentFlow: null,
      currentStep: null
    },
    escalate: false,
    logEvent: { event: 'support_menu_opened', reason }
  };
}

export function decideContactSupportAction({ action, contact, info = {} } = {}) {
  const normalized = String(action || '').trim();
  if (
    normalized === 'staff:takeover'
    || normalized === 'bot:talk_to_staff'
    || normalized === 'menu:support'
    || normalized === SUPPORT_MENU_ACTION
  ) {
    return buildContactSupportMenuDecision({ reason: normalized });
  }

  if (normalized === SUPPORT_CUSTOM_INQUIRY_ACTION) {
    return {
      kind: 'support_custom_inquiry_prompt',
      replies: [{
        text: [
          '✍️ Custom Question',
          '',
          'Please type your question in one message.',
          'We will send it to support with your RoyalVIP account username.'
        ].join('\n'),
        buttons: [
          [{ label: '⬅ Support Menu', text: '⬅ Support Menu', action: SUPPORT_MENU_ACTION, data: SUPPORT_MENU_ACTION }],
          [{ label: '🏠 Main Menu', text: '🏠 Main Menu', action: 'bot:main_menu', data: 'bot:main_menu' }]
        ]
      }],
      statePatch: {
        currentFlow: CONTACT_SUPPORT_FLOW,
        currentStep: SUPPORT_INQUIRY_STEP,
        registrationInfo: {
          ...info,
          support_request_status: 'awaiting_question',
          support_request_topic: 'Custom Inquiry',
          support_request_error: null
        }
      },
      escalate: false,
      logEvent: { event: 'support_topic_selected', topic: 'Custom Inquiry', notify: false }
    };
  }

  if (normalized.startsWith(SUPPORT_TOPIC_PREFIX)) {
    const key = normalized.slice(SUPPORT_TOPIC_PREFIX.length);
    const option = OPTION_BY_KEY.get(key);
    if (!option) {
      return buildContactSupportMenuDecision({ reason: 'unknown_topic' });
    }
    if (!option.notify) {
      return {
        kind: `support_info_${option.key}`,
        replies: [{
          text: option.answer,
          buttons: [
            [{ label: '⬅ Support Menu', text: '⬅ Support Menu', action: SUPPORT_MENU_ACTION, data: SUPPORT_MENU_ACTION }],
            [{ label: '🏠 Main Menu', text: '🏠 Main Menu', action: 'bot:main_menu', data: 'bot:main_menu' }]
          ]
        }],
        statePatch: null,
        escalate: false,
        logEvent: { event: 'support_topic_selected', topic: option.topic, notify: false }
      };
    }

    const resolved = resolveAppBegUsernameForSupport({ contact, info });
    if (!resolved.ok) {
      console.log(`[chatbot] appbeg_username_resolution_failed contact=${contact?.id || 'n/a'} reason=${resolved.reason} action=${normalized}`);
      return {
        kind: 'support_username_missing',
        replies: [{ text: SUPPORT_ACCOUNT_NOT_FOUND_TEXT }],
        statePatch: null,
        escalate: false,
        logEvent: { event: 'appbeg_username_resolution_failed', reason: resolved.reason, topic: option.topic }
      };
    }

    return {
      kind: 'support_request_pending',
      replies: [],
      statePatch: {
        currentFlow: null,
        currentStep: null,
        registrationInfo: {
          ...info,
          support_request_status: 'pending',
          support_request_topic: option.topic,
          support_request_message: null,
          support_request_error: null
        }
      },
      escalate: false,
      supportOwnerNotify: {
        kind: 'support',
        topic: option.topic,
        fingerprint: `support:${option.key}`,
        username: resolved.username,
        text: buildSupportRequestNotificationText({
          username: resolved.username,
          topic: option.topic
        }),
        playerSuccessText: SUPPORT_REQUEST_SENT_TEXT,
        playerFailureText: SUPPORT_DELIVERY_FAILED_TEXT
      },
      logEvent: { event: 'support_topic_selected', topic: option.topic, notify: true }
    };
  }

  return buildContactSupportMenuDecision({ reason: 'fallback' });
}

export function decideSupportInquiryMessage({ contact, info = {}, text = '' } = {}) {
  const question = String(text || '').trim();
  if (!question) {
    return {
      kind: 'support_inquiry_empty',
      replies: [{
        text: 'Please type your question in one message so we can send it to support.'
      }],
      statePatch: {
        currentFlow: CONTACT_SUPPORT_FLOW,
        currentStep: SUPPORT_INQUIRY_STEP
      },
      escalate: false
    };
  }

  const resolved = resolveAppBegUsernameForSupport({ contact, info });
  if (!resolved.ok) {
    console.log(`[chatbot] appbeg_username_resolution_failed contact=${contact?.id || 'n/a'} reason=${resolved.reason} action=custom_inquiry`);
    return {
      kind: 'support_username_missing',
      replies: [{ text: SUPPORT_ACCOUNT_NOT_FOUND_TEXT }],
      statePatch: {
        currentFlow: null,
        currentStep: null,
        registrationInfo: {
          ...info,
          support_request_status: 'failed',
          support_request_error: 'username_missing',
          support_request_message: question.slice(0, 2000)
        }
      },
      escalate: false,
      logEvent: { event: 'appbeg_username_resolution_failed', reason: resolved.reason, topic: 'Custom Inquiry' }
    };
  }

  return {
    kind: 'support_inquiry_pending',
    replies: [],
    statePatch: {
      currentFlow: null,
      currentStep: null,
      registrationInfo: {
        ...info,
        support_request_status: 'pending',
        support_request_topic: 'Custom Inquiry',
        support_request_message: question.slice(0, 2000),
        support_request_error: null
      }
    },
    escalate: false,
    supportOwnerNotify: {
      kind: 'inquiry',
      topic: 'Custom Inquiry',
      fingerprint: `inquiry:${hashText(question)}`,
      username: resolved.username,
      question,
      text: buildInquiryNotificationText({
        username: resolved.username,
        question
      }),
      playerSuccessText: INQUIRY_REQUEST_SENT_TEXT,
      playerFailureText: SUPPORT_DELIVERY_FAILED_TEXT,
      preserveMessageOnFailure: true
    },
    logEvent: { event: 'support_topic_selected', topic: 'Custom Inquiry', notify: true }
  };
}

function hashText(value = '') {
  let hash = 0;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}
