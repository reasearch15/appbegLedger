export const HELP_HOME_ACTION = 'bot:how_it_works';
export const HELP_TOPIC_PREFIX = 'bot:help:';
export const HELP_HOME_TITLE = '📖 Royal VIP Help Center';

const ROYAL_VIP_URL = 'https://royal.youplatform.org';

function configuredRoyalVipBotUrl(env = process.env) {
  const explicitUrl = String(env.ROYAL_VIP_TELEGRAM_BOT_URL || env.TELEGRAM_BOT_URL || '').trim();
  if (explicitUrl) return explicitUrl;

  const username = String(
    env.TELEGRAM_BOT_USERNAME
    || globalThis.telegramBot?.botInfo?.username
    || globalThis.telegramBot?.telegram?.botInfo?.username
    || ''
  ).trim().replace(/^@+/, '');
  return username ? `https://t.me/${username}` : '';
}

const HELP_TOPICS = [
  {
    key: 'getting_started',
    label: '📖 Getting Started',
    title: '📖 Getting Started',
    text: [
      'Log in at Royal VIP with your Royal VIP username and password.',
      '',
      `Website: ${ROYAL_VIP_URL}`,
      '',
      'After login, players land in the Lobby. The main player menu includes:',
      '• Lobby: wallet balances and quick actions.',
      '• Play: assigned games, recharge requests, and redeem requests.',
      '• Bonus: active bonus events.',
      '• Earn Coins: referral rewards.',
      '• Agents: chat with staff.',
      '• Vault: game usernames and passwords.',
      '',
      'Keep your Royal VIP password private.'
    ].join('\n')
  },
  {
    key: 'playing',
    label: '🎮 Playing Games',
    title: '🎮 Playing Games',
    text: [
      'Open Play, then tap an assigned game table.',
      '',
      'The play screen asks for an amount in USD. From there:',
      '• Send Recharge moves coin into the selected game account.',
      '• Send Redeem asks staff to redeem from that selected game.',
      '',
      'Recharge requests are sent only when your Royal VIP coin balance covers the amount. Requests go to your team for secure processing, and your recent recharge/redeem history appears on the player page.'
    ].join('\n')
  },
  {
    key: 'deposits',
    label: '💰 Deposits',
    title: '💰 Deposits',
    text: [
      'Loading coins is now handled through the Royal VIP Telegram bot.',
      '',
      'How to deposit:',
      '',
      "1. Tap **Deposit** from the bot's main menu.",
      '2. Enter the exact amount you want to deposit.',
      '3. Complete the payment using the instructions provided.',
      '4. Once your payment is verified, your Royal VIP balance will be updated automatically.',
      '',
      'Need to deposit while using Royal VIP?',
      '',
      'Tap **Open Royal VIP Bot** below to start your deposit.'
    ].join('\n'),
    includeRoyalVipBotButton: true
  },
  {
    key: 'cashouts',
    label: '🏧 Cash Outs',
    title: '🏧 Cash Outs',
    text: [
      'Cash outs are handled inside Royal VIP.',
      '',
      'Open the Lobby and tap Cashout. Royal VIP uses your cash balance and shows the amount available for the current rolling 24-hour cashout allowance.',
      '',
      'You can choose:',
      '• QR: upload your payout QR.',
      '• Payment App: enter app name, cash tag/username, and name on the app.',
      '',
      'After you send the request, it waits for staff processing. When completed, Royal VIP shows a Cashout Successful message. You can also send an inquiry from that success screen.'
    ].join('\n')
  },
  {
    key: 'vault',
    label: '🔐 Vault & Game Credentials',
    title: '🔐 Vault & Game Credentials',
    text: [
      'Open Vault to view your assigned game credentials.',
      '',
      'Vault shows each game name, game username, and game password. You can copy usernames, reveal passwords, copy revealed passwords, and use Download Game when a game link is available.',
      '',
      'If a game password needs help, use Reset password in Vault. A staff task is created for your team.'
    ].join('\n')
  },
  {
    key: 'bonus_events',
    label: '🎁 Bonus Events',
    title: '🎁 Bonus Events',
    text: [
      'Open Bonus to see active bonus drops for your account.',
      '',
      'Each event shows the bonus name, game, amount, and bonus percentage. When you claim/open a bonus, Royal VIP deducts the base amount from your coin balance and creates a recharge request with the bonus added.',
      '',
      'Bonus events are limited and first-come-first-served. If another player claims one first, it can disappear from the list. Low coin, blocked accounts, or already-claimed events can stop a bonus from starting.'
    ].join('\n')
  },
  {
    key: 'free_play',
    label: '🎉 Free Play',
    title: '🎉 Free Play',
    text: [
      'Open Earn Coins to check Free Play and referral rewards.',
      '',
      'When staff sends a FreePlay gift, Earn Coins shows a FreePlay Gift Box. Tap the gift box to reveal and claim the reward.',
      '',
      'Earn Coins also displays your referral code and referral players. The app text advertises $15 free play when a friend signs up, a $5 bonus after their first deposit, and percentage-based rewards from referred players. Claimable referral rewards appear in Earn Coins.'
    ].join('\n')
  },
  {
    key: 'my_account',
    label: '👤 My Account',
    title: '👤 My Account',
    text: [
      'Your Royal VIP player page shows your coin balance and cash balance in the Lobby.',
      '',
      'Available account tools include:',
      '• Transfer Cash → Coin when you have cash balance.',
      '• Deposits through the Royal VIP Telegram bot.',
      '• Cashout from cash balance.',
      '• Agents chat for account help.',
      '• Logout from the player menu.',
      '',
      'The app does not show a self-service profile editor for players in the inspected player area.'
    ].join('\n')
  },
  {
    key: 'faq',
    label: '❓ Frequently Asked Questions',
    title: '❓ Frequently Asked Questions',
    text: [
      'I forgot my password.',
      'Use Support here or Agents inside Royal VIP so staff can help with a reset.',
      '',
      'How do I deposit?',
      "Tap Deposit from the bot's main menu, enter the exact amount, and complete the payment using the instructions provided.",
      '',
      'How do I cash out?',
      'Open Royal VIP, tap Cashout from the Lobby, choose QR or Payment App, then send the request.',
      '',
      'Where are my game credentials?',
      'Open Vault. You can copy usernames and reveal/copy passwords there.',
      '',
      "Why wasn't my payment matched?",
      'Deposits are verified through the Royal VIP Telegram bot. Once your payment is verified, your Royal VIP balance is updated automatically.',
      '',
      'How do I contact support?',
      'Tap Contact Support here, or open Agents inside Royal VIP.'
    ].join('\n')
  },
  {
    key: 'support',
    label: '☎ Contact Support',
    title: '☎ Contact Support',
    text: [
      'Tap Contact Support to open a conversation with staff.',
      '',
      'You can also use Agents inside Royal VIP for account, game, deposit, cashout, or credential help.'
    ].join('\n'),
    supportOnly: true
  }
];

const TOPIC_BY_KEY = new Map(HELP_TOPICS.map((topic) => [topic.key, topic]));

export function isHelpCenterAction(action = '') {
  const value = String(action || '').trim();
  return value === HELP_HOME_ACTION || value.startsWith(HELP_TOPIC_PREFIX);
}

export function isHelpCenterTopicAction(action = '') {
  return String(action || '').trim().startsWith(HELP_TOPIC_PREFIX);
}

export function helpCenterHomeButtons() {
  const rows = [];
  for (let index = 0; index < HELP_TOPICS.length; index += 2) {
    rows.push(
      HELP_TOPICS.slice(index, index + 2).map((topic) => ({
        label: topic.label,
        text: topic.label,
        action: `${HELP_TOPIC_PREFIX}${topic.key}`,
        data: `${HELP_TOPIC_PREFIX}${topic.key}`
      }))
    );
  }
  rows.push([{ label: '🏠 Main Menu', text: '🏠 Main Menu', action: 'bot:main_menu', data: 'bot:main_menu' }]);
  return rows;
}

export function helpTopicButtons(topicKey = '') {
  const topic = TOPIC_BY_KEY.get(topicKey);
  const rows = [
    [
      { label: '⬅ Help Home', text: '⬅ Help Home', action: HELP_HOME_ACTION, data: HELP_HOME_ACTION },
      { label: '🏠 Main Menu', text: '🏠 Main Menu', action: 'bot:main_menu', data: 'bot:main_menu' }
    ]
  ];
  if (topic?.supportOnly) {
    rows.unshift([{ label: '☎ Contact Support', text: '☎ Contact Support', action: 'menu:support', data: 'menu:support' }]);
  }
  if (topic?.includeRoyalVipBotButton) {
    const url = configuredRoyalVipBotUrl();
    if (url) {
      rows.unshift([{ label: '🚀 Open Royal VIP Bot', text: '🚀 Open Royal VIP Bot', url }]);
    }
  }
  return rows;
}

export function buildHelpCenterDecision(action = HELP_HOME_ACTION) {
  const topicKey = String(action || '').trim().startsWith(HELP_TOPIC_PREFIX)
    ? String(action).trim().slice(HELP_TOPIC_PREFIX.length)
    : '';
  const topic = TOPIC_BY_KEY.get(topicKey);

  if (!topic) {
    return {
      kind: 'help_center_home',
      replies: [{
        text: [
          HELP_HOME_TITLE,
          '',
          'Choose a topic below. This guide is read-only and will not change your registration, deposit, cashout, or game requests.'
        ].join('\n'),
        buttons: helpCenterHomeButtons()
      }],
      statePatch: null,
      escalate: false
    };
  }

  return {
    kind: `help_center_${topic.key}`,
    replies: [{
      text: [topic.title, '', topic.text].join('\n'),
      buttons: helpTopicButtons(topic.key)
    }],
    statePatch: null,
    escalate: false
  };
}

export function helpCenterTopicKeys() {
  return HELP_TOPICS.map((topic) => topic.key);
}
