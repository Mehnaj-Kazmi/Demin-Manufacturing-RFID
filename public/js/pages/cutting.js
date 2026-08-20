import { api } from '../api.js';
import {
  el, card, table, chip, num, dateTime, select, field, modal, toast, toastOk, toastErr,
  stat, empty, swatch, scanPad, bar, mount
} from '../ui.js';
import { can, masters } from '../app.js';

/** Cutting: consume rolls against a cut order, then create the bundles. */
export async function render(ctx) {
  ctx.setSubtitle('Cut orders, fabric consumption and bundle creation');

  const [styles, colors, sizes, orders] = await Promise.all([
    masters('styles'), masters('colors'), masters('sizes'),
    api.get('/api/orders', { limit: 200 }).then((r) => r.rows).catch(() => []),
  ]);

  const root = el('div');
  const listBox = el('div');
  root.appendChild(listBox);

  if (can('cutting.manage')) {
    ctx.setTools(el('button', { class: 'btn btn-primary', onClick: newCutOrder }, '+ New cut order'));
  }

  async function load() {
    mount(listBox, el('div', { class: 'loading' }, 'Loading cut orders...'));
    const { rows } = await api.get('/api/cutting/orders', { limit: 200 });

    const open = rows.filter((r) => r.status !== 'CLOSED');
    mount(listBox, 
      el('div', { class: 'stats' },
        stat('Open cut orders', num(open.length), { tone: 'brand' }),
        stat('Pieces cut', num(rows.reduce((s, r) => s + (r.bundle_qty || 0), 0))),
        stat('Pieces tagged', num(rows.reduce((s, r) => s + (r.tagged_qty || 0), 0)), { tone: 'ok' }),
        stat('Awaiting tagging', num(rows.reduce((s, r) => s + ((r.bundle_qty || 0) - (r.tagged_qty || 0)), 0)), { tone: 'warn' })),
      card('Cut orders',
        table([
          { key: 'cut_no', label: 'Cut No', mono: true },
          { key: 'style_code', label: 'Style', render: (r) => el('span', {}, el('strong', {}, r.style_code), ' ', el('span', { class: 'hint' }, r.style_name)) },
          { key: 'color_code', label: 'Colour', render: (r) => el('span', {}, swatch(r.color_hex), ' ', r.color_code) },
          { key: 'order_no', label: 'Order' },
          { key: 'customer_name', label: 'Customer' },
          { key: 'planned_qty', label: 'Planned', num: true, render: (r) => num(r.planned_qty) },
          { key: 'bundle_qty', label: 'Cut', num: true, render: (r) => num(r.bundle_qty) },
          { key: 'tagged_qty', label: 'Tagged', num: true, render: (r) => num(r.tagged_qty) },
          { key: 'progress', label: 'Progress', render: (r) => bar(r.bundle_qty ? (r.tagged_qty / r.bundle_qty) * 100 : 0,
            r.bundle_qty && r.tagged_qty >= r.bundle_qty ? 'ok' : '') },
          { key: 'status', label: 'Status', render: (r) => chip(r.status) },
          { key: 'created_at', label: 'Created', render: (r) => dateTime(r.created_at) },
        ], rows, { onRow: (r) => detail(r.id), empty: 'No cut orders yet',
          emptyHint: can('cutting.manage') ? 'Create one to start consuming fabric.' : null }),
        { tight: true, subtitle: 'Click a cut order to issue fabric and create bundles' }));
  }

  /* ---------------------------- New cut order --------------------------- */
  function newCutOrder() {
    const styleSel = select(styles.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` })));
    const colorSel = select(colors.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` })));
    const orderSel = select([{ value: '', label: 'Not linked to an order' },
      ...orders.map((o) => ({ value: o.id, label: `${o.order_no} · ${o.customer_name}` }))]);
    const qty = el('input', { type: 'number', min: '1', placeholder: 'e.g. 900' });
    const remarks = el('input', { placeholder: 'Marker / lay notes' });

    modal({
      title: 'New cut order', subtitle: 'Defines what will be cut before fabric is issued',
      body: el('div', { class: 'form-grid' },
        field('Design / style', styleSel), field('Colour', colorSel),
        field('Customer order', orderSel, 'Links the garments to a customer order'),
        field('Planned quantity', qty), field('Remarks', remarks)),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Create', class: 'btn-primary', onClick: async (close) => {
          try {
            const out = await api.post('/api/cutting/orders', {
              style_id: Number(styleSel.value), color_id: Number(colorSel.value),
              order_id: orderSel.value ? Number(orderSel.value) : null,
              planned_qty: Number(qty.value) || 0, remarks: remarks.value.trim() });
            close();
            toastOk(`${out.cut_order.cut_no} created`);
            detail(out.cut_order.id);
            load();
          } catch (e) { toastErr(e); }
        } },
      ],
    });
  }

  /* ------------------------------- Detail ------------------------------- */
  async function detail(id) {
    const { cut_order: c } = await api.get(`/api/cutting/orders/${id}`);

    const m = modal({
      title: c.cut_no, wide: true,
      subtitle: `${c.style_code} ${c.style_name} · ${c.color_name} · ${c.order_no || 'no order'} · ${c.customer_name || ''}`,
      body: el('div', {},
        el('div', { class: 'stats' },
          stat('Planned', num(c.planned_qty)),
          stat('Fabric issued', num(Math.round(c.issued_m)) + ' m'),
          stat('Pieces cut', num(c.bundle_qty), { tone: 'brand' }),
          stat('Pieces tagged', num(c.tagged_qty), { tone: 'ok' }),
          stat('Status', chip(c.status))),

        card('Fabric issued to this cut',
          table([
            { key: 'roll_no', label: 'Roll', mono: true },
            { key: 'shade_batch', label: 'Shade' },
            { key: 'issued_m', label: 'Metres', num: true, render: (r) => num(r.issued_m) },
            { key: 'scanned', label: 'Confirmed by', render: (r) => r.scanned ? chip('RFID scan', 'ok') : chip('Manual entry') },
            { key: 'issued_at', label: 'Issued', render: (r) => dateTime(r.issued_at) },
            { key: 'issued_by_name', label: 'Issued by' },
          ], c.issues, { empty: 'No fabric issued yet' }),
          { tight: true, actions: can('fabric.issue') && !['CUT', 'CLOSED'].includes(c.status)
            ? el('button', { class: 'btn btn-sm btn-primary', onClick: () => { m.close(); issueDialog(c); } }, 'Issue rolls')
            : null }),

        card('Bundles',
          table([
            { key: 'bundle_no', label: 'Bundle', mono: true },
            { key: 'size_code', label: 'Size' },
            { key: 'qty', label: 'Qty', num: true },
            { key: 'received_qty', label: 'Counted at stitching', num: true,
              render: (r) => r.received_qty === null ? el('span', { class: 'hint' }, 'not counted')
                : r.received_qty === r.qty ? chip(String(r.received_qty), 'ok')
                : chip(`${r.received_qty} (${r.received_qty - r.qty > 0 ? '+' : ''}${r.received_qty - r.qty})`, 'warn') },
            { key: 'tagged_qty', label: 'Tagged', num: true },
            { key: 'status', label: 'Status', render: (r) => chip(r.status) },
            { key: 'issued_at', label: 'Issued to stitching', render: (r) => dateTime(r.issued_at) },
          ], c.bundles, { empty: 'No bundles created yet' }),
          { tight: true, actions: can('cutting.manage') ? el('div', { class: 'inline' },
            el('button', { class: 'btn btn-sm btn-primary', onClick: () => { m.close(); bundleDialog(c); } }, 'Create bundles'),
            c.bundles.some((b) => b.status === 'CUT')
              ? el('button', { class: 'btn btn-sm', onClick: async () => {
                  const ids = c.bundles.filter((b) => b.status === 'CUT').map((b) => b.id);
                  try {
                    await api.post('/api/cutting/bundles/issue', { bundle_ids: ids });
                    toastOk('Bundles issued to stitching', `${ids.length} bundle(s) handed over for manual count.`);
                    m.close(); load();
                  } catch (e) { toastErr(e); }
                } }, 'Issue all to stitching')
              : null) : null })),
      actions: [{ label: 'Close', onClick: (close) => close() }],
    });
  }

  /* ---------------------------- Issue rolls ----------------------------- */
  async function issueDialog(c) {
    const data = await api.get('/api/fabric/rolls', { status: 'IN_STOCK', color_id: c.color_id, limit: 300 });
    const partial = await api.get('/api/fabric/rolls', { status: 'PARTIAL', color_id: c.color_id, limit: 300 });
    const rolls = [...data.rows, ...partial.rows];
    const chosen = new Map();

    const listBox = el('div');
    const renderList = () => {
      mount(listBox, table([
        { key: 'pick', label: '', render: (r) => {
          const cb = el('input', { type: 'checkbox', checked: chosen.has(r.id) });
          cb.addEventListener('change', () => {
            if (cb.checked) chosen.set(r.id, r.remaining_m); else chosen.delete(r.id);
            renderList();
          });
          return cb;
        } },
        { key: 'roll_no', label: 'Roll', mono: true },
        { key: 'shade_batch', label: 'Shade' },
        { key: 'fabric_name', label: 'Fabric' },
        { key: 'remaining_m', label: 'Available (m)', num: true, render: (r) => num(r.remaining_m) },
        { key: 'issue', label: 'Issue (m)', render: (r) => {
          if (!chosen.has(r.id)) return el('span', { class: 'hint' }, '-');
          const i = el('input', { type: 'number', step: '0.1', min: '0.1', max: String(r.remaining_m),
            value: String(chosen.get(r.id)), style: { width: '110px' } });
          i.addEventListener('input', () => chosen.set(r.id, Number(i.value)));
          return i;
        } },
        { key: 'location', label: 'Location' },
      ], rolls, { empty: `No rolls in stock for colour ${c.color_name}`, maxHeight: '380px' }));
    };
    renderList();

    const pad = scanPad({
      placeholder: 'Scan roll tags to select them automatically',
      hint: 'Rolls with a tag can be picked by scanning',
      extraActions: [el('button', { class: 'btn btn-sm', onClick: async (e) => {
        const epcs = pad.epcs;
        if (!epcs.length) { toast('Nothing scanned', 'Scan at least one roll tag.', 'warn'); return; }
        const clicked = e.currentTarget; clicked.disabled = true;
        try {
          const out = await api.post('/api/fabric/rolls/scan', { epcs });
          for (const r of out.rolls) {
            if (!rolls.some((x) => x.id === r.id)) rolls.push(r);
            chosen.set(r.id, r.remaining_m);
          }
          renderList();
          if (out.unknown.length) toast('Unrecognised tags', `${out.unknown.length} tag(s) are not registered to a roll.`, 'warn');
          else toastOk(`${out.rolls.length} roll(s) selected`);
        } catch (err) { toastErr(err); } finally { clicked.disabled = false; }
      } }, 'Select scanned rolls')],
    });

    modal({
      title: `Issue fabric to ${c.cut_no}`, wide: true,
      subtitle: `${c.style_code} · ${c.color_name} — only matching-colour rolls are offered`,
      body: el('div', {}, card('Scan roll tags', pad.node), card('Available rolls', listBox, { tight: true })),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Issue selected', class: 'btn-primary', onClick: async (close) => {
          if (!chosen.size) { toast('Nothing selected', 'Choose at least one roll.', 'warn'); return; }
          try {
            const out = await api.post(`/api/cutting/orders/${c.id}/issue`, {
              rolls: [...chosen.entries()].map(([roll_id, issued_m]) => ({ roll_id, issued_m })) });
            close();
            toastOk(`Issue ${out.issue_no} recorded`, `${out.issued.length} roll(s) issued to ${c.cut_no}.`);
            load();
          } catch (e) { toastErr(e); }
        } },
      ],
    });
  }

  /* --------------------------- Create bundles --------------------------- */
  function bundleDialog(c) {
    const lines = [];
    const box = el('div');

    const add = () => { lines.push({ size_id: sizes[0]?.id, bundles: 1, qty_per_bundle: 60 }); draw(); };
    const draw = () => {
      mount(box, table([
        { key: 'size', label: 'Size', render: (l) => select(sizes.map((s) => ({ value: s.id, label: s.code })),
          { value: l.size_id, onChange: (v) => { l.size_id = Number(v); } }) },
        { key: 'bundles', label: 'Number of bundles', render: (l) => {
          const i = el('input', { type: 'number', min: '1', value: String(l.bundles) });
          i.addEventListener('input', () => { l.bundles = Number(i.value) || 1; total(); });
          return i;
        } },
        { key: 'qty', label: 'Pieces per bundle', render: (l) => {
          const i = el('input', { type: 'number', min: '1', value: String(l.qty_per_bundle) });
          i.addEventListener('input', () => { l.qty_per_bundle = Number(i.value) || 1; total(); });
          return i;
        } },
        { key: 'rm', label: '', render: (l) => el('button', { class: 'btn btn-sm',
          onClick: () => { lines.splice(lines.indexOf(l), 1); draw(); } }, 'Remove') },
      ], lines, { empty: 'Add a size line to begin' }));
      total();
    };
    const totalNode = el('strong', {}, '0');
    const total = () => { totalNode.textContent = num(lines.reduce((s, l) => s + l.bundles * l.qty_per_bundle, 0)); };
    add();

    modal({
      title: `Create bundles for ${c.cut_no}`,
      subtitle: 'Bundles are handed to stitching on a manual count; RFID tags are attached there',
      body: el('div', {}, box,
        el('div', { class: 'inline mt' },
          el('button', { class: 'btn', onClick: add }, '+ Add size'),
          el('span', { class: 'spacer' }),
          el('span', {}, 'Total pieces: ', totalNode))),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Create bundles', class: 'btn-primary', onClick: async (close) => {
          if (!lines.length) { toast('Nothing to create', 'Add at least one size line.', 'warn'); return; }
          try {
            const out = await api.post(`/api/cutting/orders/${c.id}/bundles`, { lines });
            close();
            toastOk(`${out.bundles.length} bundle(s) created`, `${out.total_qty} pieces cut against ${c.cut_no}.`);
            load();
          } catch (e) { toastErr(e); }
        } },
      ],
    });
  }

  await load();
  return root;
}
