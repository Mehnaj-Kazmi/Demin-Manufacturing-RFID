import { api, token, ApiError } from './api.js';
import { $, el, clear, loading, toast, toastErr, initials } from './ui.js';

/* ------------------------------------------------------------------ */
/* Application state                                                   */
/* ------------------------------------------------------------------ */
export const state = {
  user: null,
  caps: [],
  meta: null,
  masters: {},       // cached lookup lists
  page: null,
};

export const can = (cap) => state.caps.includes(cap);

/** Cached master-data lookups; most screens need the same handful. */
export async function masters(name, { force = false } = {}) {
  if (!force && state.masters[name]) return state.masters[name];
  const r = await api.get(`/api/masters/${name}`, { active_only: 1 });
  state.masters[name] = r.rows;
  return r.rows;
}

export const lookup = (name, id) => (state.masters[name] || []).find((r) => r.id === Number(id));
export const stageName = (code) => state.meta?.stages.find((s) => s.code === code)?.name || code;
export const stageColor = (code) => state.meta?.stages.find((s) => s.code === code)?.color || '#888';

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */
const NAV = [
  { group: 'Overview', items: [
    { key: 'dashboard', label: 'Dashboard',    icon: '▦', cap: 'kpi.view',   module: './pages/dashboard.js' },
    { key: 'sections',  label: 'Section WIP',  icon: '▤', cap: 'kpi.view',   module: './pages/wip.js' },
  ] },
  { group: 'Production', items: [
    { key: 'fabric',    label: 'Fabric Store', icon: '▧', cap: null,         module: './pages/fabric.js' },
    { key: 'cutting',   label: 'Cutting',      icon: '✁', cap: null,         module: './pages/cutting.js' },
    { key: 'stitching', label: 'Stitching',    icon: '✂', cap: null,         module: './pages/stitching.js' },
    { key: 'sorting',   label: 'Sorting',      icon: '⑃', cap: null,         module: './pages/sorting.js' },
    { key: 'transfers', label: 'Transfers',    icon: '⇄', cap: null,         module: './pages/transfers.js' },
  ] },
  { group: 'Quality & Output', items: [
    { key: 'qc',        label: 'Quality Control', icon: '✓', cap: null,      module: './pages/qc.js' },
    { key: 'retrofit',  label: 'Retrofitting',    icon: '⟲', cap: null,      module: './pages/retrofit.js' },
    { key: 'dispatch',  label: 'Dispatch',        icon: '⇥', cap: null,      module: './pages/dispatch.js' },
  ] },
  { group: 'Information', items: [
    { key: 'trace',     label: 'Trace Article', icon: '⌕', cap: null,        module: './pages/trace.js' },
    { key: 'orders',    label: 'Orders',        icon: '≡', cap: null,        module: './pages/orders.js' },
    { key: 'reports',   label: 'Reports',       icon: '▥', cap: 'reports.view', module: './pages/reports.js' },
  ] },
  { group: 'Setup', items: [
    { key: 'masters',   label: 'Master Data',   icon: '⚙', cap: 'masters.manage', module: './pages/masters.js' },
    { key: 'admin',     label: 'Users & Readers', icon: '☖', cap: 'admin.users',  module: './pages/admin.js' },
    { key: 'audit',     label: 'Audit Trail',   icon: '❐', cap: 'admin.audit',    module: './pages/audit.js' },
  ] },
];

const pageIndex = new Map(NAV.flatMap((g) => g.items.map((i) => [i.key, i])));

function buildNav() {
  const nav = clear($('#nav'));
  for (const group of NAV) {
    const visible = group.items.filter((i) => !i.cap || can(i.cap));
    if (!visible.length) continue;
    nav.appendChild(el('div', { class: 'nav-group' },
      el('div', { class: 'nav-group-label' }, group.group),
      visible.map((item) => el('button', {
        class: 'nav-item', dataset: { key: item.key },
        onClick: () => go(item.key),
      },
        el('span', { class: 'nav-icon' }, item.icon),
        el('span', {}, item.label),
        el('span', { class: 'nav-badge', dataset: { badge: item.key }, hidden: true })))));
  }
}

export function setBadge(key, value, alert = false) {
  const node = document.querySelector(`[data-badge="${key}"]`);
  if (!node) return;
  if (!value) { node.hidden = true; return; }
  node.hidden = false;
  node.textContent = String(value);
  node.classList.toggle('alert', alert);
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
export function go(key, params = {}) {
  const qs = new URLSearchParams(params).toString();
  location.hash = `#/${key}${qs ? '?' + qs : ''}`;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { key: path || 'dashboard', params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

let renderToken = 0;

async function renderRoute() {
  const { key, params } = parseHash();
  const item = pageIndex.get(key);
  const view = $('#view');

  if (!item) { go('dashboard'); return; }
  if (item.cap && !can(item.cap)) {
    clear(view).appendChild(el('div', { class: 'empty' },
      el('strong', {}, 'Not available for your role'),
      el('div', {}, `Your account (${state.user.role}) does not have access to ${item.label}.`)));
    return;
  }

  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.key === key));
  $('#page-title').textContent = item.label;
  $('#page-sub').textContent = '';
  clear($('#page-tools'));
  clear(view).appendChild(loading());
  $('#sidebar').classList.remove('open');

  const myToken = ++renderToken;
  state.page = key;

  try {
    const mod = await import(item.module);
    if (myToken !== renderToken) return;   // a newer navigation won
    const ctx = {
      params,
      setSubtitle: (t) => { $('#page-sub').textContent = t || ''; },
      setTitle: (t) => { $('#page-title').textContent = t; },
      setTools: (...nodes) => { clear($('#page-tools')); nodes.flat().filter(Boolean).forEach((n) => $('#page-tools').appendChild(n)); },
      reload: () => renderRoute(),
    };
    const node = await mod.render(ctx);
    if (myToken !== renderToken) return;
    clear(view);
    if (node) view.appendChild(node);
  } catch (err) {
    if (myToken !== renderToken) return;
    console.error(err);
    clear(view).appendChild(el('div', { class: 'empty' },
      el('strong', {}, 'This screen could not be loaded'),
      el('div', {}, err?.message || String(err)),
      el('div', { class: 'mt' }, el('button', { class: 'btn', onClick: () => renderRoute() }, 'Try again'))));
  }
}

/* ------------------------------------------------------------------ */
/* Session bootstrap                                                   */
/* ------------------------------------------------------------------ */
async function startSession() {
  const me = await api.get('/api/auth/me');
  state.user = me.user;
  state.caps = me.caps;
  state.meta = await api.get('/api/meta');

  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#who-name').textContent = state.user.full_name;
  $('#who-role').textContent = `${state.user.role}${state.user.section ? ' · ' + stageName(state.user.section) : ''}`;
  $('#who-avatar').textContent = initials(state.user.full_name);
  $('#brand-shift').textContent = me.shift === 'OFF' ? 'Outside shift hours' : `Shift ${me.shift}`;

  buildNav();
  await renderRoute();
  refreshBadges();
  setInterval(refreshBadges, 60000);
}

/** Keeps the "waiting for you" counters in the sidebar current. */
async function refreshBadges() {
  if (!state.user) return;
  try {
    const home = state.user.section;
    if (home) {
      const pending = await api.get(`/api/movements/pending/${home}`);
      setBadge('transfers', pending.rows.length, pending.rows.length > 0);
    }
    if (can('qc.inspect') || can('kpi.view')) {
      const alerts = await api.get('/api/kpi/alerts');
      setBadge('dashboard', alerts.variance_docs.length, alerts.variance_docs.length > 0);
    }
  } catch { /* badges are best-effort */ }
}

function showLogin(message) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  const errBox = $('#login-error');
  if (message) { errBox.textContent = message; errBox.hidden = false; }
  else errBox.hidden = true;
  $('#login-user').focus();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  try {
    const out = await api.post('/api/auth/login', {
      username: $('#login-user').value.trim(), password: $('#login-pass').value });
    token.set(out.token);
    $('#login-pass').value = '';
    $('#login-error').hidden = true;
    await startSession();
    toast(`Welcome, ${out.user.full_name.split(' ')[0]}`, `Signed in as ${out.user.role}.`, 'ok');
  } catch (err) {
    $('#login-error').textContent = err instanceof ApiError ? err.message : 'Sign-in failed';
    $('#login-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api.post('/api/auth/logout'); } catch { /* session may already be gone */ }
  token.clear();
  state.user = null;
  location.hash = '';
  showLogin();
});

$('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('drfid_theme', next);
});

window.addEventListener('auth:expired', () => showLogin('Your session expired. Please sign in again.'));
window.addEventListener('hashchange', () => { if (state.user) renderRoute(); });
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof ApiError && e.reason.status !== 401) toastErr(e.reason);
});

/* ------------------------------- Boot ----------------------------------- */
document.documentElement.dataset.theme =
  localStorage.getItem('drfid_theme') ||
  (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

if (token.get()) {
  startSession().catch(() => { token.clear(); showLogin(); });
} else {
  showLogin();
}
