import { api } from '../api.js';
import {
  el, card, table, chip, num, dateTime, select, field, modal, toast, toastOk, toastErr,
  stat, empty, scanPad, simSection, mount
} from '../ui.js';
import { state, can, stageName, go } from '../app.js';

/**
 * Sorting stations. Bulk-read a pile of garments, let the system split it into
 * groups, then send each group onward as its own batch with its own document.
 *
 * Used twice in the process: after stitching (by design/colour/size) and after
 * washing (by customer order/size/type).
 */
export async function render(ctx) {
  ctx.setSubtitle('Bulk-read a pile, group it automatically, then dispatch each group as a batch');

  const root = el('div');
  const box = el('div');
  root.appendChild(box);

  const sortableStages = state.meta.stages.filter((s) => ['SORTING', 'WASHING', 'FINISHING', 'DISPATCH'].includes(s.code));

  if (can('sort.run')) {
    ctx.setTools(el('button', { class: 'btn btn-primary', onClick: newSession }, '+ New sorting session'));
  }

  async function load() {
    mount(box, el('div', { class: 'loading' }, 'Loading sessions...'));
    const { rows } = await api.get('/api/sorting/sessions', { limit: 60 });
    const open = rows.filter((r) => r.status === 'OPEN');

    mount(box, 
      open.length ? card('Open sessions',
        table([
          { key: 'session_no', label: 'Session', mono: true },
          { key: 'stage', label: 'Station', render: (r) => chip(stageName(r.stage), 'brand') },
          { key: 'group_by', label: 'Grouped by', render: (r) => r.group_by.split(',').map((g) => chip(g)).reduce((f, c) => (f.appendChild(c), f), el('span', { class: 'pill-row' })) },
          { key: 'scanned', label: 'Scanned', num: true, render: (r) => num(r.scanned) },
          { key: 'created_at', label: 'Opened', render: (r) => dateTime(r.created_at) },
          { key: 'created_by_name', label: 'Operator' },
        ], open, { onRow: (r) => openSession(r.id) }),
        { tight: true, subtitle: 'Click to continue a session' }) : null,

      card('Recent sessions',
        table([
          { key: 'session_no', label: 'Session', mono: true },
          { key: 'stage', label: 'Station', render: (r) => stageName(r.stage) },
          { key: 'group_by', label: 'Grouped by' },
          { key: 'scanned', label: 'Garments', num: true, render: (r) => num(r.scanned) },
          { key: 'status', label: 'Status', render: (r) => chip(r.status) },
          { key: 'created_at', label: 'Opened', render: (r) => dateTime(r.created_at) },
          { key: 'closed_at', label: 'Closed', render: (r) => dateTime(r.closed_at) },
          { key: 'created_by_name', label: 'Operator' },
        ], rows, { onRow: (r) => openSession(r.id),
          empty: 'No sorting sessions yet',
          emptyHint: can('sort.run') ? 'Start one to sort a pile of garments.' : null }),
        { tight: true }));
  }

  /* ---------------------------- New session ----------------------------- */
  function newSession() {
    const stageSel = select(sortableStages.map((s) => ({ value: s.code, label: s.name })),
      { value: state.user.section && sortableStages.some((s) => s.code === state.user.section) ? state.user.section : 'SORTING' });

    const dims = state.meta.sort_dimensions;
    const chosen = new Set(['style', 'color', 'size']);
    const dimRow = el('div', { class: 'pill-row' }, dims.map((d) => {
      const cb = el('input', { type: 'checkbox', checked: chosen.has(d.key) });
      cb.addEventListener('change', () => { cb.checked ? chosen.add(d.key) : chosen.delete(d.key); });
      return el('label', { class: 'checkbox' }, cb, d.label);
    }));

    const presets = el('div', { class: 'inline mb' },
      el('button', { class: 'btn btn-sm', onClick: () => applyPreset(['style', 'color', 'size']) }, 'Before wash: design / colour / size'),
      el('button', { class: 'btn btn-sm', onClick: () => applyPreset(['order', 'size']) }, 'After wash: order / size'),
      el('button', { class: 'btn btn-sm', onClick: () => applyPreset(['customer', 'style', 'size']) }, 'Customer / style / size'));

    function applyPreset(keys) {
      chosen.clear(); keys.forEach((k) => chosen.add(k));
      [...dimRow.querySelectorAll('input')].forEach((cb, i) => { cb.checked = chosen.has(dims[i].key); });
    }

    modal({
      title: 'New sorting session',
      subtitle: 'Choose the station and how the read should be grouped',
      body: el('div', {},
        field('Station', stageSel),
        el('div', { class: 'sep' }),
        el('div', { class: 'field mb' }, el('span', {}, 'Common groupings')), presets,
        el('div', { class: 'field' }, el('span', {}, 'Group the read by'), dimRow)),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Open session', class: 'btn-primary', onClick: async (close) => {
          if (!chosen.size) { toast('Choose a grouping', 'Select at least one dimension.', 'warn'); return; }
          try {
            const out = await api.post('/api/sorting/sessions', { stage: stageSel.value, group_by: [...chosen] });
            close();
            toastOk(`Session ${out.session.session_no} opened`);
            openSession(out.session.id);
          } catch (e) { toastErr(e); }
        } },
      ],
    });
  }

  /* --------------------------- Session screen --------------------------- */
  async function openSession(id) {
    const data = await api.get(`/api/sorting/sessions/${id}`);
    const s = data.session;
    const isOpen = s.status === 'OPEN';

    const bucketBox = el('div');
    const excBox = el('div');

    const pad = scanPad({
      placeholder: 'Bulk-read the pile here - a tunnel or handheld reader fills this automatically.',
      hint: 'Reading the same tag twice is harmless',
      simulate: () => simSection(s.stage),
    });

    const m = modal({
      title: `${s.session_no} · ${stageName(s.stage)}`, wide: true,
      subtitle: `Grouped by ${s.group_by.split(',').join(' / ')} · opened ${dateTime(s.created_at)} by ${s.created_by_name || '-'}`,
      body: el('div', {},
        isOpen ? card('Read the pile',
          el('div', {}, pad.node,
            el('div', { class: 'inline mt' },
              el('button', { class: 'btn btn-primary', onClick: async (e) => {
                const epcs = pad.epcs;
                if (!epcs.length) { toast('Nothing scanned', 'Read some tags first.', 'warn'); return; }
                const clicked = e.currentTarget; clicked.disabled = true;
                try {
                  const out = await api.post(`/api/sorting/sessions/${id}/read`, { epcs });
                  pad.set([]);
                  toastOk(`${out.added} tag(s) added`,
                    [out.duplicates ? `${out.duplicates} already read` : null,
                     out.wrong_stage ? `${out.wrong_stage} in the wrong section` : null,
                     out.unknown ? `${out.unknown} unrecognised` : null].filter(Boolean).join(' · ') || 'All accepted.');
                  await refresh();
                } catch (err) { toastErr(err); } finally { clicked.disabled = false; }
              } }, 'Add to session')))) : null,
        bucketBox, excBox),
      actions: [
        isOpen ? { label: 'Close session', onClick: async (close) => {
          try { await api.post(`/api/sorting/sessions/${id}/close`); close(); toastOk('Session closed'); load(); }
          catch (e) { toastErr(e); }
        } } : null,
        { label: 'Done', class: 'btn-primary', onClick: (close) => { close(); load(); } },
      ].filter(Boolean),
    });

    async function refresh() {
      const d = await api.get(`/api/sorting/sessions/${id}`);
      const total = d.buckets.reduce((x, b) => x + b.qty, 0);
      const routes = state.meta.stages.find((x) => x.code === s.stage)?.routes || [];

      mount(bucketBox, card(`Groups (${d.buckets.length})`,
        el('div', {},
          el('div', { class: 'stats' },
            stat('Garments read', num(total), { tone: 'brand' }),
            stat('Groups formed', num(d.buckets.length)),
            stat('Exceptions', num(d.exceptions.length), { tone: d.exceptions.length ? 'warn' : 'ok' })),
          table([
            { key: 'bucket_key', label: 'Group', render: (b) => el('strong', {}, b.bucket_key) },
            { key: 'style_name', label: 'Design' },
            { key: 'color_name', label: 'Colour' },
            { key: 'size_name', label: 'Size' },
            { key: 'order_no', label: 'Order' },
            { key: 'customer_name', label: 'Customer' },
            { key: 'qty', label: 'Garments', num: true, render: (b) => el('strong', {}, num(b.qty)) },
            { key: 'dispatchable', label: 'Ready to send', num: true,
              render: (b) => b.dispatchable === b.qty ? chip(String(b.dispatchable), 'ok')
                : chip(`${b.dispatchable} of ${b.qty}`, 'warn') },
            { key: 'act', label: '', render: (b) => (isOpen && can('movement.dispatch') && b.dispatchable > 0 && routes.length)
              ? el('div', { class: 'inline' }, routes.map((r) =>
                  el('button', { class: 'btn btn-sm btn-primary',
                    onClick: () => dispatchBucket(id, b, r.to, s.stage) }, `Send to ${stageName(r.to)}`)))
              : null },
          ], d.buckets, { empty: 'Nothing read yet', emptyHint: 'Scan the pile to form groups.' })),
        { tight: true, subtitle: 'Each group becomes its own batch with its own transfer document' }));

      mount(excBox, d.exceptions.length
        ? card(`Exceptions (${d.exceptions.length})`,
            table([
              { key: 'epc', label: 'Tag', mono: true },
              { key: 'serial_no', label: 'Serial No', mono: true },
              { key: 'state', label: 'Problem', render: (x) => chip(x.state === 'UNKNOWN' ? 'Tag not registered'
                : x.state === 'WRONG_STAGE' ? 'Not in this section' : x.state, 'danger') },
              { key: 'stage', label: 'Actually in', render: (x) => x.stage ? stageName(x.stage) : '-' },
              { key: 'status', label: 'Status', render: (x) => x.status ? chip(x.status) : '-' },
            ], d.exceptions),
            { tight: true, subtitle: 'These tags were read but cannot be sorted here - set them aside' })
        : el('div'));
    }

    await refresh();

    async function dispatchBucket(sessionId, bucket, to, from) {
      const batchRef = el('input', { placeholder: 'e.g. WASH-LOT-07', value: '' });
      const recipe = el('input', { placeholder: 'Wash / treatment recipe' });
      const remarks = el('input', { placeholder: 'Anything the receiving section should know' });

      modal({
        title: `Send ${bucket.qty} garment(s) to ${stageName(to)}`,
        subtitle: `Group: ${bucket.bucket_key}`,
        body: el('div', { class: 'form-grid' },
          field('Batch reference', batchRef, 'Printed on the transfer note'),
          to === 'WASHING' ? field('Wash recipe', recipe) : null,
          field('Remarks', remarks)),
        actions: [
          { label: 'Cancel', onClick: (close) => close() },
          { label: 'Generate transfer note', class: 'btn-primary', onClick: async (close) => {
            try {
              const out = await api.post(`/api/sorting/sessions/${sessionId}/dispatch`, {
                bucket_key: bucket.bucket_key, to,
                batch_ref: batchRef.value.trim() || null,
                wash_recipe: recipe.value.trim() || null,
                remarks: remarks.value.trim() || null,
                require_qc_pass: from === 'QC' && to === 'DISPATCH',
              });
              close();
              toastOk(`${out.doc.doc_no} dispatched`, `${out.accepted} garment(s) sent to ${stageName(to)}.`);
              api.openPrint(`/api/movements/${out.doc.id}/print`);
              await refresh();
            } catch (e) { toastErr(e); }
          } },
        ],
      });
    }
  }

  await load();
  if (ctx.params.session) openSession(Number(ctx.params.session));
  return root;
}
