import { escapeHtml } from './playerUtils.js';

export function createPaymentInfoController({ api, getState, setState, render, fmtDateTime }) {
  async function refreshChimeQrs({ silent = false } = {}) {
    if (!silent) setState({ chimeQrLoading: true, chimeQrError: null });
    try {
      const data = await api('/api/payment-info/chime-qrs');
      setState({
        chimeQrs: data.qrs || [],
        hasActiveDefaultChimeQr: Boolean(data.has_active_default),
        chimeQrLoading: false
      });
    } catch (error) {
      setState({
        chimeQrLoading: false,
        chimeQrError: error.toDisplayString?.() || error.message || 'Could not load Chime QR codes.'
      });
    }
  }

  function renderPaymentInfoWorkspace(state) {
    const qrs = state.chimeQrs || [];
    const warning = !state.hasActiveDefaultChimeQr
      ? `<div class="payment-info-warning">Registration payment flow is disabled until a default Chime QR is active.</div>`
      : '';

    return `
      <main class="ops-main payment-info-main">
        <header class="topbar">
          <div>
            <div class="eyebrow">Payment Configuration</div>
            <h1>Payment Info</h1>
            <div class="subtle">Upload and manage Chime QR codes used by the registration payment flow.</div>
          </div>
        </header>

        <section class="payment-info-layout">
          <section class="card payment-info-upload-card">
            <div class="card-title">Upload Chime QR</div>
            <form id="chimeQrUploadForm" class="settings-form">
              <label class="field-label">
                <span>Label / Name</span>
                <input id="chimeQrLabel" name="label" placeholder="e.g. Main Chime QR" maxlength="120" />
              </label>
              <label class="field-label">
                <span>QR Image</span>
                <input id="chimeQrFile" name="file" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" required />
                <span class="subtle">PNG, JPG, JPEG, or WEBP. Max 5MB.</span>
              </label>
              ${state.chimeQrError ? `<div class="settings-error">${escapeHtml(state.chimeQrError)}</div>` : ''}
              ${state.chimeQrSuccess ? `<div class="settings-success">${escapeHtml(state.chimeQrSuccess)}</div>` : ''}
              <div class="settings-actions">
                <button class="button" type="submit" ${state.chimeQrUploading ? 'disabled' : ''}>
                  ${state.chimeQrUploading ? 'Uploading…' : 'Upload QR'}
                </button>
              </div>
            </form>
          </section>

          <section class="card payment-info-list-card">
            <div class="payment-info-list-header">
              <div class="card-title">Chime QR Codes</div>
              ${warning}
            </div>
            ${state.chimeQrLoading ? '<div class="subtle">Loading QR codes…</div>' : ''}
            ${!state.chimeQrLoading && !qrs.length
              ? '<div class="payment-info-empty">No Chime QR uploaded yet. Upload one to enable registration payments.</div>'
              : ''}
            <div class="payment-info-grid">
              ${qrs.map((qr) => chimeQrCard(qr, state)).join('')}
            </div>
          </section>
        </section>
      </main>
    `;
  }

  function chimeQrCard(qr, state) {
    const busyId = state.chimeQrActionId;
    const isBusy = busyId === qr.id;
    const statusClass = qr.is_active ? 'active' : 'inactive';
    return `
      <article class="payment-info-card ${statusClass}" data-chime-qr-id="${qr.id}">
        <div class="payment-info-preview-wrap">
          <img class="payment-info-preview" src="${escapeHtml(qr.preview_url)}" alt="${escapeHtml(qr.label || 'Chime QR')}" loading="lazy" />
        </div>
        <div class="payment-info-card-body">
          <div class="payment-info-card-title">${escapeHtml(qr.label || 'Untitled QR')}</div>
          <div class="payment-info-badges">
            <span class="badge ${qr.is_active ? 'badge-success' : 'badge-muted'}">${qr.is_active ? 'Active' : 'Inactive'}</span>
            ${qr.is_default ? '<span class="badge badge-default">Default</span>' : ''}
            ${qr.in_use ? '<span class="badge badge-muted">In use</span>' : ''}
          </div>
          <div class="subtle payment-info-meta">Created ${fmtDateTime(qr.created_at)}</div>
          <div class="payment-info-actions">
            ${!qr.is_default
              ? `<button type="button" class="button secondary small" data-chime-qr-action="default" data-chime-qr-id="${qr.id}" ${isBusy || !qr.is_active ? 'disabled' : ''}>Set as Default</button>`
              : ''}
            <button type="button" class="button secondary small" data-chime-qr-action="toggle" data-chime-qr-id="${qr.id}" ${isBusy ? 'disabled' : ''}>
              ${qr.is_active ? 'Deactivate' : 'Activate'}
            </button>
            <button type="button" class="button danger small" data-chime-qr-action="delete" data-chime-qr-id="${qr.id}" ${isBusy ? 'disabled' : ''}>Delete</button>
          </div>
        </div>
      </article>
    `;
  }

  async function uploadChimeQr(form) {
    const fileInput = form.querySelector('#chimeQrFile');
    const labelInput = form.querySelector('#chimeQrLabel');
    const file = fileInput?.files?.[0];
    if (!file) {
      setState({ chimeQrError: 'Choose an image file to upload.', chimeQrSuccess: null });
      render();
      return;
    }

    const body = new FormData();
    body.append('file', file);
    if (labelInput?.value?.trim()) {
      body.append('label', labelInput.value.trim());
    }

    setState({ chimeQrUploading: true, chimeQrError: null, chimeQrSuccess: null });
    render();

    try {
      const data = await api('/api/payment-info/chime-qrs/upload', {
        method: 'POST',
        headers: {},
        body
      });
      setState({
        chimeQrUploading: false,
        chimeQrSuccess: 'Chime QR uploaded successfully.',
        chimeQrError: null
      });
      form.reset();
      await refreshChimeQrs({ silent: true });
    } catch (error) {
      setState({
        chimeQrUploading: false,
        chimeQrError: error.toDisplayString?.() || error.message || 'Upload failed.'
      });
    }
    render();
  }

  async function runChimeQrAction(action, id) {
    const qr = (getState().chimeQrs || []).find((item) => Number(item.id) === Number(id));
    if (!qr) return;

    if (action === 'toggle' && qr.is_default && qr.is_active) {
      const others = (getState().chimeQrs || []).filter((item) => item.id !== qr.id && item.is_active);
      if (!others.length) {
        const proceed = window.confirm(
          'This is the only active default Chime QR. Deactivating it will disable registration payments until another default QR is active. Continue?'
        );
        if (!proceed) return;
      } else if (!others.some((item) => item.is_default)) {
        const proceed = window.confirm(
          'This QR is the current default. Deactivating it will disable registration payments until you set another default. Continue?'
        );
        if (!proceed) return;
      }
    }

    if (action === 'delete') {
      const message = qr.in_use
        ? 'This QR was used in registration payments. It will be deactivated instead of permanently deleted. Continue?'
        : 'Delete this Chime QR permanently?';
      if (!window.confirm(message)) return;
    }

    setState({ chimeQrActionId: id, chimeQrError: null, chimeQrSuccess: null });
    render();

    try {
      if (action === 'default') {
        await api(`/api/payment-info/chime-qrs/${id}/default`, { method: 'POST', body: JSON.stringify({}) });
        setState({ chimeQrSuccess: 'Default Chime QR updated.' });
      } else if (action === 'toggle') {
        const deactivating = qr.is_active;
        await api(`/api/payment-info/chime-qrs/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            is_active: !deactivating,
            force: deactivating && qr.is_default
          })
        });
        setState({ chimeQrSuccess: qr.is_active ? 'Chime QR deactivated.' : 'Chime QR activated.' });
      } else if (action === 'delete') {
        const result = await api(`/api/payment-info/chime-qrs/${id}`, { method: 'DELETE' });
        setState({
          chimeQrSuccess: result.action === 'deactivated'
            ? 'Chime QR deactivated because it was used in registration payments.'
            : 'Chime QR deleted.'
        });
      }
      await refreshChimeQrs({ silent: true });
    } catch (error) {
      setState({
        chimeQrError: error.toDisplayString?.() || error.message || 'Action failed.'
      });
    } finally {
      setState({ chimeQrActionId: null });
      render();
    }
  }

  function bindPaymentInfoEvents(root) {
    root.querySelector('#chimeQrUploadForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void uploadChimeQr(event.currentTarget);
    });

    root.querySelectorAll('[data-chime-qr-action]').forEach((button) => {
      button.addEventListener('click', () => {
        void runChimeQrAction(button.dataset.chimeQrAction, button.dataset.chimeQrId);
      });
    });
  }

  return {
    refreshChimeQrs,
    renderPaymentInfoWorkspace,
    bindPaymentInfoEvents
  };
}
