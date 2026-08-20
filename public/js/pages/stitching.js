import { api } from '../api.js';
import {
  el, card, table, chip, num, dateTime, field, modal, toast, toastOk, toastErr,
  stat, empty, swatch, scanPad, bar, mount
} from '../ui.js';
import { can } from '../app.js';

/**
 * Stitching. Two jobs happen here:
 *   1. Accept the bundle from cutting on a manual count (no tags exist yet).
 *   2. Attach a UHF tag to each finished garment and register it in the system.
 */
export async function render(ctx) {
  ctx.setSubtitle('Receive bundles on a manual count, then register each garment against its RFID tag');

  const root = el('div');
  const box = el('div');
  root.appendChild(box);

  async function load() {
    mount(box, el('div', { class: 'loading' }, 'Loading bundles...'));
    const { rows } = await api.get('/api/cutting/bundles', { limit: 400 });

    const awaiting = rows.filter((b) => b.status === 'ISSUED_TO_STITCH');
    const tagging = rows.filter((b) => b.status === 'IN_STITCHING');
    const notIssued = rows.filter((b) => b.status === 'CUT');

    const cols = (extra = []) => [
      { key: 'bundle_no', label: 'Bundle', mono: true },
      { key: 'cut_no', label: 'Cut order', mono: true },
      { key: 'style_code', label: 'Style', render: (r) => el('span', {}, el('strong', {}, r.style_code), ' ', el('span', { class: 'hint' }, r.style_name)) },
      { key: 'color_code', label: 'Colour', render: (r) => el('span', {}, swatch(r.color_hex), ' ', r.color_code) },
      { key: 'size_code', label: 'Size' },
      { key: 'order_no', label: 'Order' },
      { key: 'qty', label: 'Pieces', num: true, render: (r) => num(r.qty) },
      ...extra,
    ];

    mount(box, 
      el('div', { class: 'stats' },
        stat('Bundles to count in', num(awaiting.length), { tone: awaiting.length ? 'warn' : 'ok', sub: 'handed over by cutting' }),
        stat('Bundles being tagged', num(tagging.length), { tone: 'brand' }),
        stat('Pieces awaiting tags', num(tagging.reduce((s, b) => s + b.remaining_to_tag, 0))),
        stat('Still in cutting', num(notIssued.length), { sub: 'not yet handed over' })),

      card('Bundles waiting to be counted in',
        table(cols([
          { key: 'issued_at', label: 'Handed over', render: (r) => dateTime(r.issued_at) },
          { key: 'act', label: '', render: (r) => can('stitching.commission')
            ? el('button', { class: 'btn btn-sm btn-primary', onClick: (e) => { e.stopPropagation(); countDialog(r); } }, 'Count in')
            : null },
        ]), awaiting, {
          empty: 'Nothing waiting', emptyHint: 'Cutting has not handed over any bundles.',
        }),
        { tight: true, subtitle: 'Physically count the pieces and enter the number - any difference from the cutting figure is recorded' }),

      card('Bundles being tagged',
        table(cols([
          { key: 'tagged_qty', label: 'Tagged', num: true, render: (r) => num(r.tagged_qty) },
          { key: 'remaining_to_tag', label: 'Remaining', num: true,
            render: (r) => r.remaining_to_tag ? chip(String(r.remaining_to_tag), 'warn') : chip('complete', 'ok') },
          { key: 'progress', label: 'Progress', render: (r) => bar(r.qty ? (r.tagged_qty / r.qty) * 100 : 0, r.tagged_qty >= r.qty ? 'ok' : '') },
          { key: 'act', label: '', render: (r) => can('stitching.commission') && r.remaining_to_tag > 0
            ? el('button', { class: 'btn btn-sm btn-primary', onClick: (e) => { e.stopPropagation(); tagDialog(r); } }, 'Attach tags')
            : null },
        ]), tagging, {
          empty: 'No bundles in progress', emptyHint: 'Count a bundle in to start attaching tags.',
        }),
        { tight: true, subtitle: 'Each garment gets a UHF tag; the tag becomes that garment\'s identity for the rest of the process' }),

      notIssued.length ? card('Still with cutting',
        table(cols([{ key: 'created_at', label: 'Cut at', render: (r) => dateTime(r.created_at) }]), notIssued),
        { tight: true, subtitle: 'These bundles have not been handed over yet' }) : null);
  }

  /* ------------------------- Manual count in ---------------------------- */
  function countDialog(b) {
    const input = el('input', { type: 'number', min: '0', value: String(b.qty), autofocus: true });
    const note = el('p', { class: 'hint' },
      `Cutting recorded ${b.qty} pieces. Enter what you actually counted - the difference is kept on record.`);

    modal({
      title: `Count in bundle ${b.bundle_no}`,
      subtitle: `${b.style_code} · ${b.color_code} · size ${b.size_code}`,
      body: el('div', {}, note, field('Pieces counted', input)),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Confirm count', class: 'btn-primary', onClick: async (close) => {
          try {
            const out = await api.post(`/api/stitching/bundles/${b.id}/receive`, { counted_qty: Number(input.value) });
            close();
            if (out.matched) toastOk(`${b.bundle_no} counted in`, `${out.bundle.qty} pieces match the cutting figure.`);
            else toast('Count difference recorded', `Counted ${out.bundle.qty}, cutting said ${b.qty} (${out.variance > 0 ? '+' : ''}${out.variance}).`, 'warn');
            load();
          } catch (e) { toastErr(e); }
        } },
      ],
    });
  }

  /* --------------------------- Attach tags ------------------------------ */
  function tagDialog(b) {
    const remainingNode = el('strong', {}, num(b.remaining_to_tag));
    const status = el('div', { class: 'hint' });

    const pad = scanPad({
      placeholder: 'Attach a tag to each garment, then scan it here.\nOne EPC per line - a handheld in keyboard-wedge mode types straight in.',
      hint: `${b.remaining_to_tag} garment(s) still to tag in this bundle`,
      onChange: (n) => {
        status.textContent = n > b.remaining_to_tag
          ? `${n} tags scanned but only ${b.remaining_to_tag} garments remain in this bundle.`
          : n ? `${n} tag(s) ready to register.` : '';
        status.style.color = n > b.remaining_to_tag ? 'var(--danger)' : '';
      },
      extraActions: [
        el('button', { class: 'btn btn-sm', onClick: async (e) => {
          const clicked = e.currentTarget; clicked.disabled = true;
          try {
            const out = await api.post('/api/sim/tags', { count: b.remaining_to_tag });
            pad.set(out.epcs);
            toast('Simulated encoder', `${out.count} blank tag(s) generated.`);
          } catch (err) { toastErr(err); } finally { clicked.disabled = false; }
        } }, 'Simulate tag encoder'),
      ],
    });

    modal({
      title: `Attach tags · bundle ${b.bundle_no}`, wide: true,
      subtitle: `${b.style_code} ${b.style_name} · ${b.color_code} · size ${b.size_code} · order ${b.order_no || '-'}`,
      body: el('div', {},
        el('div', { class: 'stats' },
          stat('Bundle quantity', num(b.qty)),
          stat('Already tagged', num(b.tagged_qty), { tone: 'ok' }),
          stat('Remaining', remainingNode, { tone: 'warn' })),
        pad.node, status,
        el('p', { class: 'hint mt' },
          'Each tag is checked against every tag in the system - one that is already in use is rejected, so a tag can never identify two garments.')),
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Register garments', class: 'btn-primary', onClick: async (close) => {
          const epcs = pad.epcs;
          if (!epcs.length) { toast('Nothing scanned', 'Scan the tags you attached.', 'warn'); return; }
          try {
            const out = await api.post('/api/stitching/commission', { bundle_id: b.id, epcs });
            close();
            toastOk(`${out.count} garment(s) registered`,
              `${out.bundle.bundle_no}: ${out.bundle.tagged_qty} of ${out.bundle.qty} tagged` +
              (out.bundle.remaining ? `, ${out.bundle.remaining} remaining.` : ' - bundle complete.'));
            load();
          } catch (e) {
            toastErr(e);
            if (e.detail?.epcs) {
              modal({ title: 'Tags already in use',
                body: el('div', {},
                  el('p', {}, 'These tags are registered to other garments and were not accepted:'),
                  el('div', { class: 'mono' }, e.detail.epcs.join(', '))),
                actions: [{ label: 'Close', onClick: (c) => c() }] });
            }
          }
        } },
      ],
    });
  }

  await load();
  return root;
}
