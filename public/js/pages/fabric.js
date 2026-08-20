import { api } from '../api.js';
import {
  el, card, table, chip, num, dateTime, select, field, modal, toast, toastOk, toastErr,
  stat, empty, swatch, tabs, $, mount
} from '../ui.js';
import { can, masters } from '../app.js';

/** Fabric warehouse: goods receipt, roll stock and consumption. */
export async function render(ctx) {
  ctx.setSubtitle('Denim roll receiving, stock and issue history');

  const [fabricTypes, colors] = await Promise.all([masters('fabric_types'), masters('colors')]);
  const root = el('div');
  const body = el('div');

  const views = [
    { key: 'stock', label: 'Stock summary' },
    { key: 'rolls', label: 'Roll register' },
    { key: 'grn', label: 'Goods receipts' },
  ];
  root.appendChild(tabs(views, (k) => show(k), 'stock'));
  root.appendChild(body);

  if (can('fabric.receive')) {
    ctx.setTools(el('button', { class: 'btn btn-primary', onClick: () => receiveDialog() }, '+ Receive rolls'));
  }

  async function show(view) {
    mount(body, el('div', { class: 'loading' }, 'Loading...'));
    if (view === 'stock') return showStock();
    if (view === 'rolls') return showRolls();
    return showGrn();
  }

  /* ------------------------------- Stock ------------------------------- */
  async function showStock() {
    const { rows } = await api.get('/api/fabric/stock');
    const available = rows.filter((r) => ['IN_STOCK', 'PARTIAL'].includes(r.status));
    const totalM = available.reduce((s, r) => s + (r.remaining_m || 0), 0);
    const totalRolls = available.reduce((s, r) => s + r.rolls, 0);

    mount(body, 
      el('div', { class: 'stats' },
        stat('Rolls available', num(totalRolls), { tone: 'brand' }),
        stat('Metres available', num(Math.round(totalM))),
        stat('Fabric types', num(new Set(available.map((r) => r.fabric_code)).size)),
        stat('Colours', num(new Set(available.map((r) => r.color_code)).size))),
      card('Stock by fabric type, colour and status',
        table([
          { key: 'fabric_code', label: 'Code' },
          { key: 'fabric_name', label: 'Fabric' },
          { key: 'color_name', label: 'Colour', render: (r) => el('span', {}, swatch(r.color_hex), ' ', r.color_name) },
          { key: 'status', label: 'Status', render: (r) => chip(r.status) },
          { key: 'rolls', label: 'Rolls', num: true, render: (r) => num(r.rolls) },
          { key: 'remaining_m', label: 'Metres left', num: true, render: (r) => num(r.remaining_m) },
          { key: 'total_m', label: 'Metres received', num: true, render: (r) => num(r.total_m) },
        ], rows, { empty: 'No fabric has been received yet' }), { tight: true }));
  }

  /* ------------------------------- Rolls ------------------------------- */
  async function showRolls() {
    const filters = { status: '', q: '', fabric_type_id: '', color_id: '' };
    const list = el('div');

    const controls = el('div', { class: 'form-grid' },
      field('Search', (() => {
        const i = el('input', { placeholder: 'Roll number, tag, batch or location' });
        let t;
        i.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { filters.q = i.value.trim(); load(); }, 250); });
        return i;
      })()),
      field('Status', select([{ value: '', label: 'Any status' },
        ...['IN_STOCK', 'PARTIAL', 'CONSUMED', 'QUARANTINE'].map((s) => ({ value: s, label: s.replace('_', ' ') }))],
        { onChange: (v) => { filters.status = v; load(); } })),
      field('Fabric type', select([{ value: '', label: 'Any fabric' }, ...fabricTypes.map((f) => ({ value: f.id, label: f.name }))],
        { onChange: (v) => { filters.fabric_type_id = v; load(); } })),
      field('Colour', select([{ value: '', label: 'Any colour' }, ...colors.map((c) => ({ value: c.id, label: c.name }))],
        { onChange: (v) => { filters.color_id = v; load(); } })));

    mount(body, card('Filter', controls), list);

    async function load() {
      mount(list, el('div', { class: 'loading' }, 'Loading rolls...'));
      const data = await api.get('/api/fabric/rolls', { ...filters, limit: 500 });
      mount(list, card(`Roll register (${num(data.total)})`,
        table([
          { key: 'roll_no', label: 'Roll No', mono: true },
          { key: 'epc', label: 'Roll tag', mono: true, render: (r) => r.epc || el('span', { class: 'hint' }, 'no tag') },
          { key: 'fabric_name', label: 'Fabric' },
          { key: 'color_name', label: 'Colour', render: (r) => el('span', {}, swatch(r.color_hex), ' ', r.color_name) },
          { key: 'shade_batch', label: 'Shade' },
          { key: 'length_m', label: 'Received (m)', num: true, render: (r) => num(r.length_m) },
          { key: 'remaining_m', label: 'Remaining (m)', num: true, render: (r) => num(r.remaining_m) },
          { key: 'status', label: 'Status', render: (r) => chip(r.status) },
          { key: 'location', label: 'Location' },
          { key: 'grn_no', label: 'GRN', mono: true },
          { key: 'received_at', label: 'Received', render: (r) => dateTime(r.received_at) },
        ], data.rows, { empty: 'No rolls match these filters', maxHeight: '560px' }), { tight: true }));
    }
    await load();
  }

  /* -------------------------------- GRN -------------------------------- */
  async function showGrn() {
    const { rows } = await api.get('/api/fabric/grn', { limit: 200 });
    mount(body, card('Goods receipt notes',
      table([
        { key: 'grn_no', label: 'GRN No', mono: true },
        { key: 'supplier', label: 'Supplier' },
        { key: 'invoice_ref', label: 'Invoice' },
        { key: 'roll_count', label: 'Rolls', num: true, render: (r) => num(r.roll_count) },
        { key: 'total_m', label: 'Metres', num: true, render: (r) => num(r.total_m) },
        { key: 'received_at', label: 'Received', render: (r) => dateTime(r.received_at) },
        { key: 'received_by_name', label: 'Received by' },
      ], rows, { onRow: (r) => grnDetail(r.id), empty: 'No goods receipts recorded yet' }),
      { tight: true, subtitle: 'Click a row to see the rolls on that receipt' }));
  }

  async function grnDetail(id) {
    const { grn } = await api.get(`/api/fabric/grn/${id}`);
    modal({
      title: grn.grn_no, subtitle: `${grn.supplier || 'Supplier not recorded'} · ${dateTime(grn.received_at)}`, wide: true,
      body: el('div', {},
        el('div', { class: 'stats' },
          stat('Rolls', num(grn.rolls.length)),
          stat('Total metres', num(Math.round(grn.total_length_m))),
          stat('Invoice', grn.invoice_ref || '-'),
          stat('Received by', grn.received_by_name || '-')),
        grn.remarks ? el('p', { class: 'hint' }, grn.remarks) : null,
        table([
          { key: 'roll_no', label: 'Roll No', mono: true },
          { key: 'epc', label: 'Tag', mono: true },
          { key: 'fabric_name', label: 'Fabric' },
          { key: 'color_name', label: 'Colour' },
          { key: 'shade_batch', label: 'Shade' },
          { key: 'length_m', label: 'Metres', num: true },
          { key: 'remaining_m', label: 'Left', num: true },
          { key: 'status', label: 'Status', render: (r) => chip(r.status) },
          { key: 'location', label: 'Location' },
        ], grn.rolls)),
      actions: [{ label: 'Close', onClick: (close) => close() }],
    });
  }

  /* ---------------------------- Receiving ------------------------------ */
  function receiveDialog() {
    const lines = [];
    const linesBox = el('div');
    const supplier = el('input', { placeholder: 'e.g. Artistic Milliners Ltd.' });
    const invoice = el('input', { placeholder: 'Supplier invoice reference' });
    const remarks = el('input', { placeholder: 'Container / LC reference' });

    const addLine = (preset = {}) => {
      const line = {
        fabric_type_id: preset.fabric_type_id || fabricTypes[0]?.id,
        color_id: preset.color_id || colors[0]?.id,
        roll_no: '', epc: '', shade_batch: preset.shade_batch || '',
        length_m: '', width_in: '', weight_kg: '', location: preset.location || '',
      };
      lines.push(line);
      renderLines();
    };

    function renderLines() {
      mount(linesBox, ...lines.map((line, idx) => {
        const upd = (k) => (e) => { line[k] = e.target.value; };
        return el('div', { class: 'card', style: { marginBottom: '10px' } },
          el('div', { class: 'card-body' },
            el('div', { class: 'inline', style: { justifyContent: 'space-between', marginBottom: '10px' } },
              el('strong', {}, `Roll ${idx + 1}`),
              el('button', { class: 'btn btn-sm', onClick: () => { lines.splice(idx, 1); renderLines(); } }, 'Remove')),
            el('div', { class: 'form-grid' },
              field('Fabric type', select(fabricTypes.map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` })),
                { value: line.fabric_type_id, onChange: (v) => { line.fabric_type_id = Number(v); } })),
              field('Colour', select(colors.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` })),
                { value: line.color_id, onChange: (v) => { line.color_id = Number(v); } })),
              field('Roll number', el('input', { placeholder: 'Blank = auto', onInput: upd('roll_no') })),
              field('Roll tag EPC', el('input', { placeholder: 'Scan the roll tag', onInput: upd('epc'), class: 'mono' }),
                'Optional - enables bulk roll issue'),
              field('Shade / batch', el('input', { value: line.shade_batch, onInput: upd('shade_batch') })),
              field('Length (m)', el('input', { type: 'number', step: '0.1', min: '0.1', onInput: upd('length_m') })),
              field('Width (in)', el('input', { type: 'number', step: '0.5', onInput: upd('width_in') })),
              field('Weight (kg)', el('input', { type: 'number', step: '0.1', onInput: upd('weight_kg') })),
              field('Location', el('input', { value: line.location, placeholder: 'Rack / bay', onInput: upd('location') })))));
      }));
      if (!lines.length) linesBox.appendChild(empty('No rolls added yet', 'Add the rolls that arrived on this delivery.'));
    }

    addLine();

    modal({
      title: 'Receive denim rolls', subtitle: 'Creates a goods receipt note and registers each roll', wide: true,
      body: el('div', {},
        el('div', { class: 'form-grid mb' },
          field('Supplier', supplier), field('Invoice reference', invoice), field('Remarks', remarks)),
        el('div', { class: 'sep' }),
        linesBox,
        el('div', { class: 'inline' },
          el('button', { class: 'btn', onClick: () => addLine() }, '+ Add another roll'),
          el('button', { class: 'btn', onClick: () => {
            const last = lines[lines.length - 1];
            if (last) addLine({ fabric_type_id: last.fabric_type_id, color_id: last.color_id,
              shade_batch: last.shade_batch, location: last.location });
          } }, '+ Duplicate last'))),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Receive rolls', class: 'btn-primary', onClick: async (close) => {
          if (!lines.length) { toast('Nothing to receive', 'Add at least one roll.', 'warn'); return; }
          const payload = {
            supplier: supplier.value.trim(), invoice_ref: invoice.value.trim(), remarks: remarks.value.trim(),
            rolls: lines.map((l) => ({
              fabric_type_id: Number(l.fabric_type_id), color_id: Number(l.color_id),
              roll_no: l.roll_no.trim() || undefined, epc: l.epc.trim() || undefined,
              shade_batch: l.shade_batch.trim() || undefined, length_m: Number(l.length_m),
              width_in: l.width_in ? Number(l.width_in) : undefined,
              weight_kg: l.weight_kg ? Number(l.weight_kg) : undefined,
              location: l.location.trim() || undefined,
            })),
          };
          try {
            const out = await api.post('/api/fabric/grn', payload);
            close();
            toastOk(`${out.grn.grn_no} created`, `${out.count} roll(s) received into store.`);
            show('grn');
            $$safeTabSelect('Goods receipts');
          } catch (e) { toastErr(e); }
        } },
      ],
    });
  }

  function $$safeTabSelect(label) {
    const btn = [...document.querySelectorAll('.tab')].find((b) => b.textContent === label);
    if (btn) { document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active')); btn.classList.add('active'); }
  }

  await show('stock');
  return root;
}
