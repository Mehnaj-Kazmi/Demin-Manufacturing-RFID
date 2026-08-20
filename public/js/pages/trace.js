import { api } from '../api.js';
import {
  el, card, table, chip, num, dateTime, age, select, field, modal, toast, toastOk, toastErr,
  stat, empty, kv, swatch, promptDialog, confirmDialog, mount
} from '../ui.js';
import { state, can, stageName, go } from '../app.js';

/** Full life story of a garment, found by any tag it has ever carried or by serial number. */
export async function render(ctx) {
  ctx.setSubtitle('Look up any garment by tag or serial number and see everywhere it has been');

  const root = el('div');
  const detailBox = el('div');
  const listBox = el('div');

  const search = el('input', {
    placeholder: 'Scan a tag or type a serial number...', class: 'mono',
    style: { fontSize: '16px', padding: '13px' }, autofocus: true, value: ctx.params.q || '',
  });

  const doSearch = async () => {
    const q = search.value.trim();
    if (!q) return;
    mount(detailBox, el('div', { class: 'loading' }, 'Searching...'));
    // A full-length hex string is a tag; anything else is treated as a search term.
    if (/^[0-9A-Fa-f]{8,96}$/.test(q)) {
      try { return showArticle(await api.get(`/api/articles/by-epc/${encodeURIComponent(q)}`).then((r) => r.article.id)); }
      catch { /* fall through to the general search */ }
    }
    const { rows } = await api.get('/api/articles', { q, limit: 100 });
    mount(detailBox);
    mount(listBox, card(`Search results (${rows.length})`,
      table(articleCols(), rows, { onRow: (r) => showArticle(r.id), empty: `Nothing matches "${q}"` }), { tight: true }));
  };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

  root.appendChild(card('Find a garment',
    el('div', {},
      el('p', { class: 'hint mb' },
        'Works with the current tracking tag, the customer tag applied at dispatch, or the serial number. Tags that were removed no longer resolve, because that physical tag may already be on another garment.'),
      el('div', { class: 'inline' }, search,
        el('button', { class: 'btn btn-primary btn-lg', onClick: doSearch }, 'Find')))));
  root.append(detailBox, listBox);

  const articleCols = () => [
    { key: 'serial_no', label: 'Serial No', mono: true },
    { key: 'epc', label: 'Current tag', mono: true },
    { key: 'style_code', label: 'Style' },
    { key: 'color_code', label: 'Colour', render: (r) => el('span', {}, swatch(r.color_hex), ' ', r.color_code) },
    { key: 'size_code', label: 'Size' },
    { key: 'order_no', label: 'Order' },
    { key: 'customer_name', label: 'Customer' },
    { key: 'stage', label: 'Section', render: (r) => chip(stageName(r.stage), 'brand') },
    { key: 'status', label: 'Status', render: (r) => chip(r.status) },
    { key: 'qc_state', label: 'QC', render: (r) => chip(r.qc_state) },
  ];

  /* ---------------------------- Article view ---------------------------- */
  async function showArticle(id) {
    mount(listBox);
    mount(detailBox, el('div', { class: 'loading' }, 'Loading the garment record...'));
    const data = await api.get(`/api/articles/${id}`);
    const a = data.article;

    const EVENT_LABEL = {
      COMMISSION: 'Tag attached and garment registered',
      SORT: 'Sorted at a sorting station',
      DISPATCH: 'Dispatched to the next section',
      RECEIVE: 'Received into the section',
      QC_PASS: 'Passed quality control',
      QC_FAIL: 'Failed quality control',
      REWORK_START: 'Retrofit work started',
      REWORK_DONE: 'Correction completed',
      TAG_SWAP: 'Tracking tag replaced',
      RETIRE: 'Tracking tag removed, customer tag applied',
      SHIP: 'Despatched to the customer',
      ADJUST: 'Manually adjusted by a supervisor',
      SCRAP: 'Written off as scrap',
      VARIANCE_CLOSED: 'Put on hold after a transfer variance',
      DISPATCH_CANCELLED: 'Dispatch cancelled, returned to the section',
    };
    const TONE = { QC_PASS: 'ok', SHIP: 'ok', RECEIVE: 'ok', QC_FAIL: 'danger', SCRAP: 'danger',
      VARIANCE_CLOSED: 'warn', ADJUST: 'warn', TAG_SWAP: 'warn' };

    const timeline = el('div', { class: 'timeline' }, data.history.map((h) => {
      let detail = '';
      if (h.detail) {
        try {
          const d = JSON.parse(h.detail);
          detail = Object.entries(d).filter(([, v]) => v !== null && v !== undefined)
            .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ');
        } catch { detail = h.detail; }
      }
      return el('div', { class: `tl-item ${TONE[h.event_type] || ''}`.trim() },
        el('div', { class: 'tl-head' },
          el('strong', {}, EVENT_LABEL[h.event_type] || h.event_type),
          h.stage_from && h.stage_to && h.stage_from !== h.stage_to
            ? chip(`${stageName(h.stage_from)} → ${stageName(h.stage_to)}`) : null,
          h.doc_no ? chip(h.doc_no, 'info') : null,
          el('span', { class: 'tl-time' }, dateTime(h.ts))),
        el('div', { class: 'tl-body' },
          [h.user_name ? `by ${h.user_name}` : null,
           h.shift_code ? `shift ${h.shift_code}` : null,
           h.reader_code ? `reader ${h.reader_code}` : null,
           detail || null].filter(Boolean).join(' · ')));
    }));

    const qcFile = data.qc;
    const inspections = qcFile.inspections.map((i) => ({
      attempt: i.attempt, result: i.result, when: i.inspected_at, inspector: i.inspector_name,
      defects: i.defects.map((d) => `${d.name}${d.note ? ' (' + d.note + ')' : ''}`).join(', ') || i.remarks || '-',
    }));

    mount(detailBox, 
      card(`${a.serial_no}`,
        el('div', { class: 'grid-2' },
          el('div', {},
            kv([
              ['Current tag', el('span', { class: 'mono' }, a.epc)],
              ['Design', `${a.style_code} · ${a.style_name}`],
              ['Colour', el('span', {}, swatch(a.color_hex), ' ', a.color_name)],
              ['Size', a.size_code],
              ['Fabric', a.fabric_name || '-'],
              ['Order', a.order_no || '-'],
              ['Customer', a.customer_name || '-'],
              ['Cut order', a.cut_no || '-'],
              ['Bundle', a.bundle_no || '-'],
            ])),
          el('div', {},
            kv([
              ['Section', chip(stageName(a.stage), 'brand')],
              ['Status', chip(a.status)],
              ['QC state', chip(a.qc_state)],
              ['Times failed QC', String(a.qc_fail_count)],
              ['In section since', `${dateTime(a.stage_since)} · ${age((Date.now() - new Date(String(a.stage_since).replace(' ', 'T')).getTime()) / 3600000)}`],
              ['Tagged at', `${dateTime(a.created_at)}${a.created_shift ? ' (shift ' + a.created_shift + ')' : ''}`],
              ['Tagged by', a.created_by_name || '-'],
              ['Customer tag', a.final_tag_epc ? el('span', { class: 'mono' }, a.final_tag_epc) : 'not applied'],
              ['Shipped', a.shipped_at ? dateTime(a.shipped_at) : 'not shipped'],
            ]))),
        { subtitle: `${data.history.length} tracking event(s) recorded`,
          actions: el('div', { class: 'inline' },
            can('article.adjust') ? el('button', { class: 'btn btn-sm', onClick: () => swapTag(a) }, 'Replace damaged tag') : null,
            can('article.adjust') ? el('button', { class: 'btn btn-sm btn-warn', onClick: () => adjust(a) }, 'Correct section') : null) }),

      el('div', { class: 'grid-2' },
        card('Life story', timeline, { subtitle: 'Every scan, in order' }),
        el('div', {},
          card('Tags this garment has carried',
            table([
              { key: 'epc', label: 'EPC', mono: true },
              { key: 'kind', label: 'Kind', render: (t) => chip(t.kind) },
              { key: 'bound_at', label: 'Attached', render: (t) => dateTime(t.bound_at) },
              { key: 'unbound_at', label: 'Removed', render: (t) => t.unbound_at ? dateTime(t.unbound_at) : chip('in use', 'ok') },
              { key: 'reason', label: 'Reason' },
            ], data.tags), { tight: true }),

          inspections.length ? card('QC record',
            table([
              { key: 'attempt', label: '#', num: true },
              { key: 'result', label: 'Result', render: (r) => chip(r.result) },
              { key: 'when', label: 'When', render: (r) => dateTime(r.when) },
              { key: 'inspector', label: 'Inspector' },
              { key: 'defects', label: 'Findings' },
            ], inspections), { tight: true }) : null,

          qcFile.rework ? card('Retrofit job',
            kv([
              ['Status', chip(qcFile.rework.status)],
              ['Opened', dateTime(qcFile.rework.opened_at)],
              ['Started by', qcFile.rework.started_by_name || '-'],
              ['Completed', qcFile.rework.done_at ? dateTime(qcFile.rework.done_at) : 'not completed'],
              ['Completed by', qcFile.rework.done_by_name || '-'],
              ['Action taken', qcFile.rework.action_taken || '-'],
            ])) : null)));

    async function swapTag(article) {
      const newEpc = await promptDialog({
        title: 'Replace a damaged tag',
        label: 'New tag EPC',
        help: 'The garment keeps its identity and history. The old tag is released so it can never identify this garment again.',
        confirmLabel: 'Replace tag',
      });
      if (!newEpc) return;
      const reason = await promptDialog({ title: 'Why is the tag being replaced?', label: 'Reason', confirmLabel: 'Confirm' });
      if (!reason) return;
      try {
        const out = await api.post(`/api/articles/${article.id}/tag-swap`, { new_epc: newEpc, reason });
        toastOk('Tag replaced', `${out.old_epc} → ${out.new_epc}`);
        showArticle(article.id);
      } catch (e) { toastErr(e); }
    }

    async function adjust(article) {
      const stageSel = select(state.meta.stages.map((s) => ({ value: s.code, label: s.name })), { value: article.stage });
      const statusSel = select(['IN_STAGE', 'HOLD', 'REWORK', 'READY'].map((s) => ({ value: s, label: s.replace('_', ' ') })));
      const reason = el('textarea', { rows: 2, placeholder: 'Why is this correction needed?' });
      modal({
        title: `Correct the position of ${article.serial_no}`,
        subtitle: 'Use this only to fix a genuine data problem - the change is recorded against you',
        body: el('div', { class: 'form-grid' },
          field('Section', stageSel), field('Status', statusSel), field('Reason', reason)),
        actions: [
          { label: 'Cancel', onClick: (close) => close() },
          { label: 'Apply correction', class: 'btn-warn', onClick: async (close) => {
            if (reason.value.trim().length < 5) { toast('Reason required', 'Explain the correction.', 'warn'); return; }
            try {
              await api.post(`/api/articles/${article.id}/adjust`, {
                stage: stageSel.value, status: statusSel.value, reason: reason.value.trim() });
              close(); toastOk('Correction applied'); showArticle(article.id);
            } catch (e) { toastErr(e); }
          } },
        ],
      });
    }
  }

  /* ------------------------- Recent activity ---------------------------- */
  if (!ctx.params.q) {
    const { rows } = await api.get('/api/articles', { limit: 40 });
    mount(listBox, card('Recently moved garments',
      table(articleCols(), rows, { onRow: (r) => showArticle(r.id), empty: 'No garments registered yet' }),
      { tight: true, subtitle: 'Click any row for the full history' }));
  } else {
    doSearch();
  }

  if (ctx.params.id) showArticle(Number(ctx.params.id));
  return root;
}
