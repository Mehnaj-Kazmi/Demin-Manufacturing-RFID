import { api } from '../api.js';
import { el, card, table, chip, num, dateTime, select, field, modal, empty, mount
} from '../ui.js';

/** Who did what, when, and from where. */
export async function render(ctx) {
  ctx.setSubtitle('Every state change in the system is recorded against the user who made it');

  const filters = { user: '', action: '', entity: '', from: '', to: '', limit: 300 };
  const root = el('div');
  const listBox = el('div');

  const userIn = el('input', { placeholder: 'Username' });
  const actionIn = el('input', { placeholder: 'e.g. DISPATCH, QC_FAIL' });
  const entityIn = el('input', { placeholder: 'e.g. articles, movement_docs' });
  const fromIn = el('input', { type: 'date' });
  const toIn = el('input', { type: 'date' });

  let debounce;
  const onChange = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      filters.user = userIn.value.trim();
      filters.action = actionIn.value.trim().toUpperCase();
      filters.entity = entityIn.value.trim();
      filters.from = fromIn.value;
      filters.to = toIn.value;
      load();
    }, 280);
  };
  [userIn, actionIn, entityIn, fromIn, toIn].forEach((i) => i.addEventListener('input', onChange));

  root.appendChild(card('Filter',
    el('div', { class: 'form-grid' },
      field('User', userIn), field('Action', actionIn), field('Record type', entityIn),
      field('From', fromIn), field('To', toIn))));
  root.appendChild(listBox);

  const TONE = { LOGIN_FAILED: 'danger', SCRAP: 'danger', QC_FAIL: 'danger',
    VARIANCE_CLOSE: 'warn', DISPATCH_CANCEL: 'warn', ARTICLE_ADJUST: 'warn', TAG_SWAP: 'warn',
    QC_PASS: 'ok', SHIP: 'ok', RECEIVE: 'ok' };

  async function load() {
    mount(listBox, el('div', { class: 'loading' }, 'Loading audit trail...'));
    const { rows } = await api.get('/api/admin/audit', filters);
    mount(listBox, card(`Audit trail (${num(rows.length)} entries)`,
      table([
        { key: 'ts', label: 'When', render: (r) => dateTime(r.ts) },
        { key: 'username', label: 'User', render: (r) => r.username || el('span', { class: 'hint' }, 'system') },
        { key: 'action', label: 'Action', render: (r) => chip(r.action, TONE[r.action]) },
        { key: 'entity', label: 'Record type' },
        { key: 'entity_id', label: 'Record', mono: true },
        { key: 'ip', label: 'From', mono: true },
        { key: 'detail', label: 'Detail', render: (r) => {
          if (!r.detail) return '-';
          let text = r.detail;
          try {
            const d = JSON.parse(r.detail);
            text = Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== '')
              .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
          } catch { /* keep the raw text */ }
          return text.length > 90
            ? el('span', { title: text }, text.slice(0, 90) + '…')
            : text;
        } },
      ], rows, {
        onRow: (r) => modal({
          title: `${r.action} · ${dateTime(r.ts)}`,
          subtitle: `${r.username || 'system'}${r.ip ? ' from ' + r.ip : ''}`,
          body: el('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', margin: 0 } },
            JSON.stringify({ ...r, detail: safeParse(r.detail) }, null, 2)),
          actions: [{ label: 'Close', onClick: (c) => c() }],
        }),
        empty: 'No audit entries match these filters', maxHeight: '620px',
      }),
      { tight: true, subtitle: 'Click an entry for the full record' }));
  }

  const safeParse = (v) => { try { return JSON.parse(v); } catch { return v; } };

  await load();
  return root;
}
