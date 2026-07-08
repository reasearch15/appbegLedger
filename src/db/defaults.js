export const REGISTRATION_STATUSES = ['New', 'Collecting Info', 'Pending', 'Pending Verification', 'Registered', 'Suspended', 'Archived'];
export const CONVERSATION_STATUSES = ['Open', 'Waiting', 'Closed'];
export const DEFAULT_TAGS = [
  { name: 'VIP', color: '#7c3aed' },
  { name: 'High Roller', color: '#0f766e' },
  { name: 'Friend', color: '#2563eb' },
  { name: 'Suspicious', color: '#b91c1c' },
  { name: 'Staff', color: '#475569' },
  { name: 'Test User', color: '#b45309' }
];
export const DEFAULT_QUICK_REPLIES = [
  { label: 'Welcome', body: 'Welcome! Thanks for messaging us. How can we help you today?', sort_order: 10 },
  { label: 'Registration', body: 'Please send the details requested by our team so we can help with registration.', sort_order: 20 },
  { label: 'Deposit Instructions', body: 'We can help with deposit instructions here. Please confirm the amount and method you want to use.', sort_order: 30 },
  { label: 'Cashout Instructions', body: 'We can help with cashout instructions here. Please confirm your account details before proceeding.', sort_order: 40 },
  { label: 'Contact Support', body: 'A support staff member will review this and reply as soon as possible.', sort_order: 50 },
  { label: 'Thank You', body: 'Thank you. We appreciate your patience.', sort_order: 60 }
];
export const DEFAULT_AUTOMATION_RULES = [
  {
    name: 'Guest Welcome',
    keywords: ['hi', 'hello', 'hey', 'start', '/start'],
    match_type: 'exact',
    contact_status_condition: 'new',
    response_type: 'menu',
    response_message: "Hello, welcome to Royal VIP 👋\nYou are not registered with us yet.\nClick Register to start.",
    buttons: [[{ label: 'Register', action: 'flow:registration_info' }]],
    priority: 10
  },
  {
    name: 'Registered Welcome',
    keywords: ['hi', 'hello', 'start', '/start'],
    match_type: 'exact',
    contact_status_condition: 'registered',
    response_type: 'menu',
    response_message: 'Welcome back!',
    buttons: [[{ label: 'Deposit', action: 'keyword:deposit' }, { label: 'Cash Out', action: 'keyword:cashout' }], [{ label: 'My Account', action: 'screen:MyAccount' }, { label: 'Support', action: 'keyword:support' }]],
    priority: 11
  },
  {
    name: 'Registration Info Flow',
    keywords: ['register', 'registration'],
    match_type: 'exact',
    contact_status_condition: 'any',
    response_type: 'start_flow',
    response_message: "Let's collect your registration info. What AppBeg username would you prefer?",
    flow_key: 'registration_info',
    priority: 20
  },
  {
    name: 'Deposit Interest',
    keywords: ['deposit'],
    match_type: 'exact',
    contact_status_condition: 'any',
    response_type: 'text',
    response_message: 'Deposit automation is coming soon. I saved your deposit interest so staff can follow up.',
    intent_key: 'deposit_interest',
    priority: 30
  },
  {
    name: 'Cashout Interest',
    keywords: ['cashout', 'cash out', 'withdraw'],
    match_type: 'exact',
    contact_status_condition: 'any',
    response_type: 'text',
    response_message: 'Cashout automation is coming soon. I saved your cashout interest so staff can follow up.',
    intent_key: 'cashout_interest',
    priority: 31
  },
  {
    name: 'Help Menu',
    keywords: ['help'],
    match_type: 'exact',
    contact_status_condition: 'any',
    response_type: 'menu',
    response_message: 'How can we help?',
    buttons: [[{ label: 'Register', action: 'flow:registration_info' }], [{ label: 'Deposit', action: 'keyword:deposit' }, { label: 'Cash Out', action: 'keyword:cashout' }], [{ label: 'Contact Support', action: 'keyword:support' }]],
    priority: 40
  },
  {
    name: 'Support Needed',
    keywords: ['support'],
    match_type: 'exact',
    contact_status_condition: 'any',
    response_type: 'text',
    response_message: 'Support has been notified. A staff member will review your message soon.',
    intent_key: 'support_needed',
    conversation_status: 'Open',
    priority: 50
  }
];
