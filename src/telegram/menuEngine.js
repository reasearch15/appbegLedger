const SCREENS = {
  Home: {
    title: 'Home',
    getText: ({ registered }) => registered
      ? 'Welcome back!'
      : "👋 Welcome to Royal VIP!\n\nI see you're not registered with us.\n\nPlease choose an option.",
    getButtons: ({ registered }) => registered
      ? [
          [{ label: 'Deposit', action: 'screen:Deposit' }, { label: 'Royal VIP', url: 'https://royal.youplatform.org' }],
          [{ label: 'My Account', action: 'screen:MyAccount' }, { label: 'Support', action: 'screen:Support' }]
        ]
      : [
          [{ label: 'Register', action: 'bot:register' }],
          [{ label: 'Help', action: 'screen:Help' }, { label: 'Contact Support', action: 'keyword:support' }]
        ]
  },
  Register: {
    title: 'Register',
    text: 'Tap Register below to start your Royal VIP registration.',
    buttons: [[{ label: 'Register', action: 'bot:register' }]]
  },
  Help: {
    title: 'Help',
    text: 'Choose a topic, or contact support for direct assistance.',
    buttons: [
      [{ label: 'Registration Help', action: 'bot:register' }],
      [{ label: 'Contact Support', action: 'screen:Support' }]
    ]
  },
  Support: {
    title: 'Support',
    text: 'Support has been opened. Please send your message and our staff will reply from the dashboard.',
    buttons: []
  },
  Deposit: {
    title: 'Deposit',
    text: 'Deposit tools are coming soon. Staff can assist you from support for now.',
    buttons: [[{ label: 'Support', action: 'screen:Support' }]]
  },
  Cashout: {
    title: 'Cashout',
    text: 'Cash out tools are coming soon. Staff can assist you from support for now.',
    buttons: [[{ label: 'Support', action: 'screen:Support' }]]
  },
  MyAccount: {
    title: 'My Account',
    text: 'Account tools are coming soon.',
    buttons: [[{ label: 'Support', action: 'screen:Support' }]]
  }
};

const CONTROL_ROW = [
  { label: 'Back', action: 'nav:back' },
  { label: 'Home', action: 'nav:home' },
  { label: 'Cancel', action: 'nav:cancel' }
];

export function getScreen(screenName) {
  return SCREENS[screenName] || SCREENS.Home;
}

export function getScreenNameForAction(action) {
  if (!action?.startsWith('screen:')) return null;
  return action.slice('screen:'.length);
}

export function buildMenu({ screenName = 'Home', registered = false }) {
  const screen = getScreen(screenName);
  const text = screen.getText ? screen.getText({ registered }) : screen.text;
  const rows = screen.getButtons ? screen.getButtons({ registered }) : screen.buttons || [];
  const controlRows = screenName === 'Home' ? [] : [CONTROL_ROW];
  return {
    screenName: screenName in SCREENS ? screenName : 'Home',
    title: screen.title,
    text,
    replyMarkup: {
      inline_keyboard: [...rows, ...controlRows].map((row) => row.map((button) => ({
        text: button.label,
        ...(button.url ? { url: button.url } : { callback_data: button.action })
      })))
    }
  };
}

export async function renderMenu({ bot, store, user, screenName = 'Home', registered = false }) {
  const menu = buildMenu({ screenName, registered });
  const response = await bot.telegram.sendMessage(user.telegram_id, menu.text, {
    reply_markup: menu.replyMarkup
  });

  await store.storeOutgoingMessage({
    telegramUserId: user.id,
    telegramMessageId: response.message_id,
    text: menu.text,
    payload: { telegramResponse: response, menu },
    senderType: 'bot',
    messageType: 'buttons'
  });

  return { menu, response };
}

export async function handleMenuAction({ action, bot, store, user }) {
  const registered = user.registration_status === 'Registered';
  let session;

  if (action === 'nav:back') {
    session = await store.goBackBotScreen(user.id, 'Bot');
  } else if (action === 'nav:home') {
    session = await store.resetBotState(user.id, { actorName: 'Bot', action: 'home' });
  } else if (action === 'nav:cancel') {
    session = await store.resetBotState(user.id, { actorName: 'Bot', action: 'cancel' });
  } else {
    const nextScreen = getScreenNameForAction(action) || 'Home';
    if (nextScreen === 'Register') {
      return null;
    }
    session = await store.setBotScreen(user.id, nextScreen, { actorName: 'Bot' });
  }

  return renderMenu({
    bot,
    store,
    user,
    screenName: session.current_screen,
    registered
  });
}

export function initialScreenForUser(user) {
  return 'Home';
}
