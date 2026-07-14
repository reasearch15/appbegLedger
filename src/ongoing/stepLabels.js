/** Human-readable labels for bot registration / deposit automation steps. */

const STEP_LABELS = {
  welcome: 'Welcome',
  payment_name: 'Entering Payment Name',
  payment_display_name: 'Entering Payment Name',
  enter_payment_display_name: 'Entering Payment Name',
  first_deposit_amount: 'Entering First Deposit Amount',
  payment_app: 'Choosing Payment App',
  choose_payment_app: 'Choosing Payment App',
  payment_tag: 'Entering Payment Tag',
  enter_payment_tag: 'Entering Payment Tag',
  await_payment: 'Waiting for Payment',
  await_payment_done: 'Waiting for Payment',
  waiting_for_payment_confirmation: 'Waiting for Payment Confirmation',
  username: 'Entering AppBeg Username',
  enter_appbeg_username: 'Entering AppBeg Username',
  password: 'Entering Password',
  enter_appbeg_password: 'Entering Password',
  referral_code: 'Entering Referral Code',
  enter_referral_code: 'Entering Referral Code',
  review: 'Reviewing Details',
  creating_account: 'Creating Account',
  submitted: 'Submitted',
  complete: 'Complete',
  deposit_payment_name: 'Entering Deposit Payment Name',
  deposit_amount: 'Entering Deposit Amount',
  deposit_await_payment: 'Waiting for Deposit Payment',
  appbeg_username: 'Entering AppBeg Username',
  confirm: 'Confirming'
};

export function formatWorkflowStepLabel(step) {
  const raw = String(step || '').trim();
  if (!raw) return 'Unknown step';
  if (STEP_LABELS[raw]) return STEP_LABELS[raw];
  return raw
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
