import { api } from '../api.js';
import {
  el, card, table, chip, num, dateTime, age, select, field, modal, toast, toastOk, toastErr,
  stat, empty, scanPad, simSection, simDoc, tabs, confirmDialog, kv, mount
} from '../ui.js';
import { state, can, stageName, go } from '../app.js';

/**
 * Section-to-section transfers.
 *
 * Outbound: bulk-read what is leaving -> a transfer note is generated.
 * Inbound : bulk-read what arrived    -> tallied against the note, variance recorded.
 */
export async function render(ctx) {
  const stages = state.meta.stages.filter((s) => s.tracks === 'ARTICLE' && s.code !== 'SHIPPED');
  let stage = ctx.params.stage || state.user.section ||
    (stages.some((s) => s.code === 'SORTING') ? 'SORTING' : stages[0].code);
  if (!stages.some((s) => s.code === stage)) stage = stages[0].code;

  const root = el('div');
  const inboxBox = el('div');
  const outboxBox = el('div');
  const historyBox = el('div');

  const stageSel = select(stages.map((s) => ({ value: s.code, label: s.name })),
    { value: stage, onChange: (v) => { stage = v; refresh(); } });

  ctx.setSubtitle('Dispatch documents and bulk receiving with automatic tally');
  ctx.setTools(
    el('label', { class: 'inline', style: { gap: '7px' } },
      el('span', { class: 'hint' }, 'Section'), stageSel),
    can('movement.dispatch') ? el('button', { class: 'btn btn-primary', onClick: () => dispatchDialog(stage) }, '+ Dispatch a batch') : null);

  root.appendChild(inboxBox);
  root.appendChild(outboxBox);
  root.appendChild(historyBox);

  async function refresh() {
    mount(inboxBox, el('div', { class: 'loading' }, 'Loading...'));
    mount(outboxBox);
    mount(historyBox);

    const [pending, sentOut, hist] = await Promise.all([
      api.get(`/api/movements/pending/${stage}`),
      api.get('/api/movements', { stage, direction: 'out', status: 'DISPATCHED', limit: 50 }),
      api.get('/api/movements', { stage, limit: 60 }),
    ]);

    mount(inboxBox, card(`Waiting to be received into ${stageName(stage)}`,
      table([
        { key: 'doc_no', label: 'Document', mono: true },
        { key: 'from_stage', label: 'From', render: (r) => chip(stageName(r.from_stage), 'brand') },
        { key: 'batch_ref', label: 'Batch' },
        { key: 'expected_count', label: 'Expected', num: true, render: (r) => el('strong', {}, num(r.expected_count)) },
        { key: 'received_count', label: 'Received so far', num: true, render: (r) => num(r.received_count) },
        { key: 'status', label: 'Status', render: (r) => chip(r.status) },
        { key: 'created_at', label: 'Dispatched', render: (r) => dateTime(r.created_at) },
        { key: 'waiting', label: 'Waiting', num: true, render: (r) => {
          const h = (Date.now() - new Date(String(r.created_at).replace(' ', 'T')).getTime()) / 3600000;
          return chip(age(h), h > 8 ? 'danger' : h > 4 ? 'warn' : ''); } },
        { key: 'created_by_name', label: 'Sent by' },
        { key: 'act', label: '', render: (r) => can('movement.receive')
          ? el('button', { class: 'btn btn-sm btn-primary', onClick: (e) => { e.stopPropagation(); receiveDialog(r); } }, 'Receive')
          : null },
      ], pending.rows, {
        onRow: (r) => docDetail(r.id),
        empty: 'Nothing inbound',
        emptyHint: `No other section has dispatched anything to ${stageName(stage)}.`,
      }),
      { tight: true, subtitle: 'Bulk-read the arriving batch; the system tallies it against the document' }));

    mount(outboxBox, sentOut.rows.length ? card(`Dispatched from ${stageName(stage)}, not yet received`,
      table([
        { key: 'doc_no', label: 'Document', mono: true },
        { key: 'to_stage', label: 'To', render: (r) => chip(stageName(r.to_stage), 'info') },
        { key: 'batch_ref', label: 'Batch' },
        { key: 'expected_count', label: 'Units', num: true, render: (r) => num(r.expected_count) },
        { key: 'created_at', label: 'Sent', render: (r) => dateTime(r.created_at) },
        { key: 'act', label: '', render: (r) => el('div', { class: 'inline' },
          el('button', { class: 'btn btn-sm', onClick: (e) => { e.stopPropagation(); api.openPrint(`/api/movements/${r.id}/print`); } }, 'Print'),
          can('movement.close_variance')
            ? el('button', { class: 'btn btn-sm', onClick: async (e) => {
                e.stopPropagation();
                const reason = await confirmDialog({ title: `Cancel ${r.doc_no}?`,
                  message: 'The garments return to this section. Only possible while nothing has been received.',
                  confirmLabel: 'Cancel dispatch', tone: 'btn-danger', requireNote: true, noteLabel: 'Reason' });
                if (!reason) return;
                try { const out = await api.post(`/api/movements/${r.id}/cancel`, { reason });
                  toastOk('Dispatch cancelled', `${out.returned} garment(s) returned to ${stageName(stage)}.`); refresh(); }
                catch (err) { toastErr(err); }
              } }, 'Cancel')
            : null) },
      ], sentOut.rows, { onRow: (r) => docDetail(r.id) }), { tight: true }) : el('div'));

    mount(historyBox, card('Transfer history for this section',
      table([
        { key: 'doc_no', label: 'Document', mono: true },
        { key: 'route', label: 'Route', render: (r) => el('span', {},
          r.from_stage === stage ? chip('OUT', 'info') : chip('IN', 'ok'), ' ',
          `${stageName(r.from_stage)} → ${stageName(r.to_stage)}`) },
        { key: 'batch_ref', label: 'Batch' },
        { key: 'expected_count', label: 'Sent', num: true },
        { key: 'received_count', label: 'Received', num: true },
        { key: 'missing_count', label: 'Missing', num: true,
          render: (r) => r.missing_count ? chip(String(r.missing_count), 'danger') : '0' },
        { key: 'extra_count', label: 'Extra', num: true,
          render: (r) => r.extra_count ? chip(String(r.extra_count), 'warn') : '0' },
        { key: 'status', label: 'Status', render: (r) => chip(r.status) },
        { key: 'created_at', label: 'Dispatched', render: (r) => dateTime(r.created_at) },
        { key: 'received_at', label: 'Received', render: (r) => dateTime(r.received_at) },
      ], hist.rows, { onRow: (r) => docDetail(r.id), empty: 'No transfers recorded for this section yet', maxHeight: '480px' }),
      { tight: true, subtitle: `${num(hist.total)} document(s) in total` }));
  }

  /* --------------------------- Dispatch flow ---------------------------- */
  async function dispatchDialog(from) {
    const routes = state.meta.stages.find((s) => s.code === from)?.routes || [];
    if (!routes.length) { toast('No onward route', `${stageName(from)} does not dispatch to another section.`, 'warn'); return; }

    let to = routes[0].to;
    const toSel = select(routes.map((r) => ({ value: r.to, label: stageName(r.to) })), { value: to, onChange: (v) => { to = v; } });
    const batchRef = el('input', { placeholder: 'e.g. WASH-LOT-07' });
    const recipe = el('input', { placeholder: 'Wash / treatment recipe' });
    const remarks = el('input', { placeholder: 'Notes for the receiving section' });
    const preview = el('div');

    const pad = scanPad({
      placeholder: 'Bulk-read everything leaving this section.',
      simulate: () => simSection(from),
      onChange: () => mount(preview),
    });

    modal({
      title: `Dispatch from ${stageName(from)}`, wide: true,
      subtitle: 'Creates the transfer note the receiving section will tally against',
      body: el('div', {},
        el('div', { class: 'form-grid mb' },
          field('Send to', toSel), field('Batch reference', batchRef),
          field('Wash recipe', recipe, 'Only relevant for wash batches'), field('Remarks', remarks)),
        pad.node,
        el('div', { class: 'inline mt' },
          el('button', { class: 'btn', onClick: async (e) => {
            const epcs = pad.epcs;
            if (!epcs.length) { toast('Nothing scanned', 'Read the tags first.', 'warn'); return; }
            const clicked = e.currentTarget; clicked.disabled = true;
            try {
              const out = await api.post('/api/articles/resolve', { epcs });
              mount(preview, card(`What was read (${out.count} recognised, ${out.unknown.length} unknown)`,
                table([
                  { key: 'style_code', label: 'Style' }, { key: 'color_code', label: 'Colour' },
                  { key: 'size_code', label: 'Size' }, { key: 'order_no', label: 'Order' },
                  { key: 'customer_name', label: 'Customer' },
                  { key: 'qty', label: 'Garments', num: true, render: (r) => num(r.qty) },
                ], out.summary), { tight: true }));
            } catch (err) { toastErr(err); } finally { clicked.disabled = false; }
          } }, 'Check what was read')),
        preview),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Generate transfer note', class: 'btn-primary', onClick: async (close) => {
          const epcs = pad.epcs;
          if (!epcs.length) { toast('Nothing scanned', 'Read the tags first.', 'warn'); return; }
          try {
            const out = await api.post('/api/movements/dispatch', {
              from, to, epcs,
              batch_ref: batchRef.value.trim() || null,
              wash_recipe: recipe.value.trim() || null,
              remarks: remarks.value.trim() || null,
              require_qc_pass: from === 'QC' && to === 'DISPATCH',
            });
            close();
            toastOk(`${out.doc.doc_no} created`, `${out.accepted} garment(s) dispatched to ${stageName(to)}.`);
            if (out.rejected.length) showRejected(out.rejected);
            api.openPrint(`/api/movements/${out.doc.id}/print`);
            refresh();
          } catch (e) {
            toastErr(e);
            if (e.detail?.rejected) showRejected(e.detail.rejected);
          }
        } },
      ],
    });
  }

  function showRejected(rejected) {
    modal({
      title: `${rejected.length} tag(s) were not accepted`,
      subtitle: 'These were read but could not be dispatched - set them aside and resolve them',
      body: table([
        { key: 'epc', label: 'Tag', mono: true },
        { key: 'serial_no', label: 'Serial No', mono: true },
        { key: 'reason', label: 'Reason', render: (r) => chip(r.reason.replace(/_/g, ' '), 'danger') },
        { key: 'message', label: 'Detail' },
      ], rejected, { maxHeight: '420px' }),
      actions: [{ label: 'Understood', class: 'btn-primary', onClick: (close) => close() }],
    });
  }

  /* --------------------------- Receiving flow --------------------------- */
  function receiveDialog(doc) {
    const resultBox = el('div');
    const acceptExtras = el('input', { type: 'checkbox' });

    const pad = scanPad({
      placeholder: 'Bulk-read the arriving batch - a portal or tunnel reader fills this automatically.',
      hint: `${doc.expected_count} garment(s) expected on ${doc.doc_no}`,
      simulate: () => simDoc(doc.id),
      extraActions: [
        el('button', { class: 'btn btn-sm', title: 'Simulate a short delivery to see the variance handling',
          onClick: async (e) => {
            const clicked = e.currentTarget; clicked.disabled = true;
            try { pad.set(await simDoc(doc.id, 2)); toast('Simulated short read', '2 tags deliberately missed.', 'warn'); }
            catch (err) { toastErr(err); } finally { clicked.disabled = false; }
          } }, 'Simulate short read'),
      ],
    });

    modal({
      title: `Receive ${doc.doc_no}`, wide: true,
      subtitle: `From ${stageName(doc.from_stage)} · ${doc.expected_count} expected · batch ${doc.batch_ref || '-'}`,
      body: el('div', {},
        pad.node,
        el('label', { class: 'checkbox mt' }, acceptExtras,
          'Accept extra garments that are not on the document (they must still be in the sending section)'),
        el('div', { class: 'inline mt' },
          el('button', { class: 'btn btn-primary btn-lg', onClick: async (e) => {
            const epcs = pad.epcs;
            if (!epcs.length) { toast('Nothing scanned', 'Read the arriving batch first.', 'warn'); return; }
            const clicked = e.currentTarget; clicked.disabled = true;
            try {
              const out = await api.post(`/api/movements/${doc.id}/receive`, { epcs, accept_extras: acceptExtras.checked });
              showTally(out, resultBox, doc);
              if (out.tally.matched) toastOk('Count matched', `${out.tally.received} of ${doc.expected_count} received.`);
              else toast('Count does not match', `${out.tally.missing} missing, ${out.tally.extra} extra.`, 'warn');
              refresh();
            } catch (err) { toastErr(err); } finally { clicked.disabled = false; }
          } }, 'Receive and tally')),
        resultBox),
      actions: [{ label: 'Done', class: 'btn-primary', onClick: (close) => { close(); refresh(); } }],
    });
  }

  function showTally(out, box, doc) {
    const t = out.tally;
    mount(box, 
      el('div', { class: 'stats mt' },
        stat('Expected', num(t.expected)),
        stat('Received', num(t.received), { tone: t.matched ? 'ok' : '' }),
        stat('Missing', num(t.missing), { tone: t.missing ? 'danger' : 'ok' }),
        stat('Extra', num(t.extra), { tone: t.extra ? 'warn' : 'ok' }),
        stat('Result', t.matched ? 'MATCHED' : 'VARIANCE', { tone: t.matched ? 'ok' : 'warn' })),

      out.summary.length ? card('Received breakdown',
        table([
          { key: 'style_code', label: 'Style' }, { key: 'color_code', label: 'Colour' },
          { key: 'size_code', label: 'Size' }, { key: 'order_no', label: 'Order' },
          { key: 'customer_name', label: 'Customer' },
          { key: 'qty', label: 'Garments', num: true, render: (r) => num(r.qty) },
        ], out.summary), { tight: true }) : null,

      out.missing_articles.length ? card(`Not received (${out.missing_articles.length})`,
        el('div', {},
          el('p', { class: 'hint', style: { padding: '0 17px' } },
            'Scan again to pick up stragglers. If they truly cannot be found, a supervisor can close the variance.'),
          table([
            { key: 'serial_no', label: 'Serial No', mono: true },
            { key: 'epc', label: 'Tag', mono: true },
            { key: 'style_code', label: 'Style' }, { key: 'color_code', label: 'Colour' }, { key: 'size_code', label: 'Size' },
          ], out.missing_articles, { maxHeight: '260px' })),
        { tight: true,
          actions: can('movement.close_variance')
            ? el('button', { class: 'btn btn-sm btn-warn', onClick: () => closeVariance(doc.id) }, 'Close variance')
            : null }) : null,

      out.exceptions.length ? card(`Unexpected reads (${out.exceptions.length})`,
        table([
          { key: 'epc', label: 'Tag', mono: true },
          { key: 'serial_no', label: 'Serial No', mono: true },
          { key: 'message', label: 'Problem' },
        ], out.exceptions), { tight: true }) : null);
  }

  async function closeVariance(docId) {
    const note = await confirmDialog({
      title: 'Close the variance',
      message: 'The garments that were never received will be put on hold in the sending section so they stop counting as in transit. This is recorded against your user.',
      confirmLabel: 'Close variance', tone: 'btn-warn', requireNote: true, noteLabel: 'Explain what happened',
    });
    if (!note) return;
    try {
      const out = await api.post(`/api/movements/${docId}/close-variance`, { note, disposition: 'HOLD' });
      toastOk('Variance closed', `${out.affected} garment(s) put on hold.`);
      refresh();
    } catch (e) { toastErr(e); }
  }

  /* ---------------------------- Document view --------------------------- */
  async function docDetail(id) {
    const d = await api.get(`/api/movements/${id}`);
    const doc = d.doc;

    modal({
      title: doc.doc_no, wide: true,
      subtitle: `${stageName(doc.from_stage)} → ${stageName(doc.to_stage)} · ${doc.status}`,
      body: el('div', {},
        el('div', { class: 'stats' },
          stat('Expected', num(doc.expected_count)),
          stat('Received', num(doc.received_count), { tone: doc.status === 'RECEIVED' ? 'ok' : '' }),
          stat('Missing', num(doc.missing_count), { tone: doc.missing_count ? 'danger' : 'ok' }),
          stat('Extra', num(doc.extra_count), { tone: doc.extra_count ? 'warn' : 'ok' }),
          stat('Status', chip(doc.status))),

        card('Document', kv([
          ['Dispatched at', dateTime(doc.created_at)],
          ['Dispatched by', doc.created_by_name || '-'],
          ['Received at', dateTime(doc.received_at)],
          ['Received by', doc.received_by_name || '-'],
          ['Batch reference', doc.batch_ref || '-'],
          ['Sorted by', doc.group_key || '-'],
          ['Wash recipe', doc.wash_recipe || '-'],
          ['Remarks', doc.remarks || '-'],
          ...(doc.variance_note ? [['Variance note', doc.variance_note]] : []),
          ...(doc.closed_by_name ? [['Closed by', `${doc.closed_by_name} · ${dateTime(doc.closed_at)}`]] : []),
        ])),

        card('Contents',
          table([
            { key: 'style_code', label: 'Style' }, { key: 'style_name', label: 'Design' },
            { key: 'color_code', label: 'Colour' }, { key: 'size_code', label: 'Size' },
            { key: 'order_no', label: 'Order' }, { key: 'customer_name', label: 'Customer' },
            { key: 'qty', label: 'Sent', num: true, render: (r) => num(r.qty) },
            { key: 'received_qty', label: 'Received', num: true,
              render: (r) => r.received_qty === r.qty ? chip(String(r.received_qty), 'ok') : chip(`${r.received_qty} of ${r.qty}`, 'warn') },
          ], d.breakdown), { tight: true }),

        d.missing.length ? card(`Not received (${d.missing.length})`,
          table([
            { key: 'serial_no', label: 'Serial No', mono: true },
            { key: 'epc', label: 'Tag', mono: true },
            { key: 'style_code', label: 'Style' }, { key: 'color_code', label: 'Colour' }, { key: 'size_code', label: 'Size' },
          ], d.missing, { maxHeight: '260px' }), { tight: true }) : null),
      actions: [
        { label: 'Print', onClick: () => api.openPrint(`/api/movements/${id}/print`) },
        { label: 'Export CSV', onClick: () => window.open(`/api/movements/${id}/export`, '_blank') },
        doc.status === 'VARIANCE' && can('movement.close_variance')
          ? { label: 'Close variance', class: 'btn-warn', onClick: (close) => { close(); closeVariance(id); } } : null,
        doc.status === 'DISPATCHED' && can('movement.receive')
          ? { label: 'Receive', class: 'btn-primary', onClick: (close) => { close(); receiveDialog(doc); } } : null,
        { label: 'Close', onClick: (close) => close() },
      ].filter(Boolean),
    });
  }

  await refresh();
  if (ctx.params.doc) docDetail(Number(ctx.params.doc));
  return root;
}
