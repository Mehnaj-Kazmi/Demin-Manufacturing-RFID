import { api } from '../api.js';
import {
  el, card, table, chip, num, dateOnly, select, field, modal, toast, toastOk, toastErr,
  stat, bar, swatch, mount
} from '../ui.js';
import { can, stageName, go, masters } from '../app.js';

/** Customer orders with live production progress per size. */
export async function render(ctx) {
  ctx.setSubtitle('Customer orders and how much of each line has been produced and shipped');

  const [customers, styles, colors, sizes] = await Promise.all([
    masters('customers'), masters('styles'), masters('colors'), masters('sizes')]);

  const root = el('div');
  const box = el('div');
  root.appendChild(box);

  if (can('orders.manage')) {
    ctx.setTools(el('button', { class: 'btn btn-primary', onClick: newOrder }, '+ New order'));
  }

  async function load() {
    mount(box, el('div', { class: 'loading' }, 'Loading orders...'));
    const { rows } = await api.get('/api/orders', { limit: 200 });
    const totalOrdered = rows.reduce((s, r) => s + r.ordered_qty, 0);
    const totalShipped = rows.reduce((s, r) => s + r.shipped_qty, 0);

    mount(box, 
      el('div', { class: 'stats' },
        stat('Orders', num(rows.length)),
        stat('Units ordered', num(totalOrdered), { tone: 'brand' }),
        stat('Units in production', num(rows.reduce((s, r) => s + r.in_production, 0))),
        stat('Units shipped', num(totalShipped), { tone: 'ok' }),
        stat('Completion', totalOrdered ? Math.round((totalShipped / totalOrdered) * 100) + '%' : '-')),

      card('Orders',
        table([
          { key: 'order_no', label: 'Order No', mono: true },
          { key: 'customer_name', label: 'Customer' },
          { key: 'po_ref', label: 'Customer PO' },
          { key: 'ordered_qty', label: 'Ordered', num: true, render: (r) => num(r.ordered_qty) },
          { key: 'in_production', label: 'Tagged', num: true, render: (r) => num(r.in_production) },
          { key: 'shipped_qty', label: 'Shipped', num: true, render: (r) => num(r.shipped_qty) },
          { key: 'progress', label: 'Progress', render: (r) => bar(r.ordered_qty ? (r.shipped_qty / r.ordered_qty) * 100 : 0,
            r.shipped_qty >= r.ordered_qty ? 'ok' : '') },
          { key: 'ship_date', label: 'Ship by', render: (r) => dateOnly(r.ship_date) },
          { key: 'status', label: 'Status', render: (r) => chip(r.status) },
        ], rows, { onRow: (r) => detail(r.id), empty: 'No orders yet' }),
        { tight: true, subtitle: 'Click an order for the size-by-size breakdown' }));
  }

  async function detail(id) {
    const d = await api.get(`/api/orders/${id}`);
    const o = d.order;
    const ordered = d.lines.reduce((s, l) => s + l.qty, 0);
    const shipped = d.lines.reduce((s, l) => s + l.shipped, 0);

    modal({
      title: o.order_no, wide: true,
      subtitle: `${o.customer_name} · PO ${o.po_ref || '-'} · ship by ${dateOnly(o.ship_date)}`,
      body: el('div', {},
        el('div', { class: 'stats' },
          stat('Ordered', num(ordered)),
          stat('Shipped', num(shipped), { tone: 'ok' }),
          stat('Balance', num(ordered - shipped), { tone: ordered - shipped > 0 ? 'warn' : 'ok' }),
          stat('Completion', ordered ? Math.round((shipped / ordered) * 100) + '%' : '-')),

        card('Order lines',
          table([
            { key: 'style_code', label: 'Style', render: (l) => el('span', {}, el('strong', {}, l.style_code), ' ', el('span', { class: 'hint' }, l.style_name)) },
            { key: 'color_code', label: 'Colour' },
            { key: 'size_code', label: 'Size' },
            { key: 'qty', label: 'Ordered', num: true, render: (l) => num(l.qty) },
            { key: 'in_production', label: 'Tagged', num: true, render: (l) => num(l.in_production) },
            { key: 'shipped', label: 'Shipped', num: true, render: (l) => num(l.shipped) },
            { key: 'balance', label: 'Balance', num: true, render: (l) => l.balance > 0 ? chip(String(l.balance), 'warn') : chip('complete', 'ok') },
            { key: 'progress', label: '', render: (l) => bar(l.pct, l.pct >= 100 ? 'ok' : '') },
            { key: 'where', label: 'Where it is now', render: (l) => el('div', { class: 'pill-row' },
              Object.entries(l.by_stage).filter(([s]) => s !== 'SHIPPED')
                .map(([s, q]) => chip(`${stageName(s)}: ${q}`))) },
          ], d.lines), { tight: true })),
      actions: [{ label: 'Close', onClick: (close) => close() }],
    });
  }

  /* ----------------------------- New order ------------------------------ */
  function newOrder() {
    const lines = [];
    const linesBox = el('div');
    const orderNo = el('input', { placeholder: 'e.g. SO-2026-0010' });
    const custSel = select(customers.map((c) => ({ value: c.id, label: c.name })));
    const po = el('input', { placeholder: 'Customer purchase order' });
    const shipDate = el('input', { type: 'date' });

    const add = () => { lines.push({ style_id: styles[0]?.id, color_id: colors[0]?.id, size_id: sizes[0]?.id, qty: 1000 }); draw(); };
    const draw = () => {
      mount(linesBox, table([
        { key: 'style', label: 'Design', render: (l) => select(styles.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` })),
          { value: l.style_id, onChange: (v) => { l.style_id = Number(v); } }) },
        { key: 'color', label: 'Colour', render: (l) => select(colors.map((c) => ({ value: c.id, label: c.name })),
          { value: l.color_id, onChange: (v) => { l.color_id = Number(v); } }) },
        { key: 'size', label: 'Size', render: (l) => select(sizes.map((s) => ({ value: s.id, label: s.code })),
          { value: l.size_id, onChange: (v) => { l.size_id = Number(v); } }) },
        { key: 'qty', label: 'Quantity', render: (l) => {
          const i = el('input', { type: 'number', min: '1', value: String(l.qty) });
          i.addEventListener('input', () => { l.qty = Number(i.value) || 0; });
          return i;
        } },
        { key: 'rm', label: '', render: (l) => el('button', { class: 'btn btn-sm',
          onClick: () => { lines.splice(lines.indexOf(l), 1); draw(); } }, 'Remove') },
      ], lines, { empty: 'Add at least one line' }));
    };
    add();

    modal({
      title: 'New customer order', wide: true,
      body: el('div', {},
        el('div', { class: 'form-grid mb' },
          field('Order number', orderNo), field('Customer', custSel),
          field('Customer PO', po), field('Ship by', shipDate)),
        linesBox,
        el('button', { class: 'btn mt', onClick: add }, '+ Add line')),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Create order', class: 'btn-primary', onClick: async (close) => {
          if (!orderNo.value.trim()) { toast('Order number required', '', 'warn'); return; }
          if (!lines.length) { toast('Add at least one line', '', 'warn'); return; }
          try {
            await api.post('/api/orders', {
              order_no: orderNo.value.trim(), customer_id: Number(custSel.value),
              po_ref: po.value.trim() || null, ship_date: shipDate.value || null, lines });
            close(); toastOk('Order created'); load();
          } catch (e) { toastErr(e); }
        } },
      ],
    });
  }

  await load();
  if (ctx.params.id) detail(Number(ctx.params.id));
  return root;
}
