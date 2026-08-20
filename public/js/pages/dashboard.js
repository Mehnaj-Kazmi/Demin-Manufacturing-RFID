import { api } from '../api.js';
import { el, card, stat, table, chip, num, age, dateTime, ageBar, since, empty, bar } from '../ui.js';
import { go, stageName } from '../app.js';

/**
 * Hourly output as grouped bars. Drawn as inline SVG so it prints, scales and
 * follows the light/dark theme without a charting library.
 */
const SERIES = [
  { key: 'COMMISSION', label: 'Tagged',      color: 'var(--brand)' },
  { key: 'DISPATCH',   label: 'Dispatched',  color: 'var(--info)' },
  { key: 'QC_PASS',    label: 'QC passed',   color: 'var(--ok)' },
  { key: 'QC_FAIL',    label: 'QC failed',   color: 'var(--danger)' },
];

function hourlyChart(rows) {
  const periods = [...new Set(rows.map((r) => r.period))].sort();
  if (!periods.length) {
    return empty('No activity in the last 24 hours', 'Bars appear as soon as garments start moving.');
  }

  // period -> event_type -> qty (stages are summed; this is plant-wide output)
  const data = new Map(periods.map((p) => [p, {}]));
  for (const r of rows) {
    const bucket = data.get(r.period);
    if (bucket) bucket[r.event_type] = (bucket[r.event_type] || 0) + r.qty;
  }

  const max = Math.max(1, ...periods.flatMap((p) => SERIES.map((s) => data.get(p)[s.key] || 0)));
  const W = 1000, H = 220, padL = 48, padB = 30, padT = 10;
  const plotW = W - padL - 10, plotH = H - padB - padT;
  const slot = plotW / periods.length;
  const barW = Math.max(1.5, (slot - 4) / SERIES.length);

  const svg = (tag, attrs, ...kids) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    kids.flat().filter(Boolean).forEach((c) => n.appendChild(c));
    return n;
  };

  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '230',
    preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Hourly output' });

  // Horizontal guides with value labels
  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (plotH * i) / 4;
    chart.appendChild(svg('line', { x1: padL, y1: y, x2: W - 10, y2: y,
      stroke: 'var(--border)', 'stroke-width': 1 }));
    chart.appendChild(svg('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end',
      'font-size': 11, fill: 'var(--text-3)' },
      document.createTextNode(Math.round((max * i) / 4).toLocaleString())));
  }

  periods.forEach((p, i) => {
    const x0 = padL + i * slot + 2;
    SERIES.forEach((s, j) => {
      const v = data.get(p)[s.key] || 0;
      if (!v) return;
      const h = (v / max) * plotH;
      const bar = svg('rect', { x: x0 + j * barW, y: padT + plotH - h, width: barW, height: h,
        fill: s.color, rx: 1 });
      bar.appendChild(svg('title', {}, document.createTextNode(`${p} · ${s.label}: ${v.toLocaleString()}`)));
      chart.appendChild(bar);
    });
    // Label every third hour so the axis stays readable
    if (i % 3 === 0 || i === periods.length - 1) {
      chart.appendChild(svg('text', { x: x0 + slot / 2 - 2, y: H - 10, 'text-anchor': 'middle',
        'font-size': 11, fill: 'var(--text-3)' }, document.createTextNode(p.slice(11, 16))));
    }
  });

  return el('div', {},
    el('div', { style: { overflowX: 'auto' } }, chart),
    el('div', { class: 'age-legend' }, SERIES.map((s) =>
      el('span', {}, el('i', { style: { background: s.color } }), s.label))));
}

export async function render(ctx) {
  const [head, overview, alerts, dwell, quality, hourly, shifts] = await Promise.all([
    api.get('/api/kpi/headline'),
    api.get('/api/kpi/overview'),
    api.get('/api/kpi/alerts'),
    api.get('/api/kpi/dwell', { days: 7 }),
    api.get('/api/kpi/quality'),
    api.get('/api/kpi/throughput', { bucket: 'hour' }),
    api.get('/api/kpi/shifts', { days: 5 }),
  ]);

  ctx.setSubtitle(`Live plant status · ${head.shift === 'OFF' ? 'outside shift hours' : 'Shift ' + head.shift} · updated ${new Date().toLocaleTimeString()}`);
  ctx.setTools(el('button', { class: 'btn btn-sm', onClick: () => ctx.reload() }, 'Refresh'));

  const root = el('div');

  /* Headline numbers ---------------------------------------------------- */
  root.appendChild(el('div', { class: 'stats' },
    stat('Work in progress', num(head.wip_total), { tone: 'brand', sub: 'garments on the floor' }),
    stat('Tagged today', num(head.commissioned_today), { sub: 'new garments registered' }),
    stat('Shipped today', num(head.shipped_today), { tone: 'ok', sub: 'units despatched' }),
    stat('In transit', num(head.in_transit), { tone: head.in_transit ? 'warn' : '', sub: 'between sections' }),
    stat('QC pass rate', head.qc_pass_rate_today === null ? '-' : head.qc_pass_rate_today + '%',
      { tone: head.qc_pass_rate_today === null ? '' : head.qc_pass_rate_today >= 95 ? 'ok' : 'warn',
        sub: `${num(head.qc_today)} inspected today` }),
    stat('Open rework', num(head.open_rework), { tone: head.open_rework ? 'warn' : '', sub: 'garments to correct' }),
    stat('Variances', num(head.variance_docs), { tone: head.variance_docs ? 'danger' : 'ok', sub: 'transfers not tallied' }),
    stat('Fabric in store', num(head.fabric_metres) + ' m', { sub: `${num(head.rolls_in_stock)} rolls` }),
  ));

  /* Section flow board -------------------------------------------------- */
  const flow = el('div', { class: 'flow' });
  for (const s of overview.sections) {
    flow.appendChild(el('div', {
      class: 'flow-card', style: { '--sec': s.color },
      onClick: () => go('sections', { stage: s.stage }),
    },
      el('h3', {}, s.name, s.awaiting_receipt_units
        ? chip(`${num(s.awaiting_receipt_units)} inbound`, 'warn') : null),
      el('div', { class: 'big' }, num(s.wip)),
      el('div', { class: 'unit' }, s.unit === 'PIECES' ? 'garments in section' :
        s.unit === 'ROLLS' ? 'rolls in stock' : 'bundles open'),
      el('div', { class: 'flow-meta' },
        el('div', {}, 'In today ', el('b', {}, num(s.received_today))),
        el('div', {}, 'Out today ', el('b', {}, num(s.dispatched_today))),
        el('div', {}, 'Oldest ', el('b', {}, age(s.oldest_hours))),
        el('div', {}, 'Average ', el('b', {}, age(s.avg_hours))),
        s.secondary_label ? el('div', { style: { gridColumn: '1/-1' } },
          `${s.secondary_label} `, el('b', {}, num(s.secondary))) : null,
        s.on_hold ? el('div', { style: { gridColumn: '1/-1' } }, chip(`${s.on_hold} on hold`, 'warn')) : null),
      ageBar(s.ageing)));
  }
  root.appendChild(card('Inventory in process by section',
    el('div', {},
      el('p', { class: 'hint mb' },
        'Each card shows what the section is holding right now and how long it has been there. Click a section to slice it by design, colour, size, customer, order or the batch it arrived on.'),
      flow), { tight: false }));

  /* Output over the last 24 hours --------------------------------------- */
  root.appendChild(card('Output over the last 24 hours',
    el('div', {},
      hourlyChart(hourly.rows),
      shifts.rows.length ? el('div', { class: 'mt' },
        table([
          { key: 'day', label: 'Day' },
          { key: 'shift', label: 'Shift', render: (r) => chip('Shift ' + r.shift, 'brand') },
          { key: 'commissioned', label: 'Tagged', num: true, render: (r) => num(r.commissioned) },
          { key: 'received', label: 'Received', num: true, render: (r) => num(r.received) },
          { key: 'dispatched', label: 'Dispatched', num: true, render: (r) => num(r.dispatched) },
          { key: 'qc_passed', label: 'QC passed', num: true, render: (r) => num(r.qc_passed) },
          { key: 'qc_failed', label: 'QC failed', num: true,
            render: (r) => r.qc_failed ? chip(num(r.qc_failed), 'warn') : '0' },
          { key: 'shipped', label: 'Shipped', num: true, render: (r) => num(r.shipped) },
        ], shifts.rows, { maxHeight: '240px' })) : null),
    { subtitle: 'Garments tagged, dispatched and QC-passed per hour, then the last five days by shift' }));

  /* Attention needed ---------------------------------------------------- */
  const attention = el('div', { class: 'grid-2' });

  attention.appendChild(card('Transfers needing attention',
    alerts.variance_docs.length || alerts.unreceived_docs.length
      ? el('div', {},
          alerts.variance_docs.length ? el('div', {},
            el('h4', { class: 'mb' }, 'Counts that did not tally'),
            table([
              { key: 'doc_no', label: 'Document', mono: true },
              { key: 'route', label: 'Route', render: (r) => `${stageName(r.from_stage)} → ${stageName(r.to_stage)}` },
              { key: 'expected_count', label: 'Sent', num: true },
              { key: 'received_count', label: 'Received', num: true },
              { key: 'missing_count', label: 'Missing', num: true, render: (r) => r.missing_count ? chip(String(r.missing_count), 'danger') : '0' },
              { key: 'created_at', label: 'Dispatched', render: (r) => dateTime(r.created_at) },
            ], alerts.variance_docs, { onRow: (r) => go('transfers', { doc: r.id }), maxHeight: '260px' })) : null,
          alerts.unreceived_docs.length ? el('div', { class: 'mt' },
            el('h4', { class: 'mb' }, 'Dispatched but not yet received'),
            table([
              { key: 'doc_no', label: 'Document', mono: true },
              { key: 'route', label: 'Route', render: (r) => `${stageName(r.from_stage)} → ${stageName(r.to_stage)}` },
              { key: 'expected_count', label: 'Units', num: true },
              { key: 'hours_open', label: 'Waiting', num: true, render: (r) => chip(age(r.hours_open), r.hours_open > 12 ? 'danger' : 'warn') },
            ], alerts.unreceived_docs, { onRow: (r) => go('transfers', { doc: r.id }), maxHeight: '260px' })) : null)
      : empty('Everything is tallied', 'No open variances and nothing waiting to be received.'),
    { tight: true }));

  attention.appendChild(card('Ageing work in progress',
    alerts.stale_wip.length
      ? el('div', {},
          el('p', { class: 'hint', style: { padding: '0 17px', marginTop: '14px' } },
            'Garments that have been sitting in a section for more than 24 hours.'),
          table([
            { key: 'stage', label: 'Section', render: (r) => stageName(r.stage) },
            { key: 'qty', label: 'Garments', num: true, render: (r) => num(r.qty) },
            { key: 'oldest_hours', label: 'Oldest', num: true, render: (r) => chip(age(r.oldest_hours), r.oldest_hours > 72 ? 'danger' : 'warn') },
          ], alerts.stale_wip, { onRow: (r) => go('sections', { stage: r.stage, sort: 'oldest' }) }))
      : empty('Nothing is ageing', 'No garment has been in a section for more than 24 hours.'),
    { tight: true }));

  root.appendChild(attention);

  /* Flow + quality ------------------------------------------------------ */
  const bottom = el('div', { class: 'grid-2' });

  const maxDwell = Math.max(1, ...dwell.rows.map((r) => r.avg_hours || 0));
  bottom.appendChild(card('Average time spent in each section',
    dwell.rows.length
      ? table([
          { key: 'stage', label: 'Section', render: (r) => stageName(r.stage) },
          { key: 'avg_hours', label: 'Average', num: true, render: (r) => age(r.avg_hours) },
          { key: 'graph', label: '', render: (r) => bar(((r.avg_hours || 0) / maxDwell) * 100, r.avg_hours > 24 ? 'warn' : 'ok') },
          { key: 'max_hours', label: 'Longest', num: true, render: (r) => age(r.max_hours) },
          { key: 'samples', label: 'Sampled', num: true, render: (r) => num(r.samples) },
        ], dwell.rows)
      : empty('Not enough movement history yet', 'Dwell times appear once garments have completed transfers.'),
    { subtitle: 'Measured over the last 7 days', tight: true }));

  const q = quality.overall;
  bottom.appendChild(card('Quality (last 7 days)',
    el('div', {},
      el('div', { class: 'stats', style: { marginBottom: '14px' } },
        stat('Inspections', num(q.inspections)),
        stat('Pass rate', q.pass_rate === null ? '-' : q.pass_rate + '%', { tone: q.pass_rate >= 95 ? 'ok' : 'warn' }),
        stat('First-pass yield', q.first_pass_yield === null ? '-' : q.first_pass_yield + '%',
          { tone: q.first_pass_yield >= 92 ? 'ok' : 'warn', sub: 'passed on attempt 1' }),
        stat('Failed', num(q.failed), { tone: q.failed ? 'warn' : 'ok' })),
      quality.by_style.length
        ? table([
            { key: 'style_code', label: 'Style' },
            { key: 'style_name', label: 'Design' },
            { key: 'inspections', label: 'Checked', num: true, render: (r) => num(r.inspections) },
            { key: 'failed', label: 'Failed', num: true, render: (r) => num(r.failed) },
            { key: 'fail_rate', label: 'Fail rate', num: true,
              render: (r) => chip(r.fail_rate + '%', r.fail_rate > 10 ? 'danger' : r.fail_rate > 5 ? 'warn' : 'ok') },
          ], quality.by_style, { maxHeight: '260px' })
        : empty('No inspections in this period'))));

  root.appendChild(bottom);

  if (alerts.ageing_rework.length) {
    root.appendChild(card('Retrofit jobs open more than 8 hours',
      table([
        { key: 'serial_no', label: 'Serial No', mono: true },
        { key: 'epc', label: 'Tag', mono: true },
        { key: 'opened_at', label: 'Opened', render: (r) => dateTime(r.opened_at) },
        { key: 'hours_open', label: 'Open for', num: true, render: (r) => chip(age(r.hours_open), 'warn') },
      ], alerts.ageing_rework, { onRow: () => go('retrofit') }), { tight: true }));
  }

  return root;
}
