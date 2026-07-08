import { escapeHtml } from './playerUtils.js';

export function renderRegistrationModal(state) {
  const modal = state.registrationModal;
  if (!modal?.open) return '';

  const contact = modal.contact || {};
  const info = modal.prefill || {};
  const coadmin = modal.coadmin || {};
  const form = modal.form || {};
  const saving = modal.saving;

  return `
    <div class="modal-backdrop" id="registrationModalBackdrop" data-modal-backdrop>
      <div class="modal-card registration-modal" role="dialog" aria-modal="true" aria-labelledby="registrationModalTitle">
        <header class="modal-header">
          <div>
            <h2 id="registrationModalTitle">Manual Player Registration</h2>
            <div class="subtle">${escapeHtml(contact.display_name || 'Player')}</div>
          </div>
          <button type="button" class="modal-close" id="closeRegistrationModal" aria-label="Close">×</button>
        </header>

        <section class="modal-section modal-readonly">
          <div class="card-title">Player</div>
          ${modalInfoRow('Player Name', contact.display_name)}
          ${modalInfoRow('Telegram Username', contact.username ? '@' + contact.username : '—')}
          ${modalInfoRow('Telegram ID', contact.telegram_id)}
          ${modalInfoRow('Assigned Coadmin', coadmin.name || '—')}
          ${modalInfoRow('Coadmin Code', coadmin.code || '—')}
          ${modalInfoRow('AppBeg Coadmin UID', coadmin.uid || '—')}
        </section>

        <form id="registrationModalForm" class="modal-form">
          <label class="field-label">
            <span>AppBeg Username <em class="required">*</em></span>
            <input id="modalAppbegUsername" value="${escapeHtml(form.appbegUsername ?? info.preferred_appbeg_username ?? '')}" placeholder="AppBeg username" ${saving ? 'disabled' : ''} />
          </label>
          <label class="field-label">
            <span>Payment App Name / Payment Tag <em class="required">*</em></span>
            <input id="modalPaymentTag" value="${escapeHtml(form.paymentTag ?? info.payment_tag ?? '')}" placeholder="Payment app name or tag" ${saving ? 'disabled' : ''} />
          </label>
          <label class="field-label">
            <span>Registration Status</span>
            <select id="modalRegistrationStatus" ${saving ? 'disabled' : ''}>
              ${['Pending Verification', 'Registered'].map((status) => `
                <option value="${status}" ${(form.registrationStatus || 'Pending Verification') === status ? 'selected' : ''}>${status}</option>
              `).join('')}
            </select>
          </label>
          <label class="field-label">
            <span>Notes (optional)</span>
            <textarea id="modalRegistrationNotes" placeholder="Manual registration notes" ${saving ? 'disabled' : ''}>${escapeHtml(form.notes || '')}</textarea>
          </label>

          ${modal.duplicateError ? `
            <div class="modal-duplicate-warning">
              <div class="strong">Duplicate detected</div>
              <p>${escapeHtml(modal.duplicateError)}</p>
              <label class="checkbox-row">
                <input type="checkbox" id="modalAllowDuplicate" ${form.allowDuplicate ? 'checked' : ''} ${saving ? 'disabled' : ''} />
                <span>Override duplicate check and save anyway</span>
              </label>
            </div>
          ` : ''}

          ${modal.error ? `<div class="modal-error">${escapeHtml(modal.error)}</div>` : ''}

          <div class="modal-actions">
            <button type="button" class="button secondary" id="cancelRegistrationModal" ${saving ? 'disabled' : ''}>Cancel</button>
            <button type="submit" class="button" id="saveRegistrationModal" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save Registration'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function modalInfoRow(label, value) {
  return `<div class="info-row compact"><span>${label}</span><strong>${escapeHtml(String(value ?? '—'))}</strong></div>`;
}

export function readRegistrationModalForm() {
  return {
    appbegUsername: document.querySelector('#modalAppbegUsername')?.value?.trim() ?? '',
    paymentTag: document.querySelector('#modalPaymentTag')?.value?.trim() ?? '',
    registrationStatus: document.querySelector('#modalRegistrationStatus')?.value || 'Pending Verification',
    notes: document.querySelector('#modalRegistrationNotes')?.value?.trim() ?? '',
    allowDuplicate: Boolean(document.querySelector('#modalAllowDuplicate')?.checked)
  };
}
