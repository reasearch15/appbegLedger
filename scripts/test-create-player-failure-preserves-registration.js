import assert from 'node:assert/strict';

function mergeCreatePlayerFailureRegistrationInfo(currentInfo, decisionInfo, error) {
  return {
    ...currentInfo,
    ...decisionInfo,
    create_account_in_progress: false,
    create_account_error: String(error.message || 'AppBeg player creation failed.').slice(0, 500)
  };
}

const currentInfo = {
  payment_confirmed: true,
  registration_payment_window_id: 12,
  matched_payment_event_id: 867,
  first_deposit_amount: 5,
  requested_deposit_amount: 5,
  preferred_appbeg_username: 'Amyfied01',
  appbeg_password: 'Amyfied01',
  referral_code: null,
  appbeg_coadmin_uid: 'pNaCcFpMHccu5l3TgLSKvldtrOB2',
  registration_method: 'chatbot',
  create_account_in_progress: true
};

const merged = mergeCreatePlayerFailureRegistrationInfo(currentInfo, {}, new Error('store.logEvent is not a function'));

assert.equal(merged.create_account_in_progress, false);
assert.equal(merged.create_account_error, 'store.logEvent is not a function');
assert.equal(merged.payment_confirmed, true);
assert.equal(merged.registration_payment_window_id, 12);
assert.equal(merged.matched_payment_event_id, 867);
assert.equal(merged.first_deposit_amount, 5);
assert.equal(merged.requested_deposit_amount, 5);
assert.equal(merged.preferred_appbeg_username, 'Amyfied01');
assert.equal(merged.appbeg_password, 'Amyfied01');
assert.equal(merged.referral_code, null);
assert.equal(merged.appbeg_coadmin_uid, 'pNaCcFpMHccu5l3TgLSKvldtrOB2');
assert.equal(merged.registration_method, 'chatbot');

console.log('ok create-player failure preserves registration info');
