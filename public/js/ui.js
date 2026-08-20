/** Small DOM toolkit: elements, tables, modals, toasts and the shared scan pad. */

import { api } from './api.js';

/* ------------------------------ Elements -------------------------------- */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  append(node, children);
  return node;
}

function append(parent, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

/**
 * Replace a container's contents. Unlike `replaceChildren`, null/undefined/false
 * children are skipped rather than stringified, so `cond ? card(...) : null`
 * works the same way it does inside `el()`.
 */
export function mount(parent, ...children) {
  clear(parent);
  append(parent, children);
  return parent;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------ Formatting ------------------------------ */
export const num = (n) => (n === null || n === undefined || n === '' ? '-' : Number(n).toLocaleString());

export function dateTime(v) {
  if (!v) return '-';
  const d = new Date(String(v).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString([], { year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function dateOnly(v) {
  if (!v) return '-';
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });
}

/** "3h 20m", "2d 4h" - how long something has been sitting somewhere. */
export function age(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0) return '-';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;
  return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`;
}

export function since(ts) {
  if (!ts) return '-';
  const d = new Date(String(ts).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '-';
  return age((Date.now() - d.getTime()) / 3600000);
}

export const initials = (name) =>
  String(name || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

/* -------------------------------- Chips --------------------------------- */
const CHIP_TONE = {
  IN_STAGE: '', IN_TRANSIT: 'info', REWORK: 'warn', READY: 'ok', SHIPPED: 'brand', HOLD: 'warn', SCRAP: 'danger',
  PENDING: '', PASS: 'ok', FAIL: 'danger', REWORKED: 'info',
  DISPATCHED: 'info', RECEIVED: 'ok', VARIANCE: 'warn', CANCELLED: 'danger', CLOSED: '',
  OPEN: 'info', IN_PROGRESS: 'warn', DONE: 'ok', PACKED: 'info',
  IN_STOCK: 'ok', PARTIAL: 'warn', CONSUMED: '', QUARANTINE: 'danger', ISSUED: 'info',
  CUT: '', ISSUED_TO_STITCH: 'info', IN_STITCHING: 'warn',
  PLANNED: '', CUTTING: 'warn', CRITICAL: 'danger', MAJOR: 'warn', MINOR: 'info',
  MATCHED: 'ok', EXPECTED: '', EXTRA: 'warn', MISSING: 'danger', UNKNOWN: 'danger',
};

export const chip = (label, tone) =>
  el('span', { class: `chip ${tone ?? CHIP_TONE[label] ?? ''}`.trim() }, String(label ?? '-').replace(/_/g, ' '));

export const swatch = (hex) => el('span', { class: 'swatch', style: { background: hex || '#ccc' } });

/* -------------------------------- Tables -------------------------------- */
/**
 * cols: [{ key, label, num, mono, width, render(row) }]
 * opts: { onRow, empty, footer, maxHeight, className }
 */
export function table(cols, rows, opts = {}) {
  const wrap = el('div', { class: opts.maxHeight ? 'table-wrap table-scroll' : 'table-wrap' });
  if (opts.maxHeight) wrap.style.maxHeight = opts.maxHeight;

  if (!rows || !rows.length) {
    wrap.appendChild(el('div', { class: 'empty' },
      el('strong', {}, opts.empty || 'Nothing to show'),
      opts.emptyHint ? el('div', {}, opts.emptyHint) : null));
    return wrap;
  }

  const t = el('table', { class: `data ${opts.className || ''}`.trim() });
  t.appendChild(el('thead', {}, el('tr', {}, cols.map((c) =>
    el('th', { class: c.num ? 'num' : null, style: c.width ? { width: c.width } : null }, c.label)))));

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr', { class: opts.onRow ? 'clickable' : null });
    if (opts.onRow) tr.addEventListener('click', () => opts.onRow(row));
    for (const c of cols) {
      const cls = [c.num ? 'num' : '', c.mono ? 'mono' : ''].filter(Boolean).join(' ');
      const td = el('td', { class: cls || null });
      const v = c.render ? c.render(row) : row[c.key];
      if (v instanceof Node) td.appendChild(v);
      else td.textContent = v === null || v === undefined || v === '' ? '-' : String(v);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  if (opts.footer) t.appendChild(el('tfoot', {}, el('tr', {}, opts.footer.map((cell, i) =>
    el('td', { class: cols[i]?.num ? 'num' : null }, cell)))));
  wrap.appendChild(t);
  return wrap;
}

export const card = (title, body, opts = {}) =>
  el('div', { class: 'card' },
    title ? el('div', { class: 'card-head' },
      el('div', {}, el('h2', {}, title), opts.subtitle ? el('p', {}, opts.subtitle) : null),
      opts.actions ? el('div', { class: 'inline' }, opts.actions) : null) : null,
    el('div', { class: `card-body ${opts.tight ? 'tight' : ''}`.trim() }, body));

export const stat = (label, value, opts = {}) =>
  el('div', { class: `stat ${opts.tone || ''}`.trim() },
    el('div', { class: 'k' }, label),
    el('div', { class: 'v' }, value),
    opts.sub ? el('div', { class: 's' }, opts.sub) : null);

export const loading = (msg = 'Loading...') =>
  el('div', { class: 'loading' }, el('div', { class: 'spinner' }), msg);

export const empty = (title, hint) =>
  el('div', { class: 'empty' }, el('strong', {}, title), hint ? el('div', {}, hint) : null);

/* -------------------------------- Ageing -------------------------------- */
export function ageBar(buckets) {
  const total = buckets.reduce((s, b) => s + b.qty, 0) || 1;
  return el('div', {},
    el('div', { class: 'agebar' }, buckets.map((b, i) =>
      el('span', { class: `age-${i}`, style: { width: `${(b.qty / total) * 100}%` }, title: `${b.bucket}: ${b.qty}` }))),
    el('div', { class: 'age-legend' }, buckets.filter((b) => b.qty > 0).map((b, i) =>
      el('span', {}, el('i', { class: `age-${buckets.indexOf(b)}` }), `${b.bucket}: ${num(b.qty)}`))));
}

/* -------------------------------- Toasts -------------------------------- */
export function toast(title, message, tone = '') {
  const node = el('div', { class: `toast ${tone}`.trim() },
    el('strong', {}, title), message ? el('span', {}, message) : null);
  $('#toasts').appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, tone === 'error' ? 8000 : 4200);
}

export const toastOk = (t, m) => toast(t, m, 'ok');
export const toastErr = (e, fallback = 'Something went wrong') =>
  toast('Cannot continue', e?.message || fallback, 'error');

/* -------------------------------- Modal --------------------------------- */
export function modal({ title, subtitle, body, actions = [], wide = false, onClose }) {
  const root = $('#modal-root');
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const box = el('div', { class: `modal ${wide ? 'wide' : ''}`.trim() },
    el('div', { class: 'modal-head' },
      el('div', {}, el('h2', {}, title), subtitle ? el('p', {}, subtitle) : null),
      el('button', { class: 'x-btn', onClick: close, title: 'Close' }, '×')),
    el('div', { class: 'modal-body' }, body),
    actions.length ? el('div', { class: 'modal-foot' }, actions.map((a) => {
      if (a instanceof Node) return a;
      return el('button', {
        class: `btn ${a.class || ''}`.trim(),
        onClick: async (ev) => {
          // currentTarget is null once the handler awaits, so capture it first.
          const btn = ev.currentTarget;
          btn.disabled = true;
          try { await a.onClick?.(close); } finally { btn.disabled = false; }
        },
      }, a.label);
    })) : null);

  const back = el('div', { class: 'modal-back', onClick: (e) => { if (e.target === back) close(); } }, box);
  root.appendChild(back);
  document.addEventListener('keydown', onKey);
  setTimeout(() => box.querySelector('input, textarea, select, button')?.focus(), 40);
  return { close, box };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', tone = 'btn-primary', requireNote = false, noteLabel = 'Reason' }) {
  return new Promise((resolve) => {
    const note = el('textarea', { placeholder: 'Type the reason...', rows: 3 });
    const m = modal({
      title,
      body: el('div', { class: 'form-grid' },
        el('p', { style: { gridColumn: '1/-1', margin: 0 } }, message),
        requireNote ? el('label', { class: 'field', style: { gridColumn: '1/-1' } },
          el('span', {}, noteLabel), note) : null),
      actions: [
        { label: 'Cancel', onClick: (close) => { close(); resolve(null); } },
        { label: confirmLabel, class: tone, onClick: (close) => {
          if (requireNote && note.value.trim().length < 5) { toast('Reason required', 'Please give at least 5 characters.', 'warn'); return; }
          close(); resolve(requireNote ? note.value.trim() : true);
        } },
      ],
    });
    void m;
  });
}

export function promptDialog({ title, label, placeholder = '', value = '', help, confirmLabel = 'Save' }) {
  return new Promise((resolve) => {
    const input = el('input', { value, placeholder });
    modal({
      title,
      body: el('label', { class: 'field' }, el('span', {}, label),
        input, help ? el('span', { class: 'hint' }, help) : null),
      actions: [
        { label: 'Cancel', onClick: (close) => { close(); resolve(null); } },
        { label: confirmLabel, class: 'btn-primary', onClick: (close) => { close(); resolve(input.value.trim()); } },
      ],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.closest('.modal').querySelector('.modal-foot .btn-primary').click(); });
  });
}

/* ------------------------------- Selects -------------------------------- */
export function select(options, opts = {}) {
  const s = el('select', { name: opts.name });
  if (opts.placeholder) s.appendChild(el('option', { value: '' }, opts.placeholder));
  for (const o of options) {
    const value = o.value ?? o.id ?? o.code ?? o;
    const label = o.label ?? o.name ?? o.code ?? o;
    s.appendChild(el('option', { value, selected: String(value) === String(opts.value ?? '') }, label));
  }
  if (opts.onChange) s.addEventListener('change', () => opts.onChange(s.value));
  return s;
}

export const field = (label, control, hint) =>
  el('label', { class: 'field' }, el('span', {}, label), control, hint ? el('span', { class: 'hint' }, hint) : null);

/* ------------------------------- Scan pad -------------------------------- */
/**
 * The component every station uses to collect a bulk RFID read.
 *
 * Real deployments feed this from a handheld in keyboard-wedge mode or from the
 * reader gateway; the simulate button pulls the tags that are physically in a
 * section so the flow can be exercised without hardware present.
 */
export function scanPad(opts = {}) {
  const ta = el('textarea', {
    placeholder: opts.placeholder || 'Scan tags here - one EPC per line.\nHandheld readers in keyboard-wedge mode type straight into this box.',
    spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off',
  });
  const countN = el('span', { class: 'n' }, '0');
  const countL = el('span', { class: 'l' }, 'tags ready');

  const update = () => {
    const n = parse().length;
    countN.textContent = String(n);
    countL.textContent = n === 1 ? 'tag ready' : 'tags ready';
    opts.onChange?.(n);
  };
  const parse = () => [...new Set(ta.value.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];

  ta.addEventListener('input', update);

  const simBtn = opts.simulate
    ? el('button', { class: 'btn btn-sm', onClick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try {
          const epcs = await opts.simulate();
          if (!epcs || !epcs.length) { toast('Nothing to read', 'No tags are physically in that location.', 'warn'); return; }
          ta.value = epcs.join('\n');
          update();
          toast('Simulated read', `${epcs.length} tag(s) captured.`);
        } catch (err) { toastErr(err); } finally { b.disabled = false; }
      } }, 'Simulate reader')
    : null;

  const pad = el('div', { class: 'scanpad' },
    el('div', { class: 'scan-count' }, countN, countL,
      el('span', { class: 'spacer' }),
      opts.hint ? el('span', { class: 'hint' }, opts.hint) : null),
    ta,
    el('div', { class: 'scan-actions' },
      simBtn,
      el('button', { class: 'btn btn-sm', onClick: () => { ta.value = ''; update(); ta.focus(); } }, 'Clear'),
      ...(opts.extraActions || [])));

  return { node: pad, textarea: ta, get epcs() { return parse(); }, set(list) { ta.value = list.join('\n'); update(); }, update };
}

/** Pull the EPCs currently sitting in a section (simulated portal read). */
export const simSection = (stage, status = 'IN_STAGE', limit = 20000) =>
  api.get(`/api/sim/section/${stage}`, { status, limit }).then((r) => r.epcs);

/** Pull the EPCs still outstanding on a dispatch document, optionally dropping some. */
export const simDoc = (docId, drop = 0) =>
  api.get(`/api/sim/doc/${docId}`, { drop }).then((r) => r.epcs);

/* ------------------------------ Misc bits -------------------------------- */
export const bar = (pct, tone = '') =>
  el('div', { class: `bar ${tone}`.trim(), title: `${Math.round(pct)}%` },
    el('span', { style: { width: `${Math.max(0, Math.min(100, pct))}%` } }));

export function tabs(items, onSelect, activeKey) {
  const row = el('div', { class: 'tabs' });
  items.forEach((it) => {
    const b = el('button', { class: `tab ${it.key === activeKey ? 'active' : ''}`.trim(),
      onClick: () => { $$('.tab', row).forEach((t) => t.classList.remove('active')); b.classList.add('active'); onSelect(it.key); } },
      it.label);
    row.appendChild(b);
  });
  return row;
}

export const kv = (pairs) =>
  el('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [
    el('dt', {}, k),
    el('dd', {}, v instanceof Node ? v : String(v ?? '-')),
  ]));
