import { escapeHtml } from './playerUtils.js';

export function createPaymentInfoController({ api, getState, setState, render, fmtDateTime }) {
  async function refreshPaymentMethods({ silent = false } = {}) {
    if (!silent) setState({ paymentMethodsLoading: true, paymentInfoError: null });
    try {
      const data = await api('/api/payment-methods');
      setState({
        paymentMethods: data.methods || [],
        paymentMethodsLoading: false
      });
    } catch (error) {
      setState({
        paymentMethodsLoading: false,
        paymentInfoError: error.toDisplayString?.() || error.message || 'Could not load payment methods.'
      });
    }
  }

  async function refreshPaymentMethodQrs(methodId, { silent = false } = {}) {
    if (!silent) setState({ paymentMethodsLoading: true, paymentInfoError: null });
    try {
      const data = await api(`/api/payment-methods/${methodId}/qrs`);
      setState({
        selectedPaymentMethodId: methodId,
        selectedPaymentMethod: data.method || null,
        paymentMethodQrs: data.qrs || [],
        paymentInfoView: 'manage',
        paymentMethodsLoading: false
      });
    } catch (error) {
      setState({
        paymentMethodsLoading: false,
        paymentInfoError: error.toDisplayString?.() || error.message || 'Could not load payment QR codes.'
      });
    }
  }

  function methodStatusDot(method) {
    if (!method.is_active) return '⚪';
    if (method.has_active_default) return '🟢';
    return '🟡';
  }

  function canManagePaymentInfo() {
    return getState().authUser?.role === 'admin';
  }

  function renderMethodsList(state) {
    const methods = state.paymentMethods || [];
    const missingDefault = methods.some((method) => method.is_active && !method.has_active_default);
    const admin = canManagePaymentInfo();

    return `
      <section class="payment-info-methods-panel card">
        <div class="payment-info-panel-header">
          <div class="card-title">Payment Methods</div>
          ${admin ? '<button type="button" class="button secondary small" data-payment-info-action="show-add-method">+ Add Payment Method</button>' : ''}
        </div>
        ${missingDefault ? '<div class="payment-info-warning">Some active payment methods do not have a default QR. Registration will skip those methods until a default QR is set.</div>' : ''}
        ${state.showAddPaymentMethod && admin ? renderAddMethodForm(state) : ''}
        ${state.paymentMethodsLoading && !methods.length ? '<div class="subtle">Loading payment methods…</div>' : ''}
        ${!state.paymentMethodsLoading && !methods.length
          ? '<div class="payment-info-empty">No payment methods yet. Add one to enable registration payments.</div>'
          : ''}
        <div class="payment-info-method-list">
          ${methods.map((method) => `
            <article class="payment-info-method-card ${method.is_active ? 'active' : 'inactive'}">
              <div class="payment-info-method-main">
                <div class="payment-info-method-title">${methodStatusDot(method)} ${escapeHtml(method.name)}</div>
                <div class="subtle">${method.qr_count} QR Code${method.qr_count === 1 ? '' : 's'}</div>
                <div class="subtle">${method.default_qr_label ? `Default: ${escapeHtml(method.default_qr_label)}` : 'No default QR'}</div>
              </div>
              <button type="button" class="button secondary small" data-payment-info-action="manage" data-payment-method-id="${method.id}">
                ${canManagePaymentInfo() ? 'Manage' : 'View'}
              </button>
            </article>
          `).join('')}
        </div>
      </section>
    `;
  }

  function renderAddMethodForm(state) {
    return `
      <form id="addPaymentMethodForm" class="settings-form payment-info-inline-form">
        <label class="field-label">
          <span>Name</span>
          <input id="paymentMethodName" name="name" placeholder="e.g. Cash App" maxlength="80" required />
        </label>
        <label class="field-label">
          <span>Key</span>
          <input id="paymentMethodKey" name="key" placeholder="e.g. cashapp" maxlength="40" />
          <span class="subtle">Optional. Auto-generated from name if blank.</span>
        </label>
        <div class="settings-actions">
          <button class="button" type="submit" ${state.paymentInfoSaving ? 'disabled' : ''}>${state.paymentInfoSaving ? 'Saving…' : 'Add Method'}</button>
          <button class="button secondary" type="button" data-payment-info-action="hide-add-method">Cancel</button>
        </div>
      </form>
    `;
  }

  function renderManageView(state) {
    const method = state.selectedPaymentMethod;
    const qrs = state.paymentMethodQrs || [];
    const admin = canManagePaymentInfo();
    if (!method) return '';

    return `
      <section class="payment-info-manage-panel card">
        <div class="payment-info-panel-header">
          <button type="button" class="button secondary small" data-payment-info-action="back">← Back</button>
          <div>
            <div class="card-title">${escapeHtml(method.name)}</div>
            <div class="subtle">${admin ? 'Manage QR codes for this payment method.' : 'View QR codes for this payment method.'}</div>
          </div>
        </div>

        ${admin ? `
        <details class="payment-info-upload-details" open>
          <summary>Upload QR</summary>
          <form id="paymentQrUploadForm" class="settings-form">
            <label class="field-label">
              <span>Label</span>
              <input id="paymentQrLabel" name="label" placeholder="e.g. Main QR" maxlength="120" />
            </label>
            <label class="field-label">
              <span>QR Image</span>
              <input id="paymentQrFile" name="file" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" required />
              <span class="subtle">PNG, JPG, JPEG, or WEBP. Max 5MB.</span>
            </label>
            <div class="settings-actions">
              <button class="button" type="submit" ${state.paymentInfoUploading ? 'disabled' : ''}>
                ${state.paymentInfoUploading ? 'Uploading…' : 'Upload QR'}
              </button>
            </div>
          </form>
        </details>
        ` : ''}

        ${!method.has_active_default
          ? '<div class="payment-info-warning">This payment method has no active default QR. Registration will show it as unavailable until you set a default.</div>'
          : ''}
        ${!qrs.length ? '<div class="payment-info-empty">No QR uploaded yet for this payment method.</div>' : ''}
        <div class="payment-info-grid">
          ${qrs.map((qr) => renderQrCard(qr, state)).join('')}
        </div>
      </section>
    `;
  }

  function renderQrCard(qr, state) {
    const busy = state.paymentInfoActionId === qr.id;
    const admin = canManagePaymentInfo();
    return `
      <article class="payment-info-card ${qr.is_active ? 'active' : 'inactive'}">
        <div class="payment-info-preview-wrap">
          <img class="payment-info-preview" src="${escapeHtml(qr.preview_url)}" alt="${escapeHtml(qr.label || 'Payment QR')}" loading="lazy" />
        </div>
        <div class="payment-info-card-body">
          <div class="payment-info-card-title">${escapeHtml(qr.label || 'Untitled QR')}</div>
          <div class="payment-info-badges">
            <span class="badge ${qr.is_active ? 'badge-success' : 'badge-muted'}">${qr.is_active ? 'Active' : 'Inactive'}</span>
            ${qr.is_default ? '<span class="badge badge-default">Default</span>' : ''}
            ${qr.in_use ? '<span class="badge badge-muted">In use</span>' : ''}
          </div>
          <div class="subtle payment-info-meta">Created ${fmtDateTime(qr.created_at)}</div>
          ${admin ? `
          <div class="payment-info-actions">
            ${!qr.is_default ? `<button type="button" class="button secondary small" data-payment-qr-action="default" data-payment-qr-id="${qr.id}" ${busy || !qr.is_active ? 'disabled' : ''}>Set Default</button>` : ''}
            <button type="button" class="button secondary small" data-payment-qr-action="toggle" data-payment-qr-id="${qr.id}" ${busy ? 'disabled' : ''}>${qr.is_active ? 'Deactivate' : 'Activate'}</button>
            <button type="button" class="button danger small" data-payment-qr-action="delete" data-payment-qr-id="${qr.id}" ${busy ? 'disabled' : ''}>Delete</button>
          </div>
          ` : ''}
        </div>
      </article>
    `;
  }

  function renderPaymentInfoWorkspace(state) {
    return `
      <main class="ops-main payment-info-main">
        <header class="topbar">
          <div>
            <div class="eyebrow">Payment Configuration</div>
            <h1>Payment Info</h1>
            <div class="subtle">Manage payment methods and QR codes used by the registration payment flow.</div>
          </div>
        </header>

        ${state.paymentInfoError ? `<div class="settings-error payment-info-banner">${escapeHtml(state.paymentInfoError)}</div>` : ''}
        ${state.paymentInfoSuccess ? `<div class="settings-success payment-info-banner">${escapeHtml(state.paymentInfoSuccess)}</div>` : ''}

        <section class="payment-info-layout ${state.paymentInfoView === 'manage' ? 'manage-view' : 'list-view'}">
          ${renderMethodsList(state)}
          ${state.paymentInfoView === 'manage' ? renderManageView(state) : ''}
        </section>
      </main>
    `;
  }

  async function addPaymentMethod(form) {
    const name = form.querySelector('#paymentMethodName')?.value?.trim();
    const key = form.querySelector('#paymentMethodKey')?.value?.trim();
    if (!name) {
      setState({ paymentInfoError: 'Payment method name is required.', paymentInfoSuccess: null });
      render();
      return;
    }
    setState({ paymentInfoSaving: true, paymentInfoError: null, paymentInfoSuccess: null });
    render();
    try {
      await api('/api/payment-methods', {
        method: 'POST',
        body: JSON.stringify({ name, key: key || undefined })
      });
      setState({
        paymentInfoSaving: false,
        showAddPaymentMethod: false,
        paymentInfoSuccess: `${name} added.`
      });
      await refreshPaymentMethods({ silent: true });
    } catch (error) {
      setState({
        paymentInfoSaving: false,
        paymentInfoError: error.toDisplayString?.() || error.message || 'Could not add payment method.'
      });
    }
    render();
  }

  async function uploadPaymentQr(form) {
    const methodId = getState().selectedPaymentMethodId;
    const file = form.querySelector('#paymentQrFile')?.files?.[0];
    const label = form.querySelector('#paymentQrLabel')?.value?.trim();
    if (!methodId || !file) {
      setState({ paymentInfoError: 'Choose an image file to upload.', paymentInfoSuccess: null });
      render();
      return;
    }
    const body = new FormData();
    body.append('file', file);
    if (label) body.append('label', label);

    setState({ paymentInfoUploading: true, paymentInfoError: null, paymentInfoSuccess: null });
    render();
    try {
      await api(`/api/payment-methods/${methodId}/qrs`, { method: 'POST', headers: {}, body });
      form.reset();
      setState({ paymentInfoUploading: false, paymentInfoSuccess: 'QR uploaded successfully.' });
      await refreshPaymentMethodQrs(methodId, { silent: true });
      await refreshPaymentMethods({ silent: true });
    } catch (error) {
      setState({
        paymentInfoUploading: false,
        paymentInfoError: error.toDisplayString?.() || error.message || 'Upload failed.'
      });
    }
    render();
  }

  async function runPaymentQrAction(action, id) {
    const qr = (getState().paymentMethodQrs || []).find((item) => Number(item.id) === Number(id));
    if (!qr) return;

    if (action === 'toggle' && qr.is_default && qr.is_active) {
      const proceed = window.confirm(
        'This QR is the current default. Deactivating it may make this payment method unavailable for registration until you set another default. Continue?'
      );
      if (!proceed) return;
    }

    if (action === 'delete') {
      const message = qr.is_default
        ? 'Set another QR as default before deleting this one.'
        : qr.in_use
          ? 'This QR is referenced by payment flows. Active unresolved flows will be moved to the current default QR when possible. Continue?'
          : 'Delete this QR permanently?';
      if (qr.is_default) {
        setState({ paymentInfoError: message, paymentInfoSuccess: null });
        render();
        return;
      }
      if (!window.confirm(message)) return;
    }

    setState({ paymentInfoActionId: id, paymentInfoError: null, paymentInfoSuccess: null });
    render();

    try {
      if (action === 'default') {
        await api(`/api/payment-qrs/${id}/default`, { method: 'POST', body: JSON.stringify({}) });
        setState({ paymentInfoSuccess: 'Default QR updated.' });
      } else if (action === 'toggle') {
        await api(`/api/payment-qrs/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            is_active: !qr.is_active,
            force: qr.is_active && qr.is_default
          })
        });
        setState({ paymentInfoSuccess: qr.is_active ? 'QR deactivated.' : 'QR activated.' });
      } else if (action === 'delete') {
        const result = await api(`/api/payment-qrs/${id}`, { method: 'DELETE' });
        setState({
          paymentInfoSuccess: result.action === 'replaced_deleted'
            ? 'Active payment flows were moved to the current default QR. Old QR deleted.'
            : result.action === 'replaced_archived'
              ? 'Active payment flows were moved to the current default QR. Old QR archived for historical records.'
              : result.action === 'archived'
                ? 'QR archived for historical records.'
              : 'QR deleted.'
        });
      }
      const methodId = getState().selectedPaymentMethodId;
      if (methodId) await refreshPaymentMethodQrs(methodId, { silent: true });
      await refreshPaymentMethods({ silent: true });
    } catch (error) {
      setState({
        paymentInfoError: error.toDisplayString?.() || error.message || 'Action failed.'
      });
    } finally {
      setState({ paymentInfoActionId: null });
      render();
    }
  }

  function bindPaymentInfoEvents(root) {
    root.querySelector('#addPaymentMethodForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void addPaymentMethod(event.currentTarget);
    });

    root.querySelector('#paymentQrUploadForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void uploadPaymentQr(event.currentTarget);
    });

    root.querySelectorAll('[data-payment-info-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.paymentInfoAction;
        if (action === 'show-add-method') {
          setState({ showAddPaymentMethod: true, paymentInfoError: null, paymentInfoSuccess: null });
          render();
        } else if (action === 'hide-add-method') {
          setState({ showAddPaymentMethod: false });
          render();
        } else if (action === 'manage') {
          void refreshPaymentMethodQrs(Number(button.dataset.paymentMethodId));
          render();
        } else if (action === 'back') {
          setState({
            paymentInfoView: 'list',
            selectedPaymentMethodId: null,
            selectedPaymentMethod: null,
            paymentMethodQrs: []
          });
          render();
        }
      });
    });

    root.querySelectorAll('[data-payment-qr-action]').forEach((button) => {
      button.addEventListener('click', () => {
        void runPaymentQrAction(button.dataset.paymentQrAction, button.dataset.paymentQrId);
      });
    });
  }

  return {
    refreshPaymentMethods,
    refreshPaymentMethodQrs,
    renderPaymentInfoWorkspace,
    bindPaymentInfoEvents
  };
}
