import { api } from '../api.js';
import { el, card, table, chip, num, age, dateTime, select, field, empty, stat, toastErr, swatch, mount
} from '../ui.js';
import { state, stageName, go, masters } from '../app.js';

/**
 * Section WIP explorer - "what is in my section, when did it arrive, and how do
 * I want it broken down?" Any combination of dimensions can be applied, including
 * the bulk receipt each garment arrived on.
 */
export async function render(ctx) {
  const dims = state.meta.group_dimensions;
  const stages = state.meta.stages.filter((s) => s.code !== 'SHIPPED');

  const sel = {
    stage: ctx.params.stage || state.user.section || '',
    group: (ctx.params.group || 'style,color,size').split(','),
    sort: ctx.params.sort || 'qty_desc',
    filters: {},
  };

  const [customers, orders] = await Promise.all([
    masters('customers'),
    api.get('/api/orders', { limit: 200 }).then((r) => r.rows).catch(() => []),
  ]);

  const root = el('div');
  const summaryBox = el('div');
  const resultBox = el('div');
  const receiptsBox = el('div');

  ctx.setSubtitle('Break down in-process inventory by any combination of dimensions');

  /* ------------------------------ Controls ---------------------------- */
  const stageSel = select(
    [{ value: '', label: 'All sections' }, ...stages.map((s) => ({ value: s.code, label: s.name }))],
    { value: sel.stage, onChange: (v) => { sel.stage = v; refresh(); } });

  const dimBoxes = el('div', { class: 'pill-row' }, dims.map((d) => {
    const cb = el('input', { type: 'checkbox', checked: sel.group.includes(d.key) });
    cb.addEventListener('change', () => {
      sel.group = dims.filter((x) => x.key === d.key ? cb.checked : sel.group.includes(x.key)).map((x) => x.key);
      if (!sel.group.length) { cb.checked = true; sel.group = [d.key]; return; }
      refresh();
    });
    return el('label', { class: 'checkbox' }, cb, d.label);
  }));

  const sortSel = select([
    { value: 'qty_desc', label: 'Largest group first' },
    { value: 'qty_asc', label: 'Smallest group first' },
    { value: 'oldest', label: 'Oldest arrival first' },
    { value: 'newest', label: 'Newest arrival first' },
    { value: 'age_desc', label: 'Longest waiting first' },
    { value: 'label', label: 'Alphabetical' },
  ], { value: sel.sort, onChange: (v) => { sel.sort = v; refresh(); } });

  const custSel = select([{ value: '', label: 'Any customer' },
    ...customers.map((c) => ({ value: c.id, label: c.name }))],
    { onChange: (v) => { sel.filters.customer_id = v ? Number(v) : undefined; refresh(); } });

  const orderSel = select([{ value: '', label: 'Any order' },
    ...orders.map((o) => ({ value: o.id, label: `${o.order_no} · ${o.customer_name}` }))],
    { onChange: (v) => { sel.filters.order_id = v ? Number(v) : undefined; refresh(); } });

  const ageInput = el('input', { type: 'number', min: '0', placeholder: 'e.g. 24' });
  ageInput.addEventListener('change', () => {
    sel.filters.min_age_hours = ageInput.value ? Number(ageInput.value) : undefined;
    refresh();
  });

  const fromInput = el('input', { type: 'date' });
  const toInput = el('input', { type: 'date' });
  for (const i of [fromInput, toInput]) {
    i.addEventListener('change', () => {
      sel.filters.received_from = fromInput.value || undefined;
      sel.filters.received_to = toInput.value || undefined;
      refresh();
    });
  }

  root.appendChild(card('View',
    el('div', {},
      el('div', { class: 'form-grid' },
        field('Section', stageSel),
        field('Sort by', sortSel),
        field('Customer', custSel),
        field('Order', orderSel),
        field('Arrived on or after', fromInput),
        field('Arrived on or before', toInput),
        field('Waiting at least (hours)', ageInput, 'Find work that has stalled')),
      el('div', { class: 'sep' }),
      el('div', { class: 'field' },
        el('span', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--text-2)' } }, 'Group by'),
        dimBoxes))));

  root.appendChild(summaryBox);
  root.appendChild(resultBox);
  root.appendChild(receiptsBox);

  async function refresh() {
    mount(resultBox, card('Breakdown', el('div', { class: 'loading' }, 'Calculating...'), { tight: true }));
    try {
      const body = { stage: sel.stage || null, group_by: sel.group, sort: sel.sort, filters: sel.filters, limit: 1000 };
      const data = await api.post('/api/kpi/wip', body);

      mount(summaryBox, el('div', { class: 'stats' },
        stat(sel.stage ? stageName(sel.stage) : 'All sections', num(data.totals.qty), { tone: 'brand', sub: 'garments in process' }),
        stat('Groups', num(data.rows.length)),
        stat('Average wait', age(data.totals.avg_age_hours)),
        stat('Longest wait', age(data.totals.max_age_hours), { tone: data.totals.max_age_hours > 24 ? 'warn' : '' })));

      const cols = sel.group.map((d, i) => ({
        key: `g${i}`, label: data.labels[i],
        render: (r) => {
          const v = r[`g${i}`];
          if (d === 'color' && r.color_hex) return el('span', {}, swatch(r.color_hex), ' ', v);
          if (d === 'stage') return chip(stageName(v), 'brand');
          if (d === 'status' || d === 'qc_state') return chip(v);
          if (d === 'age') return chip(v, v === '3d+' ? 'danger' : v === '1-3d' ? 'warn' : 'ok');
          return v;
        },
      }));
      cols.push(
        { key: 'qty', label: 'Garments', num: true, render: (r) => el('strong', {}, num(r.qty)) },
        { key: 'in_transit', label: 'In transit', num: true, render: (r) => r.in_transit ? chip(String(r.in_transit), 'info') : '-' },
        { key: 'on_hold', label: 'On hold', num: true, render: (r) => r.on_hold ? chip(String(r.on_hold), 'warn') : '-' },
        { key: 'oldest_since', label: 'Oldest arrived', render: (r) => dateTime(r.oldest_since) },
        { key: 'max_age_hours', label: 'Waiting', num: true,
          render: (r) => chip(age(r.max_age_hours), r.max_age_hours > 72 ? 'danger' : r.max_age_hours > 24 ? 'warn' : 'ok') },
      );

      mount(resultBox, card(`Breakdown by ${data.labels.join(' / ')}`,
        table(cols, data.rows, {
          empty: 'No work in process matches this view',
          emptyHint: 'Try widening the filters or choosing a different section.',
          footer: [...sel.group.map((_, i) => i === 0 ? 'Total' : ''), num(data.totals.qty), '', '', '', ''],
          maxHeight: '520px',
        }),
        { tight: true, subtitle: `${num(data.rows.length)} group(s)`,
          actions: el('button', { class: 'btn btn-sm', onClick: () => exportView(data) }, 'Export CSV') }));
    } catch (e) {
      toastErr(e);
      mount(resultBox, card('Breakdown', empty('Could not load this view', e.message), { tight: true }));
    }

    // What came into this section, and when
    if (sel.stage) {
      try {
        const r = await api.get(`/api/kpi/receipts/${sel.stage}`, { limit: 60 });
        mount(receiptsBox, card('Bulk receipts into this section',
          table([
            { key: 'doc_no', label: 'Document', mono: true },
            { key: 'from_stage', label: 'From', render: (x) => stageName(x.from_stage) },
            { key: 'batch_ref', label: 'Batch' },
            { key: 'expected_count', label: 'Sent', num: true },
            { key: 'received_count', label: 'Received', num: true },
            { key: 'missing_count', label: 'Missing', num: true, render: (x) => x.missing_count ? chip(String(x.missing_count), 'danger') : '0' },
            { key: 'still_here', label: 'Still here', num: true, render: (x) => num(x.still_here) },
            { key: 'received_at', label: 'Received at', render: (x) => dateTime(x.received_at) },
            { key: 'hours_since_receipt', label: 'Held for', num: true, render: (x) => age(x.hours_since_receipt) },
            { key: 'received_by', label: 'Received by' },
          ], r.rows, {
            onRow: (x) => go('transfers', { doc: x.id }),
            empty: 'No bulk receipts recorded for this section yet',
            maxHeight: '420px',
          }),
          { tight: true, subtitle: 'Click a row to open the transfer document' }));
      } catch { mount(receiptsBox); }
    } else {
      mount(receiptsBox);
    }
  }

  function exportView(data) {
    const cols = [
      ...sel.group.map((d, i) => ({ key: `g${i}`, label: data.labels[i] })),
      { key: 'qty', label: 'Garments' }, { key: 'in_transit', label: 'In transit' },
      { key: 'on_hold', label: 'On hold' }, { key: 'oldest_since', label: 'Oldest arrived' },
      { key: 'max_age_hours', label: 'Longest wait (h)' }, { key: 'avg_age_hours', label: 'Average wait (h)' },
    ];
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.map((c) => esc(c.label)).join(','),
      ...data.rows.map((r) => cols.map((c) => esc(r[c.key])).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    const a = el('a', { href: url, download: `wip_${sel.stage || 'all'}_${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  await refresh();
  return root;
}
