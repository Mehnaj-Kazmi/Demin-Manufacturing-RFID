import { api } from '../api.js';
import {
  el, card, table, chip, num, dateTime, select, field, modal, toast, toastOk, toastErr,
  stat, empty, kv, swatch, tabs, scanPad, simSection, confirmDialog, mount
} from '../ui.js';
import { can, stageName, go, masters } from '../app.js';

/**
 * Dispatch & packing.
 *
 * The in-house tracking tag comes off here and the customer's own tag goes on.
 * The tracking EPC is released back to the pool while the garment keeps its full
 * history under the new tag.
 */
export async function render(ctx) {
  ctx.setSubtitle('Remove tracking tags, apply customer tags, pack and ship');

  const [customers, orders] = await Promise.all([
    masters('customers'),
    api.get('/api/orders', { limit: 200 }).then((r) => r.rows).catch(() => []),
  ]);

  const root = el('div');
  const body = el('div');
  root.appendChild(tabs([
    { key: 'ready', label: 'Ready to re-tag' },
    { key: 'shipments', label: 'Shipments' },
  ], (k) => show(k), 'ready'));
  root.appendChild(body);

  if (can('dispatch.tagswap')) {
    ctx.setTools(el('button', { class: 'btn btn-primary', onClick: newShipment }, '+ New shipment'));
  }

  async function show(view) {
    mount(body, el('div', { class: 'loading' }, 'Loading...'));
    return view === 'ready' ? showReady() : showShipments();
  }

  /* ------------------------------- Ready -------------------------------- */
  async function showReady() {
    const [ready, pending, shipments] = await Promise.all([
      api.get('/api/dispatch/ready', {}),
      api.get('/api/movements/pending/DISPATCH'),
      api.get('/api/dispatch/shipments', { status: 'OPEN' }),
    ]);

    mount(body, 
      el('div', { class: 'stats' },
        stat('Awaiting re-tagging', num(ready.count), { tone: 'brand', sub: 'QC-passed, still on tracking tags' }),
        stat('Batches inbound', num(pending.rows.length), { tone: pending.rows.length ? 'warn' : 'ok' }),
        stat('Open shipments', num(shipments.rows.length)),
        stat('Customer orders', num(new Set(ready.rows.map((r) => r.order_no).filter(Boolean)).size))),

      pending.rows.length ? card('Batches waiting to be received into Dispatch',
        table([
          { key: 'doc_no', label: 'Document', mono: true },
          { key: 'expected_count', label: 'Garments', num: true },
          { key: 'created_at', label: 'Sent', render: (r) => dateTime(r.created_at) },
          { key: 'created_by_name', label: 'Sent by' },
        ], pending.rows, { onRow: () => go('transfers', { stage: 'DISPATCH' }) }),
        { tight: true, subtitle: 'Receive them in Transfers first' }) : null,

      card('Ready for the customer tag',
        table([
          { key: 'style_code', label: 'Style' },
          { key: 'color_code', label: 'Colour' },
          { key: 'size_code', label: 'Size' },
          { key: 'order_no', label: 'Order' },
          { key: 'customer_name', label: 'Customer' },
          { key: 'qty', label: 'Garments', num: true, render: (r) => el('strong', {}, num(r.qty)) },
        ], ready.summary, { empty: 'Nothing waiting', emptyHint: 'No QC-passed garments have been received into Dispatch.' }),
        { tight: true,
          subtitle: 'Open a shipment, then swap the tags a tray at a time',
          actions: can('dispatch.tagswap') && ready.count
            ? el('button', { class: 'btn btn-primary', onClick: newShipment }, 'Start a shipment') : null }));
  }

  /* ----------------------------- Shipments ------------------------------ */
  async function showShipments() {
    const { rows } = await api.get('/api/dispatch/shipments', { limit: 200 });
    mount(body, card('Shipments',
      table([
        { key: 'shipment_no', label: 'Shipment', mono: true },
        { key: 'customer_name', label: 'Customer' },
        { key: 'order_no', label: 'Order' },
        { key: 'qty', label: 'Units', num: true, render: (r) => num(r.qty) },
        { key: 'status', label: 'Status', render: (r) => chip(r.status) },
        { key: 'carrier', label: 'Carrier' },
        { key: 'created_at', label: 'Opened', render: (r) => dateTime(r.created_at) },
        { key: 'shipped_at', label: 'Shipped', render: (r) => dateTime(r.shipped_at) },
        { key: 'created_by_name', label: 'Opened by' },
      ], rows, { onRow: (r) => shipmentDetail(r.id), empty: 'No shipments yet' }),
      { tight: true, subtitle: 'Click a shipment to re-tag garments into it' }));
  }

  /* --------------------------- New shipment ----------------------------- */
  function newShipment() {
    const orderSel = select([{ value: '', label: 'No specific order' },
      ...orders.map((o) => ({ value: o.id, label: `${o.order_no} · ${o.customer_name}` }))]);
    const custSel = select([{ value: '', label: 'Choose a customer' },
      ...customers.map((c) => ({ value: c.id, label: c.name }))]);
    const carrier = el('input', { placeholder: 'e.g. DHL Global Forwarding' });
    const remarks = el('input', { placeholder: 'Booking reference, seal number...' });

    modal({
      title: 'Open a shipment',
      subtitle: 'Garments are re-tagged into a shipment, then despatched together',
      body: el('div', { class: 'form-grid' },
        field('Customer order', orderSel, 'Restricts which garments may be packed'),
        field('Customer', custSel, 'Only needed if no order is chosen'),
        field('Carrier', carrier), field('Remarks', remarks)),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Open shipment', class: 'btn-primary', onClick: async (close) => {
          if (!orderSel.value && !custSel.value) { toast('Choose an order or a customer', '', 'warn'); return; }
          try {
            const out = await api.post('/api/dispatch/shipments', {
              order_id: orderSel.value ? Number(orderSel.value) : null,
              customer_id: custSel.value ? Number(custSel.value) : null,
              carrier: carrier.value.trim() || null, remarks: remarks.value.trim() || null });
            close();
            toastOk(`${out.shipment.shipment_no} opened`);
            shipmentDetail(out.shipment.id);
          } catch (e) { toastErr(e); }
        } },
      ],
    });
  }

  /* -------------------------- Shipment detail --------------------------- */
  async function shipmentDetail(id) {
    const [{ shipment: s }, { rows: lines }] = await Promise.all([
      api.get(`/api/dispatch/shipments/${id}`),
      api.get(`/api/dispatch/shipments/${id}/lines`, { limit: 1000 }),
    ]);

    const m = modal({
      title: s.shipment_no, wide: true,
      subtitle: `${s.customer_name || '-'}${s.order_no ? ' · order ' + s.order_no : ''} · ${s.status}`,
      body: el('div', {},
        el('div', { class: 'stats' },
          stat('Units packed', num(s.qty), { tone: 'brand' }),
          stat('Cartons', num(new Set(lines.map((l) => l.carton_no).filter(Boolean)).size)),
          stat('Status', chip(s.status)),
          stat('Carrier', s.carrier || '-')),

        s.tag_spec ? el('p', { class: 'hint' }, `Customer tag specification: ${s.tag_spec}`) : null,

        s.breakdown.length ? card('Packed breakdown',
          table([
            { key: 'carton_no', label: 'Carton' }, { key: 'style_code', label: 'Style' },
            { key: 'color_code', label: 'Colour' }, { key: 'size_code', label: 'Size' },
            { key: 'qty', label: 'Units', num: true, render: (r) => num(r.qty) },
          ], s.breakdown), { tight: true }) : null,

        card('Tag register',
          table([
            { key: 'serial_no', label: 'Serial No', mono: true },
            { key: 'style_code', label: 'Style' }, { key: 'size_code', label: 'Size' },
            { key: 'old_epc', label: 'Tracking tag removed', mono: true },
            { key: 'customer_epc', label: 'Customer tag applied', mono: true },
            { key: 'carton_no', label: 'Carton' },
            { key: 'swapped_at', label: 'Re-tagged', render: (r) => dateTime(r.swapped_at) },
            { key: 'swapped_by_name', label: 'By' },
          ], lines, { empty: 'Nothing re-tagged into this shipment yet', maxHeight: '340px' }),
          { tight: true })),
      actions: [
        { label: 'Print packing list', onClick: () => api.openPrint(`/api/dispatch/shipments/${id}/print`) },
        s.status !== 'SHIPPED' && can('dispatch.tagswap')
          ? { label: 'Re-tag garments', class: 'btn-primary', onClick: (close) => { close(); swapScreen(s); } } : null,
        s.status !== 'SHIPPED' && can('dispatch.ship') && s.qty > 0
          ? { label: 'Despatch shipment', class: 'btn-ok', onClick: async (close) => {
              const okToShip = await confirmDialog({
                title: `Despatch ${s.shipment_no}?`,
                message: `${s.qty} garment(s) will be marked as shipped and leave work in process.`,
                confirmLabel: 'Despatch', tone: 'btn-ok' });
              if (!okToShip) return;
              try {
                const out = await api.post(`/api/dispatch/shipments/${id}/ship`, {});
                close();
                toastOk(`${s.shipment_no} despatched`, `${out.shipped} garment(s) shipped.`);
                show('shipments');
              } catch (e) { toastErr(e); }
            } } : null,
        { label: 'Close', onClick: (close) => close() },
      ].filter(Boolean),
    });
    void m;
  }

  /* ---------------------------- Tag swapping ---------------------------- */
  function swapScreen(s) {
    const pairs = [];
    const listBox = el('div');
    const carton = el('input', { placeholder: 'e.g. CTN-001', value: 'CTN-001' });

    const trackingIn = el('input', { placeholder: 'Scan the tracking tag on the garment', class: 'mono' });
    const customerIn = el('input', { placeholder: 'Scan or encode the customer tag', class: 'mono' });
    const infoBox = el('div');

    const draw = () => {
      mount(listBox, table([
        { key: 'serial_no', label: 'Serial No', mono: true },
        { key: 'style', label: 'Garment' },
        { key: 'tracking_epc', label: 'Tracking tag (removing)', mono: true },
        { key: 'customer_epc', label: 'Customer tag (applying)', mono: true },
        { key: 'rm', label: '', render: (p) => el('button', { class: 'btn btn-sm',
          onClick: () => { pairs.splice(pairs.indexOf(p), 1); draw(); } }, 'Remove') },
      ], pairs, { empty: 'No pairs queued yet', maxHeight: '300px' }));
    };
    draw();

    // Scanning the tracking tag first shows what the garment is and what tag it needs.
    trackingIn.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const epc = trackingIn.value.trim().toUpperCase();
      if (!epc) return;
      try {
        const out = await api.get(`/api/dispatch/prepare/${encodeURIComponent(epc)}`);
        const a = out.article;
        mount(infoBox, card(`${a.serial_no} · ${a.style_code} ${a.style_name}`,
          kv([
            ['Colour', el('span', {}, swatch(a.color_hex), ' ', a.color_name)],
            ['Size', a.size_code],
            ['Order', a.order_no || '-'],
            ['Customer', a.customer_name || '-'],
            ['QC state', chip(a.qc_state)],
            ['Customer tag spec', out.customer_tag_spec || 'not specified'],
          ]), { subtitle: 'Apply the customer tag, then scan it below' }));
        customerIn.focus();
      } catch (err) {
        mount(infoBox, card('Cannot re-tag this garment', el('p', {}, err.message)));
        toastErr(err);
      }
    });

    customerIn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const t = trackingIn.value.trim().toUpperCase();
      const c = customerIn.value.trim().toUpperCase();
      if (!t || !c) { toast('Both tags are needed', 'Scan the tracking tag and then the customer tag.', 'warn'); return; }
      if (pairs.some((p) => p.tracking_epc === t)) { toast('Already queued', 'That garment is already in the list.', 'warn'); return; }
      const info = infoBox.querySelector('h2');
      pairs.push({ tracking_epc: t, customer_epc: c, carton_no: carton.value.trim() || null,
        serial_no: info ? info.textContent.split(' · ')[0] : '-', style: info ? info.textContent.split(' · ')[1] || '' : '' });
      trackingIn.value = ''; customerIn.value = '';
      mount(infoBox);
      draw();
      trackingIn.focus();
    });

    modal({
      title: `Re-tag garments into ${s.shipment_no}`, wide: true,
      subtitle: 'Scan the tracking tag, apply the customer tag, scan it, repeat. Press Enter after each scan.',
      body: el('div', {},
        el('div', { class: 'form-grid mb' },
          field('Carton number', carton),
          field('1. Tracking tag on the garment', trackingIn),
          field('2. Customer tag being applied', customerIn)),
        infoBox,
        el('div', { class: 'inline mb' },
          el('button', { class: 'btn btn-sm', onClick: async (e) => {
            // Bulk helper: queue every garment ready in Dispatch with freshly encoded tags.
            const clicked = e.currentTarget; clicked.disabled = true;
            try {
              const ready = await api.get('/api/dispatch/ready', s.order_id ? { order_id: s.order_id } : {});
              const epcs = await simSection('DISPATCH');
              const eligible = ready.rows.filter((r) => epcs.includes(r.epc)).slice(0, 500);
              if (!eligible.length) { toast('Nothing eligible', 'No QC-passed garments are waiting in Dispatch.', 'warn'); return; }
              const gen = await api.post('/api/sim/tags', { count: eligible.length, prefix: 'C001' });
              eligible.forEach((r, i) => {
                if (pairs.some((p) => p.tracking_epc === r.epc)) return;
                pairs.push({ tracking_epc: r.epc, customer_epc: gen.epcs[i], carton_no: carton.value.trim() || null,
                  serial_no: r.serial_no, style: `${r.style_code} ${r.size_code}` });
              });
              draw();
              toast('Queued', `${eligible.length} garment(s) queued with encoded customer tags.`);
            } catch (err) { toastErr(err); } finally { clicked.disabled = false; }
          } }, 'Simulate tabletop encoder for the whole tray')),
        listBox),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Apply tag swap', class: 'btn-primary', onClick: async (close) => {
          if (!pairs.length) { toast('Nothing queued', 'Scan at least one pair.', 'warn'); return; }
          try {
            const out = await api.post(`/api/dispatch/shipments/${s.id}/swap`, {
              pairs: pairs.map((p) => ({ tracking_epc: p.tracking_epc, customer_epc: p.customer_epc, carton_no: p.carton_no })) });
            close();
            toastOk(`${out.swapped} garment(s) re-tagged`,
              out.failed.length ? `${out.failed.length} could not be swapped.` : 'Tracking tags released back to the pool.');
            if (out.failed.length) {
              modal({ title: 'Some swaps failed',
                body: table([
                  { key: 'tracking_epc', label: 'Tracking tag', mono: true },
                  { key: 'customer_epc', label: 'Customer tag', mono: true },
                  { key: 'message', label: 'Reason' }], out.failed),
                actions: [{ label: 'Close', onClick: (c) => c() }] });
            }
            shipmentDetail(s.id);
          } catch (e) { toastErr(e); }
        } },
      ],
    });
    setTimeout(() => trackingIn.focus(), 60);
  }

  await show('ready');
  if (ctx.params.shipment) shipmentDetail(Number(ctx.params.shipment));
  return root;
}
