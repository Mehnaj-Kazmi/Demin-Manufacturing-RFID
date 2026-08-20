import { STAGES } from './process.js';

/** Printable inter-section documents. Plain HTML so any browser can print them. */

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const stageName = (code) => STAGES[code]?.name || code;

const CSS = `
  * { box-sizing: border-box; }
  body { font: 12px/1.45 "Segoe UI", Arial, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 19px; margin: 0 0 2px; letter-spacing: .3px; }
  .sub { color: #555; margin-bottom: 16px; font-size: 12px; }
  .band { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 14px; }
  .docno { text-align: right; }
  .docno .no { font-size: 20px; font-weight: 700; font-family: Consolas, monospace; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th, td { border: 1px solid #bbb; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #eee; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
  .cell { border: 1px solid #ccc; padding: 8px 10px; }
  .cell .k { font-size: 10px; text-transform: uppercase; letter-spacing: .6px; color: #666; }
  .cell .v { font-size: 15px; font-weight: 600; margin-top: 2px; }
  .warn { border-color: #b00; }
  .warn .v { color: #b00; }
  .sign { display: grid; grid-template-columns: repeat(3, 1fr); gap: 26px; margin-top: 42px; }
  .sign div { border-top: 1px solid #333; padding-top: 5px; font-size: 11px; color: #444; }
  .mono { font-family: Consolas, monospace; font-size: 10.5px; }
  .foot { margin-top: 22px; font-size: 10px; color: #777; border-top: 1px solid #ddd; padding-top: 6px; }
  @media print { body { margin: 10mm; } .noprint { display: none; } }
  .noprint { margin-bottom: 14px; }
  button { font: inherit; padding: 6px 14px; cursor: pointer; }
`;

function page(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${CSS}</style></head><body>
<div class="noprint"><button onclick="window.print()">Print this document</button></div>
${inner}
<div class="foot">Generated ${esc(new Date().toLocaleString())} &middot; Denim RFID Track &amp; Trace</div>
</body></html>`;
}

export function printDocument(detail, lines) {
  const d = detail.doc;
  const matched = d.status === 'RECEIVED';
  const title = `${d.doc_no} - ${stageName(d.from_stage)} to ${stageName(d.to_stage)}`;

  const breakdown = detail.breakdown.map((b) => `
    <tr><td>${esc(b.style_code)}</td><td>${esc(b.style_name || '')}</td><td>${esc(b.color_code)}</td>
        <td>${esc(b.size_code)}</td><td>${esc(b.order_no || '-')}</td><td>${esc(b.customer_name || '-')}</td>
        <td class="num">${b.qty}</td><td class="num">${b.received_qty ?? 0}</td></tr>`).join('');

  const missing = detail.missing.length ? `
    <h3>Not received (${detail.missing.length})</h3>
    <table><thead><tr><th>Serial No</th><th>EPC</th><th>Style</th><th>Colour</th><th>Size</th></tr></thead><tbody>
    ${detail.missing.slice(0, 300).map((m) => `<tr><td>${esc(m.serial_no || '-')}</td>
      <td class="mono">${esc(m.epc)}</td><td>${esc(m.style_code || '')}</td>
      <td>${esc(m.color_code || '')}</td><td>${esc(m.size_code || '')}</td></tr>`).join('')}
    </tbody></table>` : '';

  return page(title, `
  <div class="band">
    <div>
      <h1>TRANSFER &amp; RECEIPT NOTE</h1>
      <div class="sub"><strong>${esc(stageName(d.from_stage))}</strong> &rarr; <strong>${esc(stageName(d.to_stage))}</strong></div>
    </div>
    <div class="docno">
      <div class="no">${esc(d.doc_no)}</div>
      <div class="sub">Status: <strong>${esc(d.status)}</strong></div>
    </div>
  </div>

  <div class="grid">
    <div class="cell"><div class="k">Expected</div><div class="v">${d.expected_count}</div></div>
    <div class="cell"><div class="k">Received</div><div class="v">${d.received_count}</div></div>
    <div class="cell${d.missing_count ? ' warn' : ''}"><div class="k">Missing</div><div class="v">${d.missing_count}</div></div>
    <div class="cell${d.extra_count ? ' warn' : ''}"><div class="k">Extra</div><div class="v">${d.extra_count}</div></div>
  </div>

  <table>
    <tbody>
      <tr><th style="width:22%">Dispatched at</th><td>${esc(d.created_at)}</td>
          <th style="width:22%">Dispatched by</th><td>${esc(d.created_by_name || '-')}</td></tr>
      <tr><th>Received at</th><td>${esc(d.received_at || 'Not yet received')}</td>
          <th>Received by</th><td>${esc(d.received_by_name || '-')}</td></tr>
      <tr><th>Batch reference</th><td>${esc(d.batch_ref || '-')}</td>
          <th>Sorted by</th><td>${esc(d.group_key || '-')}</td></tr>
      <tr><th>Wash recipe</th><td>${esc(d.wash_recipe || '-')}</td>
          <th>Tally result</th><td><strong>${matched ? 'MATCHED' : esc(d.status)}</strong></td></tr>
      ${d.variance_note ? `<tr><th>Variance note</th><td colspan="3">${esc(d.variance_note)}</td></tr>` : ''}
      ${d.remarks ? `<tr><th>Remarks</th><td colspan="3">${esc(d.remarks)}</td></tr>` : ''}
    </tbody>
  </table>

  <h3>Contents</h3>
  <table>
    <thead><tr><th>Style</th><th>Description</th><th>Colour</th><th>Size</th><th>Order</th><th>Customer</th>
      <th class="num">Qty</th><th class="num">Received</th></tr></thead>
    <tbody>${breakdown || '<tr><td colspan="8">No lines</td></tr>'}</tbody>
    <tfoot><tr><th colspan="6">Total</th><th class="num">${d.expected_count}</th><th class="num">${d.received_count}</th></tr></tfoot>
  </table>

  ${missing}

  <div class="sign">
    <div>Dispatched by (${esc(stageName(d.from_stage))})</div>
    <div>Received by (${esc(stageName(d.to_stage))})</div>
    <div>Verified by (Supervisor)</div>
  </div>
  <div class="foot">${lines.length} tag line(s) recorded against this document.</div>
  `);
}

export function printShipment(s, lines) {
  const byCarton = new Map();
  for (const l of lines) {
    const k = l.carton_no || '(no carton)';
    byCarton.set(k, (byCarton.get(k) || 0) + 1);
  }
  return page(`${s.shipment_no} - Packing List`, `
  <div class="band">
    <div>
      <h1>PACKING LIST</h1>
      <div class="sub">${esc(s.customer_name || '-')}${s.order_no ? ` &middot; Order ${esc(s.order_no)}` : ''}</div>
    </div>
    <div class="docno"><div class="no">${esc(s.shipment_no)}</div>
      <div class="sub">Status: <strong>${esc(s.status)}</strong></div></div>
  </div>

  <div class="grid">
    <div class="cell"><div class="k">Units</div><div class="v">${s.qty}</div></div>
    <div class="cell"><div class="k">Cartons</div><div class="v">${byCarton.size}</div></div>
    <div class="cell"><div class="k">Carrier</div><div class="v">${esc(s.carrier || '-')}</div></div>
    <div class="cell"><div class="k">Shipped</div><div class="v">${esc(s.shipped_at || 'Not shipped')}</div></div>
  </div>

  <h3>Breakdown</h3>
  <table>
    <thead><tr><th>Carton</th><th>Style</th><th>Colour</th><th>Size</th><th class="num">Qty</th></tr></thead>
    <tbody>${s.breakdown.map((b) => `<tr><td>${esc(b.carton_no || '-')}</td><td>${esc(b.style_code)}</td>
      <td>${esc(b.color_code)}</td><td>${esc(b.size_code)}</td><td class="num">${b.qty}</td></tr>`).join('')
      || '<tr><td colspan="5">Nothing packed yet</td></tr>'}</tbody>
    <tfoot><tr><th colspan="4">Total</th><th class="num">${s.qty}</th></tr></tfoot>
  </table>

  <h3>Customer tag register</h3>
  <table>
    <thead><tr><th>Serial No</th><th>Style</th><th>Size</th><th>Customer tag EPC</th><th>Re-tagged by</th></tr></thead>
    <tbody>${lines.slice(0, 500).map((l) => `<tr><td>${esc(l.serial_no)}</td><td>${esc(l.style_code)}</td>
      <td>${esc(l.size_code)}</td><td class="mono">${esc(l.customer_epc)}</td>
      <td>${esc(l.swapped_by_name || '-')}</td></tr>`).join('')}</tbody>
  </table>
  ${lines.length > 500 ? `<div class="sub">Showing the first 500 of ${lines.length} units - export the full list as CSV.</div>` : ''}

  <div class="sign"><div>Packed by</div><div>Checked by</div><div>Carrier signature</div></div>
  `);
}
