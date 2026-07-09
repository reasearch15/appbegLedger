import { statusBadge, progressBar, progressChecklist } from './playerUtils.js';
import { renderAvatar as avatar } from './avatarUtils.js';
import { renderRegistrationModal, readRegistrationModalForm } from './registrationModal.js';
import { createPlayersController } from './playersRegistry.js';
import { createPaymentInfoController } from './paymentInfo.js';
import { createAppBegPlayersController } from './appbegPlayersLedger.js';
import {
  renderContactOverview,
  createEmptyWizardForm,
  registrationWizardIndex,
  REGISTRATION_WIZARD_STEPS,
  isRegistrationComplete
} from './contactOverview.js';

const app = document.querySelector('#app');
const socket = io({ withCredentials: true });

const registrationFilters = ['All', 'New', 'Collecting Info', 'Pending', 'Pending Verification', 'Registered', 'Suspended', 'Archived'];
const conversationFilters = ['All', 'Open', 'Waiting', 'Closed'];
const paymentStatusFilters = ['All', 'New', 'Parsed', 'Matched', 'Failed'];
const paymentRoutingFilters = ['All', 'appbeg_owned', 'not_our_appbeg', 'expired_deposit', 'parse_failed', 'route_failed', 'unrouted'];

let state = {
  section: 'contacts',
  mobileContactsPane: 'list',
  mobilePaymentsPane: 'list',
  mobilePlayersPane: 'list',
  navOpen: false,
  contacts: [],
  stats: {},
  sync: {},
  syncLogs: [],
  payments: [],
  paymentStats: {},
  paymentSync: {},
  selectedPaymentId: null,
  payment: null,
  paymentLogs: [],
  paymentRoutingLogs: [],
  paymentQuery: '',
  paymentStatusFilter: 'All',
  paymentRoutingFilter: 'All',
  paymentExceptionsOnly: false,
  selectedContactId: null,
  contact: null,
  contactLoading: false,
  messages: [],
  notes: [],
  timeline: [],
  automationState: null,
  automationLogs: [],
  allTags: [],
  quickReplies: [],
  query: '',
  registrationFilter: 'All',
  conversationFilter: 'All',
  assigneeFilter: 'All',
  staffName: localStorage.getItem('staffName') || 'Staff',
  draft: '',
  sendingMessage: false,
  players: [],
  playerStats: {},
  playerFilter: 'All',
  playerQuery: '',
  selectedPlayerId: null,
  selectedPlayerDetail: null,
  playersLoading: false,
  playerDetailLoading: false,
  playerScrollTop: 0,
  registrationSettings: {},
  coadminSettings: {},
  settingsAuditLog: [],
  settingsSaving: false,
  coadminBackfillResult: null,
  coadminApplying: false,
  settingsSuccess: null,
  settingsError: null,
  registrationModal: null,
  registrationWizard: null,
  paymentMethods: [],
  paymentMethodsLoading: false,
  selectedPaymentMethodId: null,
  selectedPaymentMethod: null,
  paymentMethodQrs: [],
  paymentInfoView: 'list',
  paymentInfoSaving: false,
  paymentInfoUploading: false,
  paymentInfoActionId: null,
  showAddPaymentMethod: false,
  paymentInfoError: null,
  paymentInfoSuccess: null,
  authUser: null,
  ledgerUsers: [],
  ledgerUsersLoading: false,
  ledgerUserForm: null,
  ledgerUserSaving: false,
  appbegPlayers: [],
  appbegPlayersLoading: false,
  appbegPlayersError: null,
  appbegPlayersConfigured: null,
  appbegPlayersPagination: null,
  appbegPlayersFilters: { statuses: [], coadmins: [] },
  appbegPlayersQuery: '',
  appbegPlayersStatus: '',
  appbegPlayersCoadmin: '',
  appbegPlayersSort: 'created_at',
  appbegPlayersDir: 'desc',
  appbegPlayersPage: 1,
  appbegPlayersLimit: 100,
  appbegPlayersDetail: null,
  appbegPlayersDrawerOpen: false
};

let playersController;
let paymentInfoController;
let appbegPlayersController;

let composerEventsBound = false;
let sendingMessage = false;
let lastReadMarkedContactId = null;
let selectedContactRequestId = 0;
let contactsRefreshPromise = null;
let statsRefreshPromise = null;
let syncStatusRefreshPromise = null;
let selectedContactRefreshPromise = null;
let selectedContactRefreshId = null;
let lastContactsRefreshAt = 0;
let lastStatsRefreshAt = 0;
let lastSyncStatusRefreshAt = 0;
let contactsRefreshTimer = null;
let statsRefreshTimer = null;
let syncStatusRefreshTimer = null;
let telegramSyncRefreshTimer = null;
let pendingTelegramSyncRefresh = null;
let globalPollInterval = null;
let suppressContactsRefreshUntil = 0;
const contactDetailCache = new Map();
const CONTACTS_REFRESH_DEBOUNCE_MS = 1000;
const STATS_REFRESH_DEBOUNCE_MS = 3000;
const SYNC_STATUS_REFRESH_DEBOUNCE_MS = 5000;
const REFRESH_DEDUPE_MS = 1000;
const CONTACTS_POLL_MS = 30000;
const CONTACT_DETAIL_CACHE_MS = 5000;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit', year: 'numeric' }).format(new Date(value));
}

function fmtDateTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function fmtTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function dayKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function normalizeContact(contact) {
  if (!contact) return contact;
  return {
    ...contact,
    id: Number(contact.id),
    conversation_id: contact.conversation_id == null ? null : Number(contact.conversation_id),
    total_messages: Number(contact.total_messages || 0),
    unread_count: Number(contact.unread_count || 0)
  };
}

function normalizeContactId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function cacheContactDetail(contactId, detail) {
  const id = normalizeContactId(contactId);
  if (!id || !detail?.contact) return;
  contactDetailCache.set(id, {
    savedAt: Date.now(),
    detail: {
      contact: normalizeContact(detail.contact),
      messages: detail.messages || [],
      notes: detail.notes || [],
      timeline: detail.timeline || [],
      automationState: detail.automationState,
      automationLogs: detail.automationLogs || [],
      tags: detail.tags || [],
      quickReplies: detail.quickReplies || []
    }
  });
}

function getCachedContactDetail(contactId) {
  const id = normalizeContactId(contactId);
  if (!id) return null;
  const cached = contactDetailCache.get(id);
  if (!cached || Date.now() - cached.savedAt > CONTACT_DETAIL_CACHE_MS) {
    contactDetailCache.delete(id);
    return null;
  }
  return cached.detail;
}

function applyContactDetail(detail) {
  if (!detail?.contact) return;
  state.contact = normalizeContact(detail.contact);
  state.messages = detail.messages || [];
  state.notes = detail.notes || [];
  state.timeline = detail.timeline || [];
  state.automationState = detail.automationState;
  state.automationLogs = detail.automationLogs || [];
  state.allTags = detail.tags || [];
  state.quickReplies = detail.quickReplies || [];
  state.contactLoading = false;
}

function logRefresh(kind, reason) {
}

class ApiError extends Error {
  constructor({ path, status, message, body = null }) {
    super(message || 'Request failed.');
    this.name = 'ApiError';
    this.path = path;
    this.status = status;
    this.body = body;
  }

  toDisplayString() {
    const parts = [
      this.path,
      this.status ? `HTTP ${this.status}` : 'Network error',
      this.message
    ];
    return parts.filter(Boolean).join(' — ');
  }
}

async function api(path, options = {}) {
  let response;
  const headers = { ...(options.headers || {}) };
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (!isFormData && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: 'include'
    });
  } catch (networkError) {
    const error = new ApiError({
      path,
      status: 0,
      message: networkError.message || 'Network request failed',
      body: null
    });
    console.error('[api] request failed:', error.toDisplayString());
    throw error;
  }

  const rawText = await response.text();
  let data = {};
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { error: rawText };
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/login')) {
      window.location.href = '/login';
      throw new ApiError({
        path,
        status: response.status,
        message: 'Session expired.',
        body: data
      });
    }
    const error = new ApiError({
      path,
      status: response.status,
      message: data.error || data.message || `HTTP ${response.status}`,
      body: data
    });
    console.error('[api] request failed:', error.toDisplayString(), data);
    throw error;
  }

  return data;
}

function isAdmin() {
  return state.authUser?.role === 'admin';
}

async function loadAuthUser() {
  const payload = await api('/api/auth/me');
  state.authUser = payload.user || null;
  if (state.authUser?.username) {
    state.staffName = state.authUser.username;
    localStorage.setItem('staffName', state.staffName);
  }
  return state.authUser;
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    console.warn('[auth] logout failed:', error);
  }
  window.location.href = '/login';
}

async function refreshLedgerUsers() {
  if (!isAdmin()) return;
  state.ledgerUsersLoading = true;
  try {
    const payload = await api('/api/auth/users');
    state.ledgerUsers = payload.users || [];
  } catch (error) {
    state.settingsError = error.message || 'Could not load staff users.';
  } finally {
    state.ledgerUsersLoading = false;
  }
}

playersController = createPlayersController({
  api,
  getState: () => state,
  setState: (patch) => {
    state = { ...state, ...patch };
  },
  render
});

paymentInfoController = createPaymentInfoController({
  api,
  getState: () => state,
  setState: (patch) => {
    state = { ...state, ...patch };
  },
  render,
  fmtDateTime
});

appbegPlayersController = createAppBegPlayersController({
  api,
  getState: () => state,
  setState: (patch) => {
    state = { ...state, ...patch };
  },
  render,
  fmtDateTime
});

async function openContactById(contactId, { pane = 'overview' } = {}) {
  const id = normalizeContactId(contactId);
  if (!id) return;
  const changed = state.selectedContactId !== id;
  const requestId = ++selectedContactRequestId;
  const cached = getCachedContactDetail(id);
  state.section = 'contacts';
  state.mobileContactsPane = pane === 'chat' ? 'chat' : pane === 'details' ? 'details' : 'overview';
  state.selectedContactId = id;
  state.draft = '';
  if (changed) {
    state.registrationWizard = null;
  }
  if (!changed && state.contact?.id === id) {
    render();
    return;
  }
  state.contacts = state.contacts.map((contact) => (
    contact.id === id ? { ...contact, unread_count: 0 } : contact
  ));
  if (cached) {
    applyContactDetail(cached);
  } else if (state.contact?.id !== id) {
    state.contact = null;
    state.messages = [];
    state.notes = [];
    state.timeline = [];
    state.automationState = null;
    state.automationLogs = [];
    state.contactLoading = true;
  } else {
    state.contactLoading = false;
  }
  render();

  if (!cached) {
    await refreshSelectedContact({ requestId, reason: 'contact selected' });
    if (requestId !== selectedContactRequestId || state.selectedContactId !== id) return;
    render();
  }

  if (changed) {
    void markSelectedContactReadOnce(id)
      .then(() => {
        if (requestId !== selectedContactRequestId || state.selectedContactId !== id) return;
        state.selectedContactId = id;
        render();
      });
  }
}

function openContactConversation(contactId) {
  return openContactById(contactId, { pane: 'chat' });
}

function startRegistrationWizard(contactId) {
  const id = Number(contactId || state.selectedContactId);
  if (!id) return;
  const contact = state.contact?.id === id ? state.contact : state.contacts.find((item) => item.id === id);
  state.registrationWizard = {
    active: true,
    contactId: id,
    step: 'welcome',
    form: createEmptyWizardForm(contact, state.automationState),
    error: null,
    saving: false
  };
  state.mobileContactsPane = 'overview';
  render();
}

function exitRegistrationWizard() {
  state.registrationWizard = null;
  state.mobileContactsPane = 'overview';
  render();
}

function syncWizardFieldFromDom() {
  const wizard = state.registrationWizard;
  if (!wizard?.active) return;
  const input = document.querySelector('#wizardFieldInput');
  if (!input) return;
  const field = input.dataset.wizardField;
  if (!field) return;
  state.registrationWizard = {
    ...wizard,
    form: { ...wizard.form, [field]: input.value }
  };
}

function wizardNextStep() {
  const wizard = state.registrationWizard;
  if (!wizard?.active || wizard.saving) return;
  syncWizardFieldFromDom();
  const stepIndex = registrationWizardIndex(wizard.step);
  const step = REGISTRATION_WIZARD_STEPS[stepIndex];
  const form = { ...state.registrationWizard.form };

  if (step?.field && step.required && !String(form[step.field] || '').trim()) {
    state.registrationWizard = { ...wizard, form, error: `${step.title} is required.` };
    render();
    return;
  }

  const next = REGISTRATION_WIZARD_STEPS[stepIndex + 1];
  if (!next) return;
  state.registrationWizard = {
    ...wizard,
    form,
    step: next.key,
    error: null
  };
  render();
}

function wizardBackStep() {
  const wizard = state.registrationWizard;
  if (!wizard?.active || wizard.saving) return;
  syncWizardFieldFromDom();
  const stepIndex = registrationWizardIndex(wizard.step);
  const prev = REGISTRATION_WIZARD_STEPS[stepIndex - 1];
  if (!prev) return;
  state.registrationWizard = {
    ...wizard,
    form: { ...state.registrationWizard.form },
    step: prev.key,
    error: null
  };
  render();
}

async function completeRegistrationWizard() {
  const wizard = state.registrationWizard;
  if (!wizard?.active || wizard.saving) return;

  syncWizardFieldFromDom();
  const form = { ...state.registrationWizard.form };
  const appbegUsername = String(form.appbegUsername || '').trim();
  const paymentTag = String(form.paymentTag || '').trim();
  const paymentApp = String(form.paymentApp || '').trim();

  if (!appbegUsername) {
    state.registrationWizard = { ...wizard, form, step: 'username', error: 'AppBeg username is required.' };
    render();
    return;
  }
  if (!paymentTag) {
    state.registrationWizard = { ...wizard, form, step: 'payment_tag', error: 'Payment tag is required.' };
    render();
    return;
  }

  state.registrationWizard = { ...wizard, form, error: null, saving: true };
  render();

  try {
    if (paymentApp) {
      await api(`/api/contacts/${wizard.contactId}/registration-info`, {
        method: 'PATCH',
        body: JSON.stringify({
          registrationInfo: { preferred_game: paymentApp },
          staffName: state.staffName
        })
      });
    }

    await api(`/api/contacts/${wizard.contactId}/registration/manual`, {
      method: 'POST',
      body: JSON.stringify({
        appbegUsername,
        paymentTag,
        registrationStatus: 'Registered',
        notes: paymentApp ? `Payment app: ${paymentApp}` : '',
        staffName: state.staffName,
        allowDuplicate: false
      })
    });

    const savedContactId = wizard.contactId;
    contactDetailCache.delete(Number(savedContactId));
    state.registrationWizard = null;
    await Promise.all([
      refreshContacts({ force: true, reason: 'registration wizard saved' }),
      refreshStats({ force: true, reason: 'registration wizard saved' })
    ]);
    if (state.selectedContactId === savedContactId) {
      await refreshSelectedContact({ force: true, reason: 'registration wizard saved' });
      state.mobileContactsPane = 'overview';
    }
    await refreshPlayers({ keepSelection: true, silent: true });
    render();
  } catch (error) {
    console.error('[registration-wizard] complete failed:', error);
    state.registrationWizard = {
      ...state.registrationWizard,
      error: error.message || 'Failed to complete registration.',
      saving: false
    };
    render();
  }
}

async function handleOverviewAction(action) {
  if (!action) return;
  if (action === 'open-chat') {
    state.registrationWizard = null;
    state.mobileContactsPane = 'chat';
    render();
    return;
  }
  if (action === 'view-profile') {
    const id = state.selectedContactId;
    if (!id) return;
    state.section = 'players';
    state.selectedPlayerId = id;
    state.mobilePlayersPane = 'detail';
    state.registrationWizard = null;
    await refreshPlayers({ keepSelection: true, silent: true });
    await playersController.refreshSelectedPlayer({ silent: true });
    render();
    return;
  }
  if (action === 'start-register') {
    startRegistrationWizard(state.selectedContactId);
    return;
  }
  if (action === 'exit-wizard') {
    exitRegistrationWizard();
    return;
  }
  if (action === 'wizard-next') {
    wizardNextStep();
    return;
  }
  if (action === 'wizard-back') {
    wizardBackStep();
    return;
  }
  if (action === 'wizard-complete') {
    await completeRegistrationWizard();
  }
}

async function markSelectedContactReadOnce(contactId) {
  const id = Number(contactId);
  if (!id || lastReadMarkedContactId === id) return;
  lastReadMarkedContactId = id;
  suppressContactsRefreshUntil = Date.now() + 1500;
  try {
    await api(`/api/contacts/${id}/read`, { method: 'POST' });
    state.contacts = state.contacts.map((contact) => (
      contact.id === id ? { ...contact, unread_count: 0 } : contact
    ));
    if (state.contact?.id === id) {
      state.contact = { ...state.contact, unread_count: 0 };
    }
  } catch (error) {
    console.warn('[contacts] mark-read failed; chat remains open:', error);
  }
}

async function openRegistrationModal(contactId) {
  const id = Number(contactId);
  if (!id) return;

  try {
    logRefresh('selected contact', 'registration modal');
    const data = await api(`/api/contacts/${id}`);
    const settings = state.coadminSettings || {};
    const info = data.automationState?.registration_info || {};
    const defaultStatus = ['Pending Verification', 'Registered'].includes(data.contact.registration_status)
      ? data.contact.registration_status
      : 'Pending Verification';

    state.registrationModal = {
      open: true,
      contactId: id,
      contact: data.contact,
      prefill: info,
      coadmin: {
        name: info.coadmin_name || settings.coadmin_name || '',
        code: info.coadmin_code || settings.coadmin_code || '',
        uid: info.appbeg_coadmin_uid || settings.appbeg_coadmin_uid || ''
      },
      form: {
        appbegUsername: info.preferred_appbeg_username || data.contact.appbeg_account_id || '',
        paymentTag: info.payment_tag || '',
        registrationStatus: defaultStatus,
        notes: '',
        allowDuplicate: false
      },
      error: null,
      duplicateError: null,
      saving: false
    };
    render();
  } catch (error) {
    console.error('[registration-modal] open failed:', error);
    const settings = state.coadminSettings || {};
    state.registrationModal = {
      open: true,
      contactId: id,
      contact: { display_name: 'Contact', telegram_id: id },
      prefill: {},
      coadmin: {
        name: settings.coadmin_name || '',
        code: settings.coadmin_code || '',
        uid: settings.appbeg_coadmin_uid || ''
      },
      form: { appbegUsername: '', paymentTag: '', registrationStatus: 'Pending Verification', notes: '', allowDuplicate: false },
      error: error.message || 'Failed to load contact.',
      duplicateError: null,
      saving: false
    };
    render();
  }
}

function closeRegistrationModal() {
  state.registrationModal = null;
  render();
}

const REGISTRATION_MODAL_ACTIONS = new Set(['register', 'edit', 'continue', 'review', 'open']);

async function handlePlayerQuickAction(action, playerId) {
  const id = Number(playerId);
  if (!id || !action) return;

  if (action === 'open-chat') {
    await openContactById(id, { pane: 'chat' });
    return;
  }

  if (REGISTRATION_MODAL_ACTIONS.has(action)) {
    await openContactById(id, { pane: 'overview' });
    if (!isRegistrationComplete(state.contact) || action === 'edit' || action === 'continue' || action === 'review') {
      startRegistrationWizard(id);
    }
    return;
  }

  if (action === 'copy') return;

  await api(`/api/players/${id}/actions/${action}`, {
    method: 'POST',
    body: JSON.stringify({ staffName: state.staffName })
  });
  await refreshPlayers({ keepSelection: true, silent: true });
  if (state.section === 'players' && state.selectedPlayerId === id) {
    await playersController.refreshSelectedPlayer({ silent: true });
  }
  render();
}

async function saveRegistrationModal() {
  const modal = state.registrationModal;
  if (!modal?.open || modal.saving) return;

  const form = readRegistrationModalForm();
  state.registrationModal = {
    ...modal,
    form,
    error: null,
    saving: false
  };

  if (!form.appbegUsername) {
    state.registrationModal.error = 'AppBeg username is required.';
    render();
    return;
  }
  if (!form.paymentTag) {
    state.registrationModal.error = 'Payment app name/tag is required.';
    render();
    return;
  }

  state.registrationModal.saving = true;
  render();

  try {
    const duplicateCheck = await api(`/api/contacts/${modal.contactId}/registration/check-duplicates`, {
      method: 'POST',
      body: JSON.stringify({
        appbegUsername: form.appbegUsername,
        paymentTag: form.paymentTag
      })
    });

    if (!duplicateCheck.ok && !form.allowDuplicate) {
      state.registrationModal = {
        ...state.registrationModal,
        duplicateError: duplicateCheck.error,
        error: null,
        saving: false
      };
      render();
      return;
    }

    await api(`/api/contacts/${modal.contactId}/registration/manual`, {
      method: 'POST',
      body: JSON.stringify({
        appbegUsername: form.appbegUsername,
        paymentTag: form.paymentTag,
        registrationStatus: form.registrationStatus,
        notes: form.notes,
        staffName: state.staffName,
        allowDuplicate: !duplicateCheck.ok
      })
    });

    const savedContactId = modal.contactId;
    contactDetailCache.delete(Number(savedContactId));
    closeRegistrationModal();
    await Promise.all([
      refreshContacts({ force: true, reason: 'registration saved' }),
      refreshStats({ force: true, reason: 'registration saved' })
    ]);
    if (state.selectedContactId === savedContactId) {
      await refreshSelectedContact({ force: true, reason: 'registration saved' });
      state.mobileContactsPane = 'overview';
      state.registrationWizard = null;
    }
    await refreshPlayers({ keepSelection: true, silent: true });
    if (state.section === 'players' && state.selectedPlayerId === savedContactId) {
      await playersController.refreshSelectedPlayer({ silent: true });
    }
    render();
  } catch (error) {
    console.error('[registration-modal] save failed:', error);
    state.registrationModal = {
      ...state.registrationModal,
      error: error.message || 'Failed to save registration.',
      saving: false
    };
    render();
  }
}

async function refreshPlayers(options) {
  return playersController.refreshPlayers(options);
}

async function refreshCoadminSettings() {
  const payload = await api('/api/coadmin-settings');
  state.coadminSettings = payload.settings || {};
  state.settingsAuditLog = payload.audit_log || payload.auditLog || [];
}

function readCoadminFormValues() {
  return {
    coadmin_name: document.querySelector('#coadminName')?.value?.trim() ?? state.coadminSettings.coadmin_name ?? '',
    coadmin_code: document.querySelector('#coadminCode')?.value?.trim() ?? state.coadminSettings.coadmin_code ?? '',
    appbeg_coadmin_uid: document.querySelector('#appbegCoadminUid')?.value?.trim() ?? state.coadminSettings.appbeg_coadmin_uid ?? '',
    telegram_account_username: document.querySelector('#telegramAccountUsername')?.value?.trim() ?? state.coadminSettings.telegram_account_username ?? '',
    telegram_account_id: document.querySelector('#telegramAccountId')?.value?.trim() ?? state.coadminSettings.telegram_account_id ?? ''
  };
}

async function refreshContacts({ keepSelection = true, force = false, reason = 'manual' } = {}) {
  if (contactsRefreshPromise) return contactsRefreshPromise;
  if (!force && Date.now() - lastContactsRefreshAt < REFRESH_DEDUPE_MS) return null;

  contactsRefreshPromise = (async () => {
    logRefresh('contacts', reason);
    const { contacts } = await api('/api/contacts');
    state.contacts = contacts.map(normalizeContact);
    lastContactsRefreshAt = Date.now();

    if (!keepSelection || !state.selectedContactId || !state.contacts.some((contact) => contact.id === Number(state.selectedContactId))) {
      state.selectedContactId = filteredContacts()[0]?.id || contacts[0]?.id || null;
      state.selectedContactId = state.selectedContactId == null ? null : Number(state.selectedContactId);
    }
  })();

  try {
    return await contactsRefreshPromise;
  } finally {
    contactsRefreshPromise = null;
  }
}

async function refreshStats({ force = false, reason = 'manual' } = {}) {
  if (statsRefreshPromise) return statsRefreshPromise;
  if (!force && Date.now() - lastStatsRefreshAt < REFRESH_DEDUPE_MS) return null;

  statsRefreshPromise = (async () => {
    logRefresh('stats', reason);
    const { stats } = await api('/api/stats');
    state.stats = stats;
    lastStatsRefreshAt = Date.now();
  })();

  try {
    return await statsRefreshPromise;
  } finally {
    statsRefreshPromise = null;
  }
}

async function refreshSyncStatus({ force = false, reason = 'manual' } = {}) {
  if (syncStatusRefreshPromise) return syncStatusRefreshPromise;
  if (!force && Date.now() - lastSyncStatusRefreshAt < REFRESH_DEDUPE_MS) return null;

  syncStatusRefreshPromise = (async () => {
    logRefresh('sync status', reason);
    const syncPayload = await api('/api/telegram-account-sync/status');
    state.sync = syncPayload.sync || syncPayload;
    state.syncLogs = syncPayload.logs || [];
    lastSyncStatusRefreshAt = Date.now();
  })();

  try {
    return await syncStatusRefreshPromise;
  } finally {
    syncStatusRefreshPromise = null;
  }
}

async function refreshSelectedContact({ markRead = false, requestId = null, force = false, reason = 'manual' } = {}) {
  if (!state.selectedContactId) {
    state.contact = null;
    state.contactLoading = false;
    state.messages = [];
    state.notes = [];
    state.timeline = [];
    state.automationState = null;
    state.automationLogs = [];
    state.allTags = [];
    state.quickReplies = [];
    return;
  }

  if (markRead) await markSelectedContactReadOnce(state.selectedContactId);
  const selectedId = Number(state.selectedContactId);
  if (selectedContactRefreshPromise && selectedContactRefreshId === selectedId) return selectedContactRefreshPromise;
  const cached = force ? null : getCachedContactDetail(selectedId);
  if (cached) {
    applyContactDetail(cached);
    return;
  }

  state.contactLoading = true;
  selectedContactRefreshId = selectedId;
  selectedContactRefreshPromise = (async () => {
    logRefresh('selected contact', reason);
    const data = await api(`/api/contacts/${selectedId}`);
    if (requestId !== null && (requestId !== selectedContactRequestId || Number(state.selectedContactId) !== selectedId)) {
      return;
    }
    cacheContactDetail(selectedId, data);
    applyContactDetail(data);
  })();

  try {
    return await selectedContactRefreshPromise;
  } catch (error) {
    if (requestId === null || (requestId === selectedContactRequestId && Number(state.selectedContactId) === selectedId)) {
      state.contactLoading = false;
    }
    throw error;
  } finally {
    selectedContactRefreshPromise = null;
    selectedContactRefreshId = null;
  }
}

async function refreshPayments({ keepSelection = true } = {}) {
  const query = new URLSearchParams({
    status: state.paymentStatusFilter,
    routingStatus: state.paymentRoutingFilter,
    exceptionsOnly: state.paymentExceptionsOnly ? 'true' : 'false',
    query: state.paymentQuery,
    limit: '300'
  });
  const [{ payments }, { stats }, { sync }] = await Promise.all([
    api(`/api/payments?${query}`),
    api('/api/payment-stats'),
    api('/api/payment-sync/status')
  ]);
  state.payments = payments;
  state.paymentStats = stats;
  state.paymentSync = sync;
  if (!keepSelection || !state.selectedPaymentId || !payments.some((payment) => payment.id === state.selectedPaymentId)) {
    state.selectedPaymentId = payments[0]?.id || null;
  }
}

async function refreshSelectedPayment() {
  if (!state.selectedPaymentId) {
    state.payment = null;
    state.paymentLogs = [];
    return;
  }
  const data = await api(`/api/payments/${state.selectedPaymentId}`);
  state.payment = data.payment;
  state.paymentSync = data.sync;
  state.paymentLogs = data.logs || [];
  state.paymentRoutingLogs = data.routingLogs || [];
}

function assignees() {
  const names = new Set(state.contacts.map((contact) => contact.assigned_staff_name).filter(Boolean));
  return ['All', 'Unassigned', ...Array.from(names).sort((a, b) => a.localeCompare(b))];
}

function filteredContacts() {
  const query = state.query.trim().toLowerCase();
  return state.contacts
    .filter((contact) => state.registrationFilter === 'All' || contact.registration_status === state.registrationFilter)
    .filter((contact) => state.conversationFilter === 'All' || contact.conversation_status === state.conversationFilter)
    .filter((contact) => {
      if (state.assigneeFilter === 'All') return true;
      if (state.assigneeFilter === 'Unassigned') return !contact.assigned_staff_name;
      return contact.assigned_staff_name === state.assigneeFilter;
    })
    .filter((contact) => {
      if (!query) return true;
      const tagText = (contact.tags || []).map((tag) => tag.name).join(' ');
      return [
        contact.display_name,
        contact.username,
        contact.telegram_id,
        contact.registration_status,
        contact.conversation_status,
        contact.assigned_staff_name,
        contact.last_message,
        contact.notes_text,
        tagText
      ].join(' ').toLowerCase().includes(query);
    })
    .sort((a, b) => {
      const unreadDelta = Number(b.unread_count || 0) - Number(a.unread_count || 0);
      if (unreadDelta) return unreadDelta;
      return String(b.last_message_at || b.last_seen || '').localeCompare(String(a.last_message_at || a.last_seen || ''));
    });
}

function statCards() {
  const unreadTotal = state.contacts.reduce((sum, contact) => sum + Number(contact.unread_count || 0), 0);
  const openCount = state.contacts.filter((contact) => contact.conversation_status === 'Open').length;
  const waitingCount = state.contacts.filter((contact) => contact.conversation_status === 'Waiting').length;
  const cards = [
    ['Contacts', state.stats.totalTelegramUsers || 0],
    ['Unread', unreadTotal],
    ['Open', openCount],
    ['Waiting', waitingCount],
    ['Registered', state.stats.registeredUsers || 0],
    ['Active Today', state.stats.activeToday || 0]
  ];
  return cards.map(([label, value]) => `
    <article class="stat-card">
      <div class="stat-number">${value}</div>
      <div class="stat-name">${label}</div>
    </article>
  `).join('');
}

function syncStatus() {
  const sync = state.sync || {};
  const accountLabel = sync.account_username ? `@${sync.account_username}` : 'account';
  const latestLog = (state.syncLogs || [])[0];
  return `
    <div class="sync-status-wrap">
      <div class="sync-status ${escapeHtml(sync.status || 'disabled')}">
        <span class="sync-dot"></span>
        <span>${escapeHtml(sync.status || 'disabled')}</span>
        <span class="subtle">${escapeHtml(accountLabel)} · ${Number(sync.imported_contacts || 0)} contacts / ${Number(sync.imported_messages || 0)} messages</span>
      </div>
      ${latestLog ? `<div class="sync-log-preview subtle">${escapeHtml(latestLog.message)}</div>` : ''}
    </div>
  `;
}

function filterButtons(items, active, attr) {
  return items.map((item) => `
    <button class="filter-chip ${active === item ? 'active' : ''}" data-${attr}="${item}">${item}</button>
  `).join('');
}

function contactRows() {
  const contacts = filteredContacts();
  if (!contacts.length) return '<div class="empty-state">No contacts match the current filters.</div>';

  return contacts.map((contact) => {
    const previewPrefix = contact.last_message_direction === 'outgoing'
      ? (contact.last_message_sender_type === 'bot' ? 'Bot: ' : 'You: ')
      : '';
    return `
      <button class="contact-row ${state.selectedContactId === contact.id ? 'selected' : ''}" data-contact-id="${contact.id}">
        <div class="avatar-wrap">
          ${avatar(contact, 'md')}
          <span class="presence ${isActiveToday(contact.last_seen) ? 'online' : ''}"></span>
        </div>
        <div class="contact-main">
          <div class="contact-top">
            <span class="contact-name truncate">${escapeHtml(contact.display_name)}</span>
            <span class="contact-time">${fmtTime(contact.last_message_at || contact.last_seen)}</span>
          </div>
          <div class="contact-preview truncate">${escapeHtml(previewPrefix + (contact.last_message || 'No messages yet'))}</div>
          <div class="contact-meta">
            <span class="badge-wrap">${statusBadge(contact.registration_status)}</span>
            <span class="bot-status-chip ${contact.needs_staff_review ? 'review' : contact.bot_paused ? 'paused' : 'active'}">${chatbotStatusLabel(contact)}</span>
            <span>${escapeHtml(contact.assigned_staff_name || 'Unassigned')}</span>
          </div>
        </div>
        ${Number(contact.unread_count || 0) > 0 ? `<span class="unread">${contact.unread_count}</span>` : ''}
      </button>
    `;
  }).join('');
}

function isActiveToday(value) {
  if (!value) return false;
  return dayKey(value) === new Date().toISOString().slice(0, 10);
}

function conversationHeader() {
  if (state.contactLoading && !state.contact) {
    const selected = state.contacts.find((contact) => contact.id === Number(state.selectedContactId));
    return `
      <header class="chat-header">
        <div class="chat-person">
          <button type="button" class="icon-back mobile-only" data-mobile-panel="overview" aria-label="Back to overview">←</button>
          ${selected ? avatar(selected, 'md') : ''}
          <div>
            <h2>${escapeHtml(selected?.display_name || 'Loading contact')}</h2>
            <div class="subtle">Loading conversation...</div>
          </div>
        </div>
      </header>
    `;
  }
  const contact = state.contact;
  if (!contact) return '<section class="chat-empty-panel">Select a contact to start operations.</section>';
  return `
    <header class="chat-header">
      <div class="chat-person">
        <button type="button" class="icon-back mobile-only" data-mobile-panel="overview" aria-label="Back to overview">←</button>
        <button type="button" class="button secondary desktop-only overview-back-btn" data-mobile-panel="overview">Overview</button>
        ${avatar(contact, 'md')}
        <div class="chat-person-text">
          <h2>${escapeHtml(contact.display_name)}</h2>
          <div class="subtle">${contact.username ? '@' + escapeHtml(contact.username) : 'No username'} - ${escapeHtml(contact.conversation_status || 'Open')}</div>
        </div>
      </div>
      <div class="chat-tools">
        <select id="conversationStatus">
          ${['Open', 'Waiting', 'Closed'].map((status) => `<option value="${status}" ${contact.conversation_status === status ? 'selected' : ''}>${status}</option>`).join('')}
        </select>
        <input id="assignmentInput" value="${escapeHtml(contact.assigned_staff_name || '')}" placeholder="Assign staff" />
        <button class="button secondary" id="assignConversation">Assign</button>
        <button type="button" class="button secondary mobile-only" data-mobile-panel="details">Profile</button>
      </div>
    </header>
  `;
}

function messageList() {
  if (state.contactLoading && !state.contact) {
    return '<div class="chat-empty">Loading conversation...</div>';
  }
  if (!state.contact) return '';
  if (!state.messages.length) return '<div class="chat-empty">No messages stored yet.</div>';

  let previousDay = '';
  return state.messages.map((message, index) => {
    const currentDay = dayKey(message.sent_at);
    const previous = state.messages[index - 1];
    const grouped = previous &&
      previous.direction === message.direction &&
      dayKey(previous.sent_at) === currentDay &&
      new Date(message.sent_at) - new Date(previous.sent_at) < 5 * 60 * 1000;
    const separator = currentDay !== previousDay ? `<div class="date-separator">${fmtDate(message.sent_at)}</div>` : '';
    previousDay = currentDay;
    return `
      ${separator}
      <div class="message-row ${message.direction} ${grouped ? 'grouped' : ''}">
        <div class="bubble">
          <div class="bubble-text">${escapeHtml(message.text || `[${message.message_type}]`)}</div>
          <div class="bubble-time">${fmtTime(message.sent_at)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function quickReplyBar() {
  if (!state.contact) return '';
  return `
    <div class="quick-replies">
      ${state.quickReplies.map((reply) => `
        <button class="quick-reply" data-reply-id="${reply.id}">${escapeHtml(reply.label)}</button>
      `).join('')}
    </div>
  `;
}

function composer() {
  if (!state.contact) return '';
  const disabled = sendingMessage ? 'disabled' : '';
  return `
    <form class="composer" id="sendForm">
      ${quickReplyBar()}
      <div class="composer-row">
        <textarea id="messageText" placeholder="Write a Telegram message" ${disabled}>${escapeHtml(state.draft)}</textarea>
        <button class="button send-button" type="submit" ${disabled}>${sendingMessage ? 'Sending…' : 'Send'}</button>
      </div>
    </form>
  `;
}

function tags(contact) {
  if (!contact?.tags?.length) return '<span class="subtle">No tags</span>';
  return contact.tags.map((tag) => `<span class="tag" style="--tag-color:${escapeHtml(tag.color)}">${escapeHtml(tag.name)}</span>`).join('');
}

function detailsPanel() {
  const contact = state.contact;
  if (state.contactLoading && !contact) {
    return '<aside class="details-panel"><section class="card"><div class="card-title">Profile</div><div class="subtle">Loading contact profile...</div></section></aside>';
  }
  if (!contact) return '<aside class="details-panel"></aside>';
  return `
    <aside class="details-panel">
      <section class="card profile-card">
        <div class="profile-head">
          ${avatar(contact, 'lg')}
          <div>
            <h2>${escapeHtml(contact.display_name)}</h2>
            <div class="subtle">${contact.username ? '@' + escapeHtml(contact.username) : 'No username'}</div>
          </div>
        </div>
        <div class="tag-row">${tags(contact)}</div>
      </section>

      <section class="card">
        <div class="card-title">Contact</div>
        ${infoRow('Telegram ID', contact.telegram_id)}
        ${infoRow('Sync Source', contact.telegram_sync_source || 'bot_api')}
        ${infoRow('Registration', statusBadge(contact.registration_status))}
        ${infoRow('Progress', progressBar(state.automationState?.registration_info ? computeLocalProgress(contact, state.automationState.registration_info) : contact.registration_progress || { percent: 0, steps: [] }, { compact: true }))}
        ${infoRow('Language', contact.language_code || '-')}
        ${infoRow('First Seen', fmtDateTime(contact.first_seen))}
        ${infoRow('Last Seen', fmtDateTime(contact.last_seen))}
      </section>

      <section class="card">
        <div class="card-title">Coadmin</div>
        ${coadminInfoRows(state.automationState?.registration_info || {})}
      </section>

      <section class="card">
        <div class="card-title">Registration</div>
        ${registrationPanel()}
      </section>

      <section class="card">
        <div class="card-title">Assignment</div>
        ${infoRow('Assigned Staff', contact.assigned_staff_name || 'Unassigned')}
        ${infoRow('Assigned At', fmtDateTime(contact.assigned_at))}
        ${infoRow('Last Read', fmtDateTime(contact.last_read_at))}
      </section>

      <section class="card">
        <div class="card-title">AI Chatbot</div>
        ${infoRow('Status', chatbotStatusLabel(contact))}
        ${infoRow('Paused', contact.bot_paused ? 'Yes' : 'No')}
        ${infoRow('Needs staff review', contact.needs_staff_review ? 'Yes' : 'No')}
        ${contact.staff_review_reason ? infoRow('Review reason', contact.staff_review_reason) : ''}
        <div class="control-grid">
          <button class="button secondary" data-bot-control="pause" ${contact.bot_paused ? 'disabled' : ''}>Pause Bot</button>
          <button class="button secondary" data-bot-control="resume" ${!contact.bot_paused && !contact.needs_staff_review ? 'disabled' : ''}>Resume Bot</button>
          <button class="button" data-bot-control="takeover">Take Over Manually</button>
        </div>
      </section>

      <section class="card">
        <div class="card-title">Bot State</div>
        ${infoRow('Current Screen', contact.bot_current_screen || 'Home')}
        ${infoRow('Workflow', contact.bot_workflow_key || 'None')}
        ${infoRow('Step', contact.bot_workflow_step || 'None')}
        <div class="control-grid">
          <button class="button secondary" data-bot-action="restart">Restart</button>
          <button class="button secondary" data-bot-action="home">Home</button>
          <button class="button secondary" data-bot-action="cancel">Cancel</button>
        </div>
      </section>

      <section class="card">
        <div class="card-title">Automation</div>
        ${automationPanel()}
      </section>

      <section class="card">
        <div class="card-title">Internal Notes</div>
        <div class="note-form">
          <input id="staffName" value="${escapeHtml(state.staffName)}" placeholder="Staff name" />
          <textarea id="noteText" placeholder="Add an internal note"></textarea>
          <button class="button full" id="addNote">Add Note</button>
        </div>
        <div class="note-list">${noteItems()}</div>
      </section>

      <section class="card">
        <div class="card-title">Activity Timeline</div>
        <div class="timeline">${timelineItems()}</div>
      </section>

      <section class="card">
        <div class="card-title">Automation Logs</div>
        <div class="timeline">${automationLogItems()}</div>
      </section>
    </aside>
  `;
}

function computeLocalProgress(contact, info) {
  const steps = [
    { key: 'telegram', label: 'Telegram Connected', done: Boolean(contact.telegram_id) },
    { key: 'appbeg', label: 'AppBeg Username', done: Boolean(info.preferred_appbeg_username) },
    { key: 'payment', label: 'Payment Tag', done: Boolean(info.payment_tag) },
    { key: 'submitted', label: 'Submitted for Review', done: ['Pending Verification', 'Registered'].includes(contact.registration_status) }
  ];
  const completed = steps.filter((step) => step.done).length;
  return { steps, percent: Math.round((completed / steps.length) * 100) };
}

function coadminInfoRows(info = {}) {
  const settings = state.coadminSettings || {};
  const name = info.coadmin_name || settings.coadmin_name || '—';
  const code = info.coadmin_code || settings.coadmin_code || '—';
  const uid = info.appbeg_coadmin_uid || settings.appbeg_coadmin_uid || '—';
  const assigned = Boolean(info.coadmin_name || info.coadmin_code || info.appbeg_coadmin_uid);
  return `
    ${infoRow('Assigned Coadmin', name)}
    ${infoRow('Coadmin Code', code)}
    ${infoRow('AppBeg Coadmin UID', uid)}
    ${infoRow('Ownership', assigned ? 'Assigned' : 'Pending assignment from settings')}
  `;
}

function registrationPanel() {
  const contact = state.contact;
  const info = state.automationState?.registration_info || {};
  const method = contact.registration_method || info.registration_method || 'Not set';
  return `
    ${infoRow('Registered', contact.registration_status === 'Registered' ? 'Yes' : 'No')}
    ${infoRow('AppBeg Username', info.preferred_appbeg_username || contact.appbeg_account_id || '-')}
    ${infoRow('Payment Name/Tag', info.payment_tag || '-')}
    ${infoRow('Registration Method', method)}
    ${infoRow('Registered At', fmtDateTime(contact.registered_at))}
    ${infoRow('Reviewed By', state.automationState?.info_reviewed_by || '-')}
    ${progressChecklist(computeLocalProgress(contact, info))}
    <div class="registration-actions">
      <button type="button" class="button secondary" data-overview-action="start-register">Register</button>
      <button type="button" class="button secondary" id="openRegistrationModalBtn">Quick form</button>
    </div>
  `;
}

function automationPanel() {
  const automation = state.automationState || {};
  const info = automation.registration_info || {};
  const intents = automation.intents || {};
  return `
    ${infoRow('Current Flow', automation.current_flow || 'None')}
    ${infoRow('Current Step', automation.current_step || 'None')}
    ${infoRow('Last Keyword', automation.last_matched_keyword || 'None')}
    ${infoRow('Last Response', automation.last_automation_response || 'None')}
    <div class="intent-row">
      ${intentPill('deposit_interest', intents.deposit_interest)}
      ${intentPill('cashout_interest', intents.cashout_interest)}
      ${intentPill('support_needed', intents.support_needed)}
    </div>
    <div class="registration-info-form">
      <input id="regUsername" value="${escapeHtml(info.preferred_appbeg_username || '')}" placeholder="Preferred AppBeg username" />
      <input id="regPaymentTag" value="${escapeHtml(info.payment_tag || '')}" placeholder="Payment tag" />
      <input id="regGame" value="${escapeHtml(info.preferred_game || '')}" placeholder="Preferred game / platform" />
      <textarea id="regNote" placeholder="Optional note">${escapeHtml(info.note || '')}</textarea>
    </div>
    <div class="control-grid">
      <button class="button secondary" data-automation-action="start">Start Flow</button>
      <button class="button secondary" data-automation-action="cancel">Cancel</button>
      <button class="button secondary" data-automation-action="reset">Reset</button>
    </div>
    <div class="control-grid two">
      <button class="button secondary" data-automation-action="save-info">Save Info</button>
      <button class="button secondary" data-automation-action="reviewed">Mark Reviewed</button>
    </div>
  `;
}

function intentPill(label, active) {
  return `<span class="intent-pill ${active ? 'active' : ''}">${label.replaceAll('_', ' ')}</span>`;
}

function infoRow(label, value) {
  const isHtml = typeof value === 'string' && (value.includes('status-badge') || value.includes('progress-'));
  return `<div class="info-row"><span>${label}</span><strong>${isHtml ? value : escapeHtml(value)}</strong></div>`;
}

function chatbotStatusLabel(contact) {
  if (!contact) return '—';
  if (contact.needs_staff_review) return 'Needs staff review';
  if (contact.bot_paused) return 'Paused';
  if (contact.bot_enabled === false) return 'Disabled';
  return 'Active';
}

function noteItems() {
  if (!state.notes.length) return '<div class="subtle">No notes yet.</div>';
  return state.notes.map((note) => `
    <article class="note-item">
      <div class="note-meta">${escapeHtml(note.staff_name)} - ${fmtDateTime(note.created_at)}</div>
      <div>${escapeHtml(note.note_text)}</div>
    </article>
  `).join('');
}

function timelineItems() {
  if (!state.timeline.length) return '<div class="subtle">No activity yet.</div>';
  return state.timeline.map((event) => `
    <article class="timeline-item">
      <div class="timeline-dot"></div>
      <div>
        <div class="strong">${escapeHtml(event.title)}</div>
        <div class="subtle">${escapeHtml(event.actor_name || 'System')} - ${fmtDateTime(event.created_at)}</div>
        ${event.body ? `<div class="timeline-body">${escapeHtml(event.body)}</div>` : ''}
      </div>
    </article>
  `).join('');
}

function automationLogItems() {
  if (!state.automationLogs.length) return '<div class="subtle">No automation logs yet.</div>';
  return state.automationLogs.slice(0, 12).map((log) => `
    <article class="timeline-item">
      <div class="timeline-dot"></div>
      <div>
        <div class="strong">${escapeHtml(log.action_taken)}</div>
        <div class="subtle">${escapeHtml(log.rule_name || 'No rule')} - ${fmtDateTime(log.created_at)}</div>
        ${log.response_sent ? `<div class="timeline-body">${escapeHtml(log.response_sent)}</div>` : ''}
      </div>
    </article>
  `).join('');
}

function paymentStatCards() {
  const cards = [
    ['Messages Today', state.paymentStats.messagesToday || 0],
    ['AppBeg Owned', state.paymentStats.appbegOwned || 0],
    ['TeleLedger Queue', state.paymentStats.teleledgerPending || 0],
    ['Exceptions', state.paymentStats.exceptions || 0],
    ['Unrouted', state.paymentStats.waiting || 0],
    ['Total', state.paymentStats.totalMessages || 0]
  ];
  return cards.map(([label, value]) => `
    <article class="stat-card">
      <div class="stat-number">${value}</div>
      <div class="stat-name">${label}</div>
    </article>
  `).join('');
}

function paymentSyncStatus() {
  const sync = state.paymentSync || {};
  return `
    <div class="sync-status ${escapeHtml(sync.status || 'disabled')}">
      <span class="sync-dot"></span>
      <span>${escapeHtml(sync.status || 'disabled')}</span>
      <span class="subtle">checkpoint ${Number(sync.last_synced_message_id || 0)}</span>
    </div>
  `;
}

function paymentRows() {
  if (!state.payments.length) return '<div class="empty-state">No payment messages match the current filters.</div>';
  return state.payments.map((payment) => `
    <button class="payment-row ${state.selectedPaymentId === payment.id ? 'selected' : ''}" data-payment-id="${payment.id}">
      <span>${fmtDateTime(payment.message_date)}</span>
      <span class="truncate">${escapeHtml(payment.sender_name || payment.sender_username || 'Unknown')}</span>
      <span class="truncate">${escapeHtml(payment.message_text || '[non-text message]')}</span>
      <span>${payment.telegram_message_id}</span>
      <span class="badge ${escapeHtml(payment.routing_status || 'unrouted')}">${escapeHtml(payment.routing_status || 'unrouted')}</span>
      <span class="badge ${escapeHtml(payment.processing_status)}">${escapeHtml(payment.processing_status)}</span>
    </button>
  `).join('');
}

function paymentDetailPanel() {
  const payment = state.payment;
  if (!payment) return '<aside class="payment-detail"><section class="chat-empty-panel">Select a payment message to inspect it.</section></aside>';
  return `
    <aside class="payment-detail">
      <section class="card">
        <div class="card-title">Payment Message</div>
        ${infoRow('Processing', payment.processing_status)}
        ${infoRow('Routing', payment.routing_status || 'unrouted')}
        ${infoRow('Owner', payment.routing_owner || '-')}
        ${infoRow('Handled By', payment.handled_by || '-')}
        ${infoRow('Matched Contact', payment.contact_id || '-')}
        ${infoRow('Deposit Event', payment.deposit_event_id || '-')}
        ${infoRow('TeleLedger Payment', payment.teleledger_payment_id || '-')}
        ${infoRow('Sender', payment.sender_name || payment.sender_username || 'Unknown')}
        ${infoRow('Timestamp', fmtDateTime(payment.message_date))}
        ${infoRow('Group', payment.telegram_group_title || payment.telegram_group_id)}
        ${infoRow('Telegram Message ID', payment.telegram_message_id)}
        ${infoRow('Edited', payment.is_edited ? 'Yes' : 'No')}
      </section>

      <section class="card">
        <div class="card-title">Full Message</div>
        <pre class="payload-box message-box">${escapeHtml(payment.message_text || '[non-text message]')}</pre>
      </section>

      <section class="card">
        <div class="card-title">Parsed Payment</div>
        ${infoRow('Amount', payment.parsed_amount != null ? `$${payment.parsed_amount}` : 'Not parsed')}
        ${infoRow('Payment Tag', payment.parsed_recipient_tag || 'Not parsed')}
        ${infoRow('Sender Name', payment.parsed_sender_name || '-')}
        ${infoRow('Payment Time', payment.parsed_payment_datetime ? fmtDateTime(payment.parsed_payment_datetime) : '-')}
        ${infoRow('Parse Error', payment.parse_error || '-')}
      </section>

      <section class="card">
        <div class="card-title">Routing Audit</div>
        ${(state.paymentRoutingLogs || []).length
    ? state.paymentRoutingLogs.map((log) => `
          <article class="timeline-item">
            <div class="timeline-dot"></div>
            <div>
              <div class="strong">${escapeHtml(log.step)}</div>
              <div class="subtle">${fmtDateTime(log.created_at)}</div>
              <div class="timeline-body">${escapeHtml(log.message)}</div>
            </div>
          </article>
        `).join('')
    : '<div class="empty-state">No routing audit entries yet.</div>'}
      </section>

      <section class="card">
        <div class="card-title">Balance Loading</div>
        ${infoRow('AppBeg Username', 'Not loaded yet')}
        ${infoRow('Balance Update', 'Not implemented')}
      </section>

      <section class="card">
        <div class="card-title">Raw Telegram Payload</div>
        <pre class="payload-box">${escapeHtml(JSON.stringify(payment.raw_payload || {}, null, 2))}</pre>
      </section>

      <section class="card">
        <div class="card-title">Listener Logs</div>
        <div class="timeline">${paymentLogItems()}</div>
      </section>
    </aside>
  `;
}

function paymentLogItems() {
  if (!state.paymentLogs.length) return '<div class="subtle">No listener logs yet.</div>';
  return state.paymentLogs.slice(0, 12).map((log) => `
    <article class="timeline-item">
      <div class="timeline-dot"></div>
      <div>
        <div class="strong">${escapeHtml(log.event_type)}</div>
        <div class="subtle">${escapeHtml(log.level)} - ${fmtDateTime(log.created_at)}</div>
        <div class="timeline-body">${escapeHtml(log.message)}</div>
      </div>
    </article>
  `).join('');
}

function contactsWorkspace() {
  const pane = state.mobileContactsPane || 'list';
  const overviewHtml = renderContactOverview({
    contact: state.contact,
    automationState: state.automationState,
    wizard: state.registrationWizard,
    coadminSettings: state.coadminSettings,
    loading: state.contactLoading
  });
  const wizardActive = Boolean(state.registrationWizard?.active);
  return `
    <main class="ops-main contacts-workspace mobile-pane-${escapeHtml(pane)}${wizardActive ? ' wizard-active' : ''}">
      <header class="topbar desktop-topbar">
        <div>
          <div class="eyebrow">Telegram Operations</div>
          <h1>Contacts</h1>
          ${syncStatus()}
        </div>
        <div class="topbar-actions">
          <button class="button secondary" type="button" id="manualRefresh">Refresh</button>
          <div class="stats">${statCards()}</div>
        </div>
      </header>

      <section class="operations">
        <aside class="contacts-panel">
          <div class="mobile-section-header mobile-only">
            <div>
              <div class="eyebrow">Telegram</div>
              <h1>Contacts</h1>
            </div>
            <button class="button secondary" type="button" id="manualRefreshMobile">Refresh</button>
          </div>
          <div class="stats mobile-stats mobile-only">${statCards()}</div>
          <div class="contacts-toolbar">
            <input id="searchInput" class="search" value="${escapeHtml(state.query)}" placeholder="Search contacts, notes, tags" />
            <div class="filter-row">${filterButtons(registrationFilters, state.registrationFilter, 'registration')}</div>
            <div class="filter-row compact">${filterButtons(conversationFilters, state.conversationFilter, 'conversation')}</div>
            <select id="assigneeFilter">
              ${assignees().map((name) => `<option value="${escapeHtml(name)}" ${state.assigneeFilter === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
            </select>
          </div>
          <div class="contacts-list">${contactRows()}</div>
        </aside>

        <div class="workspace-main">
          <section class="overview-panel ${pane !== 'chat' ? 'is-primary' : ''}">
            ${overviewHtml}
          </section>
          <section class="chat-panel ${pane === 'chat' ? 'is-primary' : ''}">
            ${conversationHeader()}
            <div id="chatLog" class="chat-log">${messageList()}</div>
            ${composer()}
          </section>
        </div>

        <div class="details-panel-wrap ${pane === 'details' ? 'is-open' : ''}">
          <div class="details-sheet-bar mobile-only">
            <strong>Contact profile</strong>
            <button type="button" class="button secondary" data-mobile-panel="overview">Done</button>
          </div>
          ${detailsPanel()}
        </div>
      </section>
    </main>
  `;
}

function paymentsWorkspace() {
  const pane = state.mobilePaymentsPane || 'list';
  return `
    <main class="ops-main payments-workspace mobile-pane-${escapeHtml(pane)}">
      <header class="topbar">
        <div>
          <div class="eyebrow">Payment Operations</div>
          <h1>Payments</h1>
          ${paymentSyncStatus()}
        </div>
        <div class="stats">${paymentStatCards()}</div>
      </header>

      <section class="payments-layout">
        <section class="payments-feed">
          <div class="payments-toolbar">
            <input id="paymentSearchInput" class="search" value="${escapeHtml(state.paymentQuery)}" placeholder="Search sender, preview, message ID" />
            <div class="filter-row">${filterButtons(paymentStatusFilters, state.paymentStatusFilter, 'payment-status')}</div>
            <div class="filter-row">${filterButtons(paymentRoutingFilters, state.paymentRoutingFilter, 'payment-routing')}</div>
            <label class="checkbox-inline">
              <input id="paymentExceptionsOnly" type="checkbox" ${state.paymentExceptionsOnly ? 'checked' : ''} />
              Exceptions only
            </label>
          </div>
          <div class="payment-table-header">
            <span>Time</span>
            <span>Sender</span>
            <span>Preview</span>
            <span>Telegram ID</span>
            <span>Routing</span>
            <span>Status</span>
          </div>
          <div class="payment-table">${paymentRows()}</div>
        </section>

        <div class="payment-detail-wrap">
          <div class="details-sheet-bar mobile-only">
            <button type="button" class="icon-back" data-mobile-back="payments" aria-label="Back to payments">←</button>
            <strong>Payment detail</strong>
          </div>
          ${paymentDetailPanel()}
        </div>
      </section>
    </main>
  `;
}

function settingsWorkspace() {
  const settings = state.coadminSettings || {};
  const saving = state.settingsSaving;
  return `
    <main class="ops-main settings-main">
      <header class="topbar">
        <div>
          <div class="eyebrow">Configuration</div>
          <h1>Coadmin Settings</h1>
          <div class="subtle">Each connected Telegram business account belongs to one coadmin. Players are assigned automatically.</div>
        </div>
      </header>
      <section class="settings-layout">
        <section class="card settings-form-card">
          <div class="card-title">Coadmin Identity</div>
          <form id="coadminSettingsForm" class="settings-form">
            <label class="field-label">
              <span>Coadmin Name</span>
              <input id="coadminName" value="${escapeHtml(settings.coadmin_name || '')}" placeholder="e.g. Sayu Gaming" />
            </label>
            <label class="field-label">
              <span>Coadmin Code</span>
              <input id="coadminCode" value="${escapeHtml(settings.coadmin_code || '')}" placeholder="e.g. SAYU" />
            </label>
            <label class="field-label">
              <span>AppBeg Coadmin UID / ID</span>
              <input id="appbegCoadminUid" value="${escapeHtml(settings.appbeg_coadmin_uid || '')}" placeholder="AppBeg coadmin identifier" />
            </label>
            <div class="form-section-label">Telegram Business Account</div>
            <label class="field-label">
              <span>Telegram Account Username</span>
              <input id="telegramAccountUsername" value="${escapeHtml(settings.telegram_account_username || '')}" placeholder="@username" />
            </label>
            <label class="field-label">
              <span>Telegram Account ID</span>
              <input id="telegramAccountId" value="${escapeHtml(settings.telegram_account_id || '')}" placeholder="Numeric Telegram user ID" />
            </label>
            <div class="settings-meta subtle">
              Last updated ${settings.updated_at ? fmtDateTime(settings.updated_at) : 'never'}
              ${settings.updated_by ? ` by ${escapeHtml(settings.updated_by)}` : ''}
            </div>
            ${state.settingsError ? `<div class="settings-error">${escapeHtml(state.settingsError)}</div>` : ''}
            ${state.settingsSuccess ? `<div class="settings-success">${escapeHtml(state.settingsSuccess)}</div>` : ''}
            ${state.coadminBackfillResult ? `
              <div class="settings-backfill-result">
                ${escapeHtml(state.coadminBackfillResult)}
              </div>
            ` : ''}
            <div class="settings-actions">
              <button class="button" type="submit" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save Settings'}</button>
              <button class="button secondary" type="button" id="applyCoadminToContacts" ${state.coadminApplying ? 'disabled' : ''}>
                ${state.coadminApplying ? 'Applying…' : 'Apply to Existing Contacts'}
              </button>
            </div>
          </form>
        </section>
        <section class="card settings-audit-card">
          <div class="card-title">Settings Audit Log</div>
          <div class="settings-audit-list">${settingsAuditRows()}</div>
        </section>
        <section class="card settings-form-card">
          <div class="card-title">Staff Users</div>
          ${state.ledgerUsersLoading ? '<div class="subtle">Loading users…</div>' : ''}
          <div class="user-management-list">
            ${(state.ledgerUsers || []).map((user) => `
              <div class="user-management-row">
                <div>
                  <div class="strong">${escapeHtml(user.username)}</div>
                  <div class="subtle">${escapeHtml(user.role)}${user.is_active ? '' : ' · inactive'}</div>
                </div>
                ${user.id !== state.authUser?.id ? `
                  <button type="button" class="button secondary small" data-ledger-user-toggle="${user.id}" data-ledger-user-active="${user.is_active ? '1' : '0'}">
                    ${user.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                ` : '<span class="subtle">Current user</span>'}
              </div>
            `).join('') || '<div class="subtle">No staff users yet.</div>'}
          </div>
          <form id="createLedgerUserForm" class="settings-form" style="margin-top: 16px;">
            <div class="form-section-label">Add Staff User</div>
            <label class="field-label">
              <span>Username</span>
              <input id="newLedgerUsername" required minlength="3" />
            </label>
            <label class="field-label">
              <span>Password</span>
              <input id="newLedgerPassword" type="password" required minlength="8" />
            </label>
            <label class="field-label">
              <span>Role</span>
              <select id="newLedgerRole">
                <option value="staff">Staff</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <button class="button secondary" type="submit" ${state.ledgerUserSaving ? 'disabled' : ''}>
              ${state.ledgerUserSaving ? 'Creating…' : 'Create User'}
            </button>
          </form>
        </section>
      </section>
    </main>
  `;
}

function settingsAuditRows() {
  if (!state.settingsAuditLog?.length) {
    return '<div class="subtle">No settings changes recorded yet.</div>';
  }
  return state.settingsAuditLog.map((entry) => `
    <article class="audit-item">
      <div class="strong">${escapeHtml(entry.field_name.replaceAll('_', ' '))}</div>
      <div class="subtle">${escapeHtml(entry.actor_name || 'Staff')} · ${fmtDateTime(entry.created_at)}</div>
      <div class="audit-change">
        <span class="audit-old">${escapeHtml(entry.old_value || '—')}</span>
        <span class="audit-arrow">→</span>
        <span class="audit-new">${escapeHtml(entry.new_value || '—')}</span>
      </div>
    </article>
  `).join('');
}

function render() {
  const items = [
    { id: 'contacts', label: 'Contacts', icon: '💬' },
    { id: 'players', label: 'Players', icon: '👥' },
    { id: 'appbeg-players', label: 'AppBeg Players', icon: '📊' },
    { id: 'payments', label: 'Payments', icon: '💳' },
    { id: 'payment-info', label: 'Payment Info', icon: '🏦' },
    { id: 'settings', label: 'Settings', icon: '⚙️', adminOnly: true }
  ].filter((item) => !item.adminOnly || isAdmin());
  const navHtml = items.map((item) => `
    <button class="nav-item ${state.section === item.id ? 'active' : ''}" data-section="${item.id}" type="button">
      <span class="nav-icon" aria-hidden="true">${item.icon}</span>
      <span class="nav-label">${item.label}</span>
    </button>
  `).join('');
  const sectionTitle = items.find((item) => item.id === state.section)?.label || 'Operations';

  if (state.section === 'settings' && !isAdmin()) {
    state.section = 'contacts';
  }

  app.innerHTML = `
    <div class="ops-shell section-${escapeHtml(state.section)} ${state.navOpen ? 'nav-open' : ''} ${state.section === 'contacts' && state.mobileContactsPane !== 'list' ? 'chat-focused' : ''}">
      <button type="button" class="nav-drawer-backdrop" data-nav-close aria-label="Close menu"></button>
      <aside class="sidebar" id="appSidebar">
        <div class="brand">Royal VIP Coadmin</div>
        ${navHtml}
        <div class="user-bar">
          <div class="user-bar-meta">
            <div class="user-bar-name">${escapeHtml(state.authUser?.username || 'Staff')}</div>
            <div class="user-bar-role">${escapeHtml(state.authUser?.role || 'staff')}</div>
          </div>
          <button type="button" class="button secondary small" id="logoutButton">Log out</button>
        </div>
      </aside>
      <div class="mobile-topbar mobile-only">
        <button type="button" class="menu-toggle" data-nav-toggle aria-label="Open menu">☰</button>
        <div class="brand-inline">${escapeHtml(sectionTitle)}</div>
      </div>
      ${state.section === 'payments'
    ? paymentsWorkspace()
    : state.section === 'payment-info'
      ? paymentInfoController.renderPaymentInfoWorkspace(state)
    : state.section === 'appbeg-players'
      ? appbegPlayersController.renderAppBegPlayersWorkspace(state)
    : state.section === 'players'
      ? playersController.renderPlayersWorkspace(state, { avatar, fmtDateTime })
      : state.section === 'settings'
        ? settingsWorkspace()
        : contactsWorkspace()}
    </div>
    ${renderRegistrationModal(state)}
  `;
  bindEvents();
  if (state.section === 'players') {
    playersController.bindPlayersEvents(app);
  }
  if (state.section === 'payment-info') {
    paymentInfoController.bindPaymentInfoEvents(app);
  }
  if (state.section === 'appbeg-players') {
    appbegPlayersController.bindAppBegPlayersEvents(app);
  }
  scrollChatToBottom();
}

function bindPersistentEvents() {
  if (composerEventsBound) return;
  composerEventsBound = true;

  app.addEventListener('submit', (event) => {
    const form = event.target.closest('#sendForm');
    if (!form) return;
    event.preventDefault();
    void submitOutgoingMessage();
  });

  app.addEventListener('keydown', (event) => {
    if (event.target.id !== 'messageText') return;
    handleComposerKeydown(event);
  });

  app.addEventListener('input', (event) => {
    if (event.target.id !== 'messageText') return;
    state.draft = event.target.value;
  });

  app.addEventListener('submit', (event) => {
    const form = event.target.closest('#coadminSettingsForm');
    if (!form) return;
    event.preventDefault();
    void saveCoadminSettings();
  });

  app.addEventListener('click', (event) => {
    const button = event.target.closest('#applyCoadminToContacts');
    if (!button || button.disabled) return;
    event.preventDefault();
    void applyCoadminToExistingContacts();
  });

  app.addEventListener('click', (event) => {
    const overviewBtn = event.target.closest('[data-overview-action]');
    if (overviewBtn) {
      event.preventDefault();
      event.stopPropagation();
      void handleOverviewAction(overviewBtn.dataset.overviewAction);
      return;
    }

    const playerBtn = event.target.closest('[data-player-action]');
    if (playerBtn) {
      event.preventDefault();
      event.stopPropagation();
      void handlePlayerQuickAction(playerBtn.dataset.playerAction, Number(playerBtn.dataset.playerId));
      return;
    }

    const panelBtn = event.target.closest('[data-panel-action]');
    if (panelBtn) {
      event.preventDefault();
      event.stopPropagation();
      const action = panelBtn.dataset.panelAction;
      if (action === 'copy') {
        void navigator.clipboard.writeText(panelBtn.dataset.copyValue || '');
        return;
      }
      void handlePlayerQuickAction(action, state.selectedPlayerId);
      return;
    }

    if (event.target.closest('#openRegistrationModalBtn')) {
      event.preventDefault();
      event.stopPropagation();
      if (state.selectedContactId) void openRegistrationModal(state.selectedContactId);
      return;
    }
    if (event.target.closest('#cancelRegistrationModal') || event.target.closest('#closeRegistrationModal')) {
      event.preventDefault();
      closeRegistrationModal();
      return;
    }
    if (event.target.closest('[data-modal-backdrop]') && event.target.id === 'registrationModalBackdrop') {
      closeRegistrationModal();
    }
  });

  app.addEventListener('input', (event) => {
    if (event.target.id !== 'wizardFieldInput') return;
    const field = event.target.dataset.wizardField;
    if (!field || !state.registrationWizard?.active) return;
    state.registrationWizard = {
      ...state.registrationWizard,
      form: { ...state.registrationWizard.form, [field]: event.target.value },
      error: null
    };
  });

  app.addEventListener('keydown', (event) => {
    if (event.target.id !== 'wizardFieldInput') return;
    if (event.key !== 'Enter') return;
    event.preventDefault();
    wizardNextStep();
  });

  app.addEventListener('submit', (event) => {
    const form = event.target.closest('#registrationModalForm');
    if (!form) return;
    event.preventDefault();
    void saveRegistrationModal();
  });
}

function setComposerSending(isSending) {
  sendingMessage = isSending;
  state.sendingMessage = isSending;
  const button = document.querySelector('#sendForm .send-button');
  const textarea = document.querySelector('#messageText');
  if (button) {
    button.disabled = isSending;
    button.textContent = isSending ? 'Sending…' : 'Send';
  }
  if (textarea) textarea.disabled = isSending;
}

function bindEvents() {
  document.querySelectorAll('[data-player-action]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void handlePlayerQuickAction(button.dataset.playerAction, Number(button.dataset.playerId));
    });
  });

  document.querySelectorAll('[data-panel-action]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.panelAction;
      if (action === 'copy') {
        void navigator.clipboard.writeText(button.dataset.copyValue || '');
        return;
      }
      void handlePlayerQuickAction(action, state.selectedPlayerId);
    });
  });

  document.querySelectorAll('[data-section]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.section = button.dataset.section;
      state.navOpen = false;
      if (state.section === 'contacts') state.mobileContactsPane = 'list';
      if (state.section === 'payments') state.mobilePaymentsPane = 'list';
      if (state.section === 'players') state.mobilePlayersPane = 'list';
      if (state.section === 'settings') {
        state.settingsError = null;
        state.settingsSuccess = null;
        await refreshLedgerUsers();
      }
      if (state.section === 'players') {
        await refreshPlayers({ keepSelection: true });
      }
      if (state.section === 'payment-info') {
        state.paymentInfoError = null;
        state.paymentInfoSuccess = null;
        state.paymentInfoView = 'list';
        await paymentInfoController.refreshPaymentMethods();
      }
      if (state.section === 'appbeg-players') {
        await appbegPlayersController.refreshAppBegPlayers();
      }
      render();
    });
  });

  document.querySelector('#logoutButton')?.addEventListener('click', (event) => {
    event.preventDefault();
    void logout();
  });

  document.querySelector('#createLedgerUserForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void createLedgerUser(event.target);
  });

  document.querySelectorAll('[data-ledger-user-toggle]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      void toggleLedgerUser(
        Number(button.dataset.ledgerUserToggle),
        button.dataset.ledgerUserActive !== '1'
      );
    });
  });

  document.querySelectorAll('[data-nav-toggle]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      state.navOpen = !state.navOpen;
      document.querySelector('.ops-shell')?.classList.toggle('nav-open', state.navOpen);
    });
  });

  document.querySelectorAll('[data-nav-close]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      state.navOpen = false;
      document.querySelector('.ops-shell')?.classList.remove('nav-open');
    });
  });

  document.querySelectorAll('[data-mobile-back]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const target = button.dataset.mobileBack;
      if (target === 'contacts') state.mobileContactsPane = 'list';
      if (target === 'payments') state.mobilePaymentsPane = 'list';
      if (target === 'players') state.mobilePlayersPane = 'list';
      render();
    });
  });

  document.querySelectorAll('[data-mobile-panel]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      state.mobileContactsPane = button.dataset.mobilePanel;
      render();
    });
  });

  document.querySelector('#manualRefresh')?.addEventListener('click', async () => {
    await refreshDashboardFallback('manual refresh');
    render();
  });
  document.querySelector('#manualRefreshMobile')?.addEventListener('click', async () => {
    await refreshDashboardFallback('manual refresh');
    render();
  });

  document.querySelector('#searchInput')?.addEventListener('input', (event) => {
    state.query = event.target.value;
    render();
  });

  document.querySelector('#paymentSearchInput')?.addEventListener('input', async (event) => {
    state.paymentQuery = event.target.value;
    await refreshPayments({ keepSelection: false });
    await refreshSelectedPayment();
    render();
  });

  document.querySelectorAll('[data-payment-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.paymentStatusFilter = button.dataset.paymentStatus;
      await refreshPayments({ keepSelection: false });
      await refreshSelectedPayment();
      render();
    });
  });

  document.querySelectorAll('[data-payment-routing]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.paymentRoutingFilter = button.dataset.paymentRouting;
      await refreshPayments({ keepSelection: false });
      await refreshSelectedPayment();
      render();
    });
  });

  document.querySelector('#paymentExceptionsOnly')?.addEventListener('change', async (event) => {
    state.paymentExceptionsOnly = event.target.checked;
    await refreshPayments({ keepSelection: false });
    await refreshSelectedPayment();
    render();
  });

  document.querySelectorAll('[data-registration]').forEach((button) => {
    button.addEventListener('click', () => {
      state.registrationFilter = button.dataset.registration;
      selectVisibleIfNeeded();
    });
  });

  document.querySelectorAll('[data-conversation]').forEach((button) => {
    button.addEventListener('click', () => {
      state.conversationFilter = button.dataset.conversation;
      selectVisibleIfNeeded();
    });
  });

  document.querySelector('#assigneeFilter')?.addEventListener('change', (event) => {
    state.assigneeFilter = event.target.value;
    selectVisibleIfNeeded();
  });

  document.querySelectorAll('[data-contact-id]').forEach((row) => {
    row.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await openContactById(Number(row.dataset.contactId));
    });
  });

  document.querySelectorAll('[data-payment-id]').forEach((row) => {
    row.addEventListener('click', async () => {
      state.selectedPaymentId = Number(row.dataset.paymentId);
      state.mobilePaymentsPane = 'detail';
      await refreshSelectedPayment();
      render();
    });
  });

  document.querySelector('#conversationStatus')?.addEventListener('change', changeConversationStatus);
  document.querySelector('#assignConversation')?.addEventListener('click', assignConversation);
  document.querySelector('#addNote')?.addEventListener('click', addNote);
  document.querySelectorAll('[data-bot-action]').forEach((button) => {
    button.addEventListener('click', () => controlBotState(button.dataset.botAction));
  });
  document.querySelectorAll('[data-bot-control]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      void controlChatbot(button.dataset.botControl);
    });
  });
  document.querySelectorAll('[data-automation-action]').forEach((button) => {
    button.addEventListener('click', () => controlAutomation(button.dataset.automationAction));
  });
  document.querySelectorAll('[data-reply-id]').forEach((button) => {
    button.addEventListener('click', () => insertQuickReply(Number(button.dataset.replyId)));
  });
}

async function selectVisibleIfNeeded() {
  const visible = filteredContacts();
  if (!state.selectedContactId || !visible.some((contact) => contact.id === state.selectedContactId)) {
    state.selectedContactId = visible[0]?.id || null;
    state.contact = null;
    state.messages = [];
    state.notes = [];
    state.timeline = [];
    state.automationState = null;
    state.automationLogs = [];
  }
  render();
}

async function changeConversationStatus(event) {
  const contactId = Number(state.selectedContactId);
  await api(`/api/contacts/${state.selectedContactId}/conversation-status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: event.target.value, staffName: state.staffName })
  });
  contactDetailCache.delete(contactId);
  await refreshContacts({ force: true, reason: 'conversation status changed' });
  render();
}

async function assignConversation() {
  const contactId = Number(state.selectedContactId);
  const input = document.querySelector('#assignmentInput');
  const staffName = input.value.trim();
  await api(`/api/contacts/${state.selectedContactId}/assignment`, {
    method: 'PATCH',
    body: JSON.stringify({ staffName, actorName: state.staffName })
  });
  contactDetailCache.delete(contactId);
  await refreshContacts({ force: true, reason: 'assignment changed' });
  render();
}

async function controlBotState(action) {
  const contactId = Number(state.selectedContactId);
  await api(`/api/contacts/${state.selectedContactId}/bot-state`, {
    method: 'POST',
    body: JSON.stringify({ action, staffName: state.staffName, sendMenu: true })
  });
  contactDetailCache.delete(contactId);
  await refreshContacts({ force: true, reason: 'bot state changed' });
  render();
}

async function controlChatbot(action) {
  const contactId = Number(state.selectedContactId);
  if (!contactId || !action) return;
  await api(`/api/contacts/${contactId}/bot-control`, {
    method: 'POST',
    body: JSON.stringify({ action, staffName: state.staffName })
  });
  contactDetailCache.delete(contactId);
  await refreshSelectedContact({ force: true, reason: 'chatbot control' });
  await refreshContacts({ force: true, reason: 'chatbot control' });
  if (action === 'takeover' || action === 'pause') {
    state.mobileContactsPane = 'chat';
  }
  render();
}

async function saveCoadminSettings() {
  const formValues = readCoadminFormValues();
  state.coadminSettings = { ...state.coadminSettings, ...formValues };
  state.settingsSaving = true;
  state.settingsError = null;
  state.settingsSuccess = null;
  state.coadminBackfillResult = null;
  render();

  try {
    const payload = await api('/api/coadmin-settings', {
      method: 'POST',
      body: JSON.stringify({
        ...formValues,
        staff_name: state.staffName
      })
    });
    state.coadminSettings = payload.settings || formValues;
    state.settingsAuditLog = payload.audit_log || payload.auditLog || [];
    state.settingsSuccess = payload.message || 'Settings saved successfully.';
    state.coadminBackfillResult = formatCoadminBackfillResult(payload.backfill);
    if (payload.backfill?.assigned > 0) {
      contactDetailCache.clear();
      await refreshContacts({ force: true, reason: 'coadmin settings backfill' });
      await refreshPlayers({ keepSelection: true, silent: true });
    }
  } catch (error) {
    console.error('[coadmin-settings] save failed:', error);
    state.settingsError = error.message || 'Failed to save settings.';
    state.coadminSettings = { ...state.coadminSettings, ...formValues };
  } finally {
    state.settingsSaving = false;
    render();
  }
}

async function applyCoadminToExistingContacts() {
  const formValues = readCoadminFormValues();
  state.coadminSettings = { ...state.coadminSettings, ...formValues };
  state.coadminApplying = true;
  state.settingsError = null;
  state.settingsSuccess = null;
  state.coadminBackfillResult = null;
  render();

  try {
    const payload = await api('/api/coadmin-settings/apply', {
      method: 'POST',
      body: JSON.stringify({ staff_name: state.staffName })
    });
    state.coadminSettings = payload.settings || state.coadminSettings;
    state.settingsAuditLog = payload.audit_log || payload.auditLog || state.settingsAuditLog;
    state.settingsSuccess = payload.message || 'Coadmin assignment applied.';
    state.coadminBackfillResult = formatCoadminBackfillResult(payload.backfill);
    if (payload.backfill?.assigned > 0) {
      contactDetailCache.clear();
      await refreshContacts({ force: true, reason: 'coadmin apply backfill' });
      await refreshPlayers({ keepSelection: true, silent: true });
    }
  } catch (error) {
    console.error('[coadmin-settings] apply failed:', error);
    state.settingsError = error.message || 'Failed to apply coadmin to contacts.';
    state.coadminSettings = { ...state.coadminSettings, ...formValues };
  } finally {
    state.coadminApplying = false;
    render();
  }
}

function formatCoadminBackfillResult(backfill) {
  if (!backfill) return null;
  if (!backfill.total) return 'No business-account contacts matched the configured Telegram account.';
  if (!backfill.assigned) {
    return `All ${backfill.total} matching contact(s) already have this coadmin assigned.`;
  }
  return `Assigned coadmin to ${backfill.assigned} contact(s). ${backfill.skipped} already up to date.`;
}

async function controlAutomation(action) {
  const body = { staffName: state.staffName };
  if (action === 'start') {
    await api(`/api/contacts/${state.selectedContactId}/automation/start-flow`, {
      method: 'POST',
      body: JSON.stringify({ ...body, flowKey: 'registration_info', sendMessage: true })
    });
  }
  if (action === 'cancel') {
    await api(`/api/contacts/${state.selectedContactId}/automation/cancel`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }
  if (action === 'reset') {
    await api(`/api/contacts/${state.selectedContactId}/automation/reset`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }
  if (action === 'save-info') {
    await api(`/api/contacts/${state.selectedContactId}/automation/registration-info`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...body,
        registrationInfo: {
          preferred_appbeg_username: document.querySelector('#regUsername').value.trim(),
          payment_tag: document.querySelector('#regPaymentTag').value.trim(),
          preferred_game: document.querySelector('#regGame').value.trim(),
          note: document.querySelector('#regNote').value.trim()
        }
      })
    });
  }
  if (action === 'reviewed') {
    await api(`/api/contacts/${state.selectedContactId}/automation/mark-reviewed`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }
  contactDetailCache.delete(Number(state.selectedContactId));
  await refreshContacts({ force: true, reason: 'automation action' });
  render();
}

async function addNote() {
  const staffInput = document.querySelector('#staffName');
  const noteInput = document.querySelector('#noteText');
  state.staffName = staffInput.value.trim() || 'Staff';
  localStorage.setItem('staffName', state.staffName);
  const text = noteInput.value.trim();
  if (!text) return;
  await api(`/api/contacts/${state.selectedContactId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ staffName: state.staffName, text })
  });
  contactDetailCache.delete(Number(state.selectedContactId));
  await refreshContacts({ force: true, reason: 'note added' });
  render();
}

function insertQuickReply(replyId) {
  const reply = state.quickReplies.find((item) => item.id === replyId);
  if (!reply) return;
  const input = document.querySelector('#messageText');
  const prefix = input.value.trim() ? `${input.value.trim()}\n` : '';
  state.draft = `${prefix}${reply.body}`;
  input.value = state.draft;
  input.focus();
}

function handleComposerKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (sendingMessage) return;
  void submitOutgoingMessage();
}

async function submitOutgoingMessage() {
  if (sendingMessage) return;
  if (!state.selectedContactId) return;

  const input = document.querySelector('#messageText');
  const text = (input?.value || state.draft || '').trim();
  if (!text) return;

  const clientRequestId = crypto.randomUUID();
  sendingMessage = true;
  setComposerSending(true);

  try {
    await api(`/api/contacts/${state.selectedContactId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        staffName: state.staffName,
        client_request_id: clientRequestId
      })
    });
    state.draft = '';
    if (input) input.value = '';
    contactDetailCache.delete(Number(state.selectedContactId));
    await refreshContacts({ force: true, reason: 'message sent' });
    render();
  } catch (error) {
    alert(error.message);
    setComposerSending(false);
  } finally {
    sendingMessage = false;
    state.sendingMessage = false;
    setComposerSending(false);
  }
}

function scrollChatToBottom() {
  const chat = document.querySelector('#chatLog');
  if (!chat) return;
  requestAnimationFrame(() => {
    chat.scrollTop = chat.scrollHeight;
  });
}

function setupMobileViewport() {
  if (typeof window === 'undefined' || window.__mobileViewportBound) return;
  window.__mobileViewportBound = true;

  const applyViewportHeight = () => {
    const height = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--app-vh', `${height}px`);
  };

  applyViewportHeight();
  window.addEventListener('resize', applyViewportHeight);
  window.visualViewport?.addEventListener('resize', applyViewportHeight);
  window.visualViewport?.addEventListener('scroll', applyViewportHeight);

  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    setTimeout(() => {
      event.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      scrollChatToBottom();
    }, 120);
  });
}

function refreshContactsDebounced(reason = 'event', { force = true, keepSelection = true } = {}) {
  if (contactsRefreshTimer) clearTimeout(contactsRefreshTimer);
  contactsRefreshTimer = setTimeout(async () => {
    contactsRefreshTimer = null;
    try {
      await refreshContacts({ force, keepSelection, reason });
      render();
    } catch (error) {
      console.warn('[contacts] scheduled refresh failed:', error);
    }
  }, CONTACTS_REFRESH_DEBOUNCE_MS);
}

function refreshStatsDebounced(reason = 'event', { force = true } = {}) {
  if (statsRefreshTimer) clearTimeout(statsRefreshTimer);
  statsRefreshTimer = setTimeout(async () => {
    statsRefreshTimer = null;
    try {
      await refreshStats({ force, reason });
      render();
    } catch (error) {
      console.warn('[stats] scheduled refresh failed:', error);
    }
  }, STATS_REFRESH_DEBOUNCE_MS);
}

function refreshSyncStatusDebounced(reason = 'event', { force = true } = {}) {
  if (syncStatusRefreshTimer) clearTimeout(syncStatusRefreshTimer);
  syncStatusRefreshTimer = setTimeout(async () => {
    syncStatusRefreshTimer = null;
    try {
      await refreshSyncStatus({ force, reason });
      render();
    } catch (error) {
      console.warn('[sync] scheduled refresh failed:', error);
    }
  }, SYNC_STATUS_REFRESH_DEBOUNCE_MS);
}

async function refreshDashboardFallback(reason = 'poll fallback') {
  await Promise.all([
    refreshContacts({ force: true, reason }),
    refreshStats({ force: true, reason }),
    refreshSyncStatus({ force: true, reason })
  ]);
}

function scheduleTelegramSyncRefresh(payload = {}) {
  pendingTelegramSyncRefresh = {
    affectsContacts: Boolean(pendingTelegramSyncRefresh?.affectsContacts || payload.affectsContacts),
    affectsStats: Boolean(pendingTelegramSyncRefresh?.affectsStats || payload.affectsStats),
    affectsSyncStatus: Boolean(pendingTelegramSyncRefresh?.affectsSyncStatus || payload.affectsSyncStatus)
  };

  if (telegramSyncRefreshTimer) clearTimeout(telegramSyncRefreshTimer);
  telegramSyncRefreshTimer = setTimeout(async () => {
    telegramSyncRefreshTimer = null;
    const pending = pendingTelegramSyncRefresh;
    pendingTelegramSyncRefresh = null;
    if (!pending) return;

    const refreshes = [];
    if (pending.affectsContacts) refreshes.push(refreshContacts({ force: true, reason: 'telegram-sync:changed' }));
    if (pending.affectsStats) refreshes.push(refreshStats({ force: true, reason: 'telegram-sync:changed' }));
    if (pending.affectsSyncStatus) refreshes.push(refreshSyncStatus({ force: true, reason: 'telegram-sync:changed' }));
    if (!refreshes.length) return;

    try {
      await Promise.all(refreshes);
      render();
    } catch (error) {
      console.warn('[telegram-sync] refresh failed:', error);
    }
  }, CONTACTS_REFRESH_DEBOUNCE_MS);
}

function startGlobalPolling() {
  if (globalPollInterval) return;
  globalPollInterval = setInterval(() => {
    if (document.hidden) return;
    void refreshDashboardFallback('30s fallback')
      .then(() => render())
      .catch((error) => console.warn('[dashboard] polling refresh failed:', error));
  }, CONTACTS_POLL_MS);
}

async function createLedgerUser(form) {
  state.ledgerUserSaving = true;
  state.settingsError = null;
  state.settingsSuccess = null;
  render();
  try {
    const username = form.querySelector('#newLedgerUsername')?.value?.trim();
    const password = form.querySelector('#newLedgerPassword')?.value || '';
    const role = form.querySelector('#newLedgerRole')?.value || 'staff';
    await api('/api/auth/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, role })
    });
    form.reset();
    state.settingsSuccess = `User ${username} created.`;
    await refreshLedgerUsers();
  } catch (error) {
    state.settingsError = error.message || 'Could not create user.';
  } finally {
    state.ledgerUserSaving = false;
    render();
  }
}

async function toggleLedgerUser(userId, isActive) {
  state.settingsError = null;
  state.settingsSuccess = null;
  try {
    await api(`/api/auth/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: isActive })
    });
    state.settingsSuccess = isActive ? 'User activated.' : 'User deactivated.';
    await refreshLedgerUsers();
  } catch (error) {
    state.settingsError = error.message || 'Could not update user.';
  }
  render();
}

async function boot() {
  bindPersistentEvents();
  setupMobileViewport();
  try {
    await loadAuthUser();
    await Promise.all([
      refreshContacts({ keepSelection: false, force: true, reason: 'startup' }),
      refreshStats({ force: true, reason: 'startup' }),
      refreshSyncStatus({ force: true, reason: 'startup' }),
      refreshCoadminSettings()
    ]);
    await refreshSelectedContact({ reason: 'startup selected contact' });
    render();
    startGlobalPolling();
  } catch (error) {
    if (error.status === 401) {
      window.location.href = '/login';
      return;
    }
    const detail = error.toDisplayString?.() || error.message || 'Unknown startup error';
    const route = error.path ? `<p><strong>API:</strong> <code>${escapeHtml(error.path)}</code></p>` : '';
    const status = error.status !== undefined ? `<p><strong>Status:</strong> ${escapeHtml(String(error.status))}</p>` : '';
    const body = error.body ? `<pre class="fatal-body">${escapeHtml(JSON.stringify(error.body, null, 2))}</pre>` : '';
    app.innerHTML = `<div class="fatal">
      <h1>Operations Center failed to start</h1>
      <p>${escapeHtml(detail)}</p>
      ${route}
      ${status}
      ${body}
      <p><a href="/api/health/full" target="_blank" rel="noopener">Open full health check</a></p>
    </div>`;
    console.error('[boot] startup failed:', error);
  }
}

socket.on('telegram-sync:changed', (payload = {}) => {
  if (payload.contactId) contactDetailCache.delete(Number(payload.contactId));
  scheduleTelegramSyncRefresh(payload);
});

socket.on('contacts:changed', () => {});

socket.on('users:changed', () => {});

socket.on('contact:changed', ({ contactId } = {}) => {
  const id = normalizeContactId(contactId);
  if (id) contactDetailCache.delete(id);
});

socket.on('message:new', async ({ contactId, userId } = {}) => {
  const id = normalizeContactId(contactId || userId);
  if (id) contactDetailCache.delete(id);
  if (state.selectedContactId !== id) return;
  try {
    await refreshSelectedContact({ force: true, reason: 'message:new selected contact' });
    render();
  } catch (error) {
    console.warn('[contacts] selected message refresh failed:', error);
  }
});

socket.on('sync:changed', () => {});

socket.on('settings:changed', () => {});

socket.on('players:changed', () => {});

socket.on('player:updated', () => {});

socket.on('payments:changed', () => {});

socket.on('payment:new', () => {});

socket.on('payment-sync:changed', () => {});

boot();
