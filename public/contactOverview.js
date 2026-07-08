import { escapeHtml, statusBadge } from './playerUtils.js';

export const REGISTRATION_WIZARD_STEPS = [
  {
    key: 'welcome',
    title: 'Welcome',
    description: 'Start the registration process for this player.',
    field: null
  },
  {
    key: 'username',
    title: 'Collect username',
    description: 'Enter the player’s preferred AppBeg username.',
    field: 'appbegUsername',
    required: true,
    placeholder: 'AppBeg username'
  },
  {
    key: 'payment_app',
    title: 'Collect payment application',
    description: 'Note which payment app or channel they use.',
    field: 'paymentApp',
    required: false,
    placeholder: 'Payment app (optional)'
  },
  {
    key: 'payment_tag',
    title: 'Collect payment tag',
    description: 'Enter the payment name / tag used for deposits.',
    field: 'paymentTag',
    required: true,
    placeholder: 'Payment tag'
  },
  {
    key: 'review',
    title: 'Review information',
    description: 'Confirm the details before completing registration.',
    field: null
  },
  {
    key: 'complete',
    title: 'Complete registration',
    description: 'Save registration and mark this player registered.',
    field: null
  }
];

export function isRegistrationComplete(contact) {
  return contact?.registration_status === 'Registered';
}

export function registrationWizardIndex(stepKey) {
  const index = REGISTRATION_WIZARD_STEPS.findIndex((step) => step.key === stepKey);
  return index >= 0 ? index : 0;
}

export function renderContactOverview({ contact, automationState, wizard, coadminSettings = {}, loading = false }) {
  if (loading && !contact) {
    return `
      <section class="contact-overview-panel">
        <div class="contact-overview-card">
          <div class="subtle">Loading contact overview…</div>
        </div>
      </section>
    `;
  }

  if (!contact) {
    return `
      <section class="contact-overview-panel">
        <div class="contact-overview-empty">
          <h2>Select a contact</h2>
          <p class="subtle">Choose a Telegram contact to see registration status and next actions.</p>
        </div>
      </section>
    `;
  }

  if (wizard?.active) {
    return renderRegistrationWizard({ contact, automationState, wizard, coadminSettings });
  }

  const registered = isRegistrationComplete(contact);
  const info = automationState?.registration_info || {};

  return `
    <section class="contact-overview-panel">
      <header class="overview-header">
        <button type="button" class="icon-back mobile-only" data-mobile-back="contacts" aria-label="Back to contacts">←</button>
        <div class="overview-identity min-w-0">
          <div class="eyebrow">Contact overview</div>
          <h2 class="overview-name">${escapeHtml(contact.display_name || 'Contact')}</h2>
          <div class="subtle">${contact.username ? '@' + escapeHtml(contact.username) : 'No username'} · ${statusBadge(contact.registration_status)}</div>
        </div>
      </header>

      ${registered ? renderRegisteredCard(contact, info) : renderUnregisteredCard(contact, info)}

      <section class="card overview-meta-card">
        <div class="card-title">Quick context</div>
        ${infoRow('Telegram ID', contact.telegram_id)}
        ${infoRow('Last message', contact.last_message || 'No messages yet')}
        ${infoRow('AppBeg username', info.preferred_appbeg_username || contact.appbeg_account_id || '—')}
        ${infoRow('Payment tag', info.payment_tag || '—')}
      </section>
    </section>
  `;
}

function renderRegisteredCard(contact, info) {
  return `
    <section class="status-card status-card-success">
      <div class="status-card-icon" aria-hidden="true">✅</div>
      <div class="status-card-body">
        <h3>This player is already registered.</h3>
        <p>Registration is complete. Open the conversation when you need to assist, or review the player profile.</p>
        <div class="status-card-meta">
          ${infoRow('Registered at', contact.registered_at ? formatShort(contact.registered_at) : '—')}
          ${infoRow('AppBeg', info.preferred_appbeg_username || contact.appbeg_account_id || '—')}
        </div>
        <div class="status-card-actions">
          <button type="button" class="button" data-overview-action="open-chat">Open Conversation</button>
          <button type="button" class="button secondary" data-overview-action="view-profile">View Player Profile</button>
        </div>
      </div>
    </section>
  `;
}

function renderUnregisteredCard(contact, info) {
  return `
    <section class="status-card status-card-warning">
      <div class="status-card-icon" aria-hidden="true">👋</div>
      <div class="status-card-body">
        <h3>Welcome!</h3>
        <p>It looks like you're not registered with us yet.</p>
        <p class="status-card-lead">Please click <strong>Register</strong> to begin creating your account.</p>
        <div class="status-card-meta">
          ${infoRow('Current status', contact.registration_status || 'New')}
          ${infoRow('Progress', summarizeProgress(info, contact))}
        </div>
        <div class="status-card-actions">
          <button type="button" class="button" data-overview-action="start-register">Register</button>
          <button type="button" class="button secondary" data-overview-action="open-chat">Open Conversation</button>
        </div>
      </div>
    </section>
  `;
}

function renderRegistrationWizard({ contact, automationState, wizard, coadminSettings }) {
  const stepIndex = registrationWizardIndex(wizard.step);
  const step = REGISTRATION_WIZARD_STEPS[stepIndex];
  const form = wizard.form || {};
  const info = automationState?.registration_info || {};
  const percent = Math.round(((stepIndex + 1) / REGISTRATION_WIZARD_STEPS.length) * 100);
  const saving = Boolean(wizard.saving);

  return `
    <section class="contact-overview-panel registration-wizard-panel">
      <header class="overview-header">
        <button type="button" class="icon-back" data-overview-action="exit-wizard" aria-label="Exit registration">←</button>
        <div class="overview-identity min-w-0">
          <div class="eyebrow">Registration flow</div>
          <h2 class="overview-name">${escapeHtml(contact.display_name || 'Player')}</h2>
          <div class="subtle">Step ${stepIndex + 1} of ${REGISTRATION_WIZARD_STEPS.length}: ${escapeHtml(step.title)}</div>
        </div>
      </header>

      <div class="wizard-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
        <div class="wizard-progress-bar" style="width:${percent}%"></div>
      </div>
      <div class="wizard-steps">
        ${REGISTRATION_WIZARD_STEPS.map((item, index) => `
          <span class="wizard-step-pill ${index < stepIndex ? 'done' : ''} ${index === stepIndex ? 'current' : ''}">
            ${index + 1}. ${escapeHtml(item.title)}
          </span>
        `).join('')}
      </div>

      <section class="card wizard-step-card">
        <div class="card-title">${escapeHtml(step.title)}</div>
        <p class="subtle wizard-step-copy">${escapeHtml(step.description)}</p>
        ${renderWizardStepBody({ step, form, info, contact, coadminSettings, saving })}
        ${wizard.error ? `<div class="modal-error">${escapeHtml(wizard.error)}</div>` : ''}
        <div class="wizard-actions">
          ${stepIndex > 0 ? `<button type="button" class="button secondary" data-overview-action="wizard-back" ${saving ? 'disabled' : ''}>Back</button>` : ''}
          ${step.key === 'complete'
    ? `<button type="button" class="button" data-overview-action="wizard-complete" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Complete registration'}</button>`
    : `<button type="button" class="button" data-overview-action="wizard-next" ${saving ? 'disabled' : ''}>Next</button>`}
        </div>
      </section>
    </section>
  `;
}

function renderWizardStepBody({ step, form, info, contact, coadminSettings, saving }) {
  if (step.key === 'welcome') {
    return `
      <div class="wizard-welcome">
        <p>You are about to register <strong>${escapeHtml(contact.display_name || 'this player')}</strong>.</p>
        <p class="subtle">Only the fields needed for onboarding will be shown. Chat stays available if you need it later.</p>
      </div>
    `;
  }

  if (step.field) {
    const value = form[step.field] ?? '';
    return `
      <label class="field-label">
        <span>${escapeHtml(step.title)}${step.required ? ' <em class="required">*</em>' : ''}</span>
        <input
          id="wizardFieldInput"
          data-wizard-field="${escapeHtml(step.field)}"
          value="${escapeHtml(value)}"
          placeholder="${escapeHtml(step.placeholder || '')}"
          ${saving ? 'disabled' : ''}
        />
      </label>
    `;
  }

  if (step.key === 'review' || step.key === 'complete') {
    const settings = coadminSettings || {};
    return `
      <div class="wizard-review">
        ${infoRow('Player', contact.display_name)}
        ${infoRow('Telegram', contact.username ? '@' + contact.username : contact.telegram_id)}
        ${infoRow('AppBeg username', form.appbegUsername || info.preferred_appbeg_username || '—')}
        ${infoRow('Payment app', form.paymentApp || info.preferred_game || '—')}
        ${infoRow('Payment tag', form.paymentTag || info.payment_tag || '—')}
        ${infoRow('Assigned coadmin', info.coadmin_name || settings.coadmin_name || '—')}
        ${step.key === 'complete' ? '<p class="subtle">Completing will mark this contact as <strong>Registered</strong>.</p>' : ''}
      </div>
    `;
  }

  return '';
}

function summarizeProgress(info, contact) {
  const hasUsername = Boolean(info.preferred_appbeg_username || contact.appbeg_account_id);
  const hasTag = Boolean(info.payment_tag);
  if (hasUsername && hasTag) return 'Ready to review';
  if (hasUsername || hasTag) return 'In progress';
  return 'Not started';
}

function infoRow(label, value) {
  const isHtml = typeof value === 'string' && value.includes('status-badge');
  return `<div class="info-row"><span>${label}</span><strong>${isHtml ? value : escapeHtml(String(value ?? '—'))}</strong></div>`;
}

function formatShort(value) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return String(value);
  }
}

export function createEmptyWizardForm(contact, automationState) {
  const info = automationState?.registration_info || {};
  return {
    appbegUsername: info.preferred_appbeg_username || contact?.appbeg_account_id || '',
    paymentApp: info.preferred_game || '',
    paymentTag: info.payment_tag || ''
  };
}
