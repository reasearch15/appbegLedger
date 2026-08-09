import assert from 'node:assert/strict';
import { creditAppBegDepositViaApi } from '../src/appbeg/depositCreditClient.js';
import { registrationCreditCents, parseMoneyToCents, centsToDollars } from '../src/registration/utils.js';

async function testCreditApiSendsPaymentSeparateFromCoinCredit() {
  process.env.APPBEG_API_URL = 'https://appbeg.test';
  process.env.APPBEG_LEDGER_INTERNAL_TOKEN = 'token';
  let body = null;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          status: 'credited',
          amount: body.amount,
          financialEventId: 'fe-1',
          externalReference: body.externalReference,
          playerUid: body.playerUid
        });
      }
    };
  };

  const paymentCents = parseMoneyToCents('5.50');
  const creditCents = registrationCreditCents(paymentCents);
  assert.equal(paymentCents, 550);
  assert.equal(creditCents, 600);

  const result = await creditAppBegDepositViaApi({
    playerUid: 'player-1',
    amount: centsToDollars(creditCents),
    paymentAmount: centsToDollars(paymentCents),
    paymentCents,
    externalReference: 'appbegledger-payment-event:1530',
    sourceFlow: 'registration_initial_deposit',
    ledgerContactId: 39,
    paymentEventId: 1530,
    windowId: 68,
    actorName: 'Test'
  });

  assert.equal(body.amount, 6, 'player coin credit stays 6');
  assert.equal(body.paymentAmount, 5.5, 'actual payment sent separately');
  assert.equal(body.paymentCents, 550);
  assert.equal(result.amount, 6);
  assert.equal(result.paymentAmount, 5.5);
  assert.equal(result.paymentCents, 550);
}

async function testRegistrationCreditHelperUnchanged() {
  assert.equal(registrationCreditCents(550), 600);
  assert.equal(registrationCreditCents(540), 600);
  assert.equal(registrationCreditCents(1000), 1000);
  assert.equal(registrationCreditCents(1025), 1100);
}

async function main() {
  await testRegistrationCreditHelperUnchanged();
  await testCreditApiSendsPaymentSeparateFromCoinCredit();
  console.log('deposit credit payment vs coin separation: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
