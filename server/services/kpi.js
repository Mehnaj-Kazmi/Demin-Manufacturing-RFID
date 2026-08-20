import { all, get, run, tx, nowJulian, buildFrom, localStamp } from '../lib/db.js';
import { WIP_STAGES, STAGES, SHIFT_DEFS, shiftFor } from '../lib/process.js';
import { badRequest } from '../lib/http.js';

/**
 * Section KPIs.
 *
 * The core question every supervisor asks is "what is sitting in my section, and
 * how long has it been here?" - so WIP is always reported with its ageing profile
 * and can be sliced by any dimension, including the bulk receipt it arrived on.
 */

/** Hours a row has been where it is. `now` is inlined as a constant - see nowJulian(). */
const ageHours = (col = 'a.stage_since') => `((${nowJulian()} - julianday(${col})) * 24.0)`;

/** Bucket an already-computed hours value, so julianday runs once per row, not five times. */
const bucketOf = (h) => `
  CASE
    WHEN ${h} < 2  THEN '0-2h'
    WHEN ${h} < 8  THEN '2-8h'
    WHEN ${h} < 24 THEN '8-24h'
    WHEN ${h} < 72 THEN '1-3d'
    ELSE '3d+'
  END`;

export const AGE_BUCKETS = ['0-2h', '2-8h', '8-24h', '1-3d', '3d+'];

/** Dimensions any WIP view can be grouped by. Whitelisted - never interpolated from input. */
export const GROUP_DIMS = {
  stage:     { label: 'Section',          expr: 'a.stage',            join: '' },
  style:     { label: 'Design / Style',   expr: 'st.code',            extra: 'st.name AS style_name' },
  color:     { label: 'Colour',           expr: 'cl.code',            extra: 'cl.name AS color_name, cl.hex AS color_hex' },
  size:      { label: 'Size',             expr: 'sz.code',            extra: 'sz.name AS size_name' },
  fabric:    { label: 'Fabric Type',      expr: "COALESCE(ft.code,'-')", extra: 'ft.name AS fabric_name' },
  order:     { label: 'Customer Order',   expr: "COALESCE(o.order_no,'-')" },
  customer:  { label: 'Customer',         expr: "COALESCE(cu.code,'-')", extra: 'cu.name AS customer_name' },
  batch:     { label: 'Receiving Batch',  expr: "COALESCE(md.doc_no,'(not received by batch)')",
               extra: 'md.created_at AS batch_dispatched_at, md.received_at AS batch_received_at, md.batch_ref' },
  status:    { label: 'Article Status',   expr: 'a.status' },
  qc_state:  { label: 'QC State',         expr: 'a.qc_state' },
  age:       { label: 'Age Bucket',       expr: bucketOf(ageHours()) },
  shift:     { label: 'Commissioning Shift', expr: "COALESCE(a.created_shift,'-')" },
  cut_order: { label: 'Cut Order',        expr: "COALESCE(co.cut_no,'-')" },
};

const WIP_BASE = 'FROM articles a';
const WIP_JOINS = [
  { alias: 'st', sql: 'JOIN styles st ON st.id = a.style_id' },
  { alias: 'cl', sql: 'JOIN colors cl ON cl.id = a.color_id' },
  { alias: 'sz', sql: 'JOIN sizes  sz ON sz.id = a.size_id' },
  { alias: 'ft', sql: 'LEFT JOIN fabric_types ft ON ft.id = st.fabric_type_id', needs: ['st'] },
  { alias: 'o',  sql: 'LEFT JOIN orders o        ON o.id  = a.order_id' },
  { alias: 'cu', sql: 'LEFT JOIN customers cu    ON cu.id = a.customer_id' },
  { alias: 'md', sql: 'LEFT JOIN movement_docs md ON md.id = a.arrived_doc' },
  { alias: 'co', sql: 'LEFT JOIN cut_orders co   ON co.id = a.cut_order_id' },
];

/* ------------------------------------------------------------------ */
/* Plant-level overview                                                */
/* ------------------------------------------------------------------ */
export function sectionOverview() {
  // One scan of the WIP rows, computing the age once per row and reusing it.
  const wip = all(
    `WITH w AS (
       SELECT stage, status, stage_since, ${ageHours('stage_since')} AS h
         FROM articles WHERE stage <> 'SHIPPED'
     )
     SELECT stage,
            COUNT(*) AS wip,
            SUM(CASE WHEN status = 'IN_TRANSIT' THEN 1 ELSE 0 END) AS in_transit_out,
            SUM(CASE WHEN status = 'HOLD'   THEN 1 ELSE 0 END) AS on_hold,
            SUM(CASE WHEN status = 'REWORK' THEN 1 ELSE 0 END) AS in_rework,
            ROUND(MAX(h), 1) AS oldest_hours,
            ROUND(AVG(h), 1) AS avg_hours,
            MIN(stage_since) AS oldest_since
       FROM w GROUP BY stage`);

  const buckets = all(
    `WITH w AS (
       SELECT stage, ${ageHours('stage_since')} AS h FROM articles WHERE stage <> 'SHIPPED'
     )
     SELECT stage, ${bucketOf('h')} AS bucket, COUNT(*) AS qty FROM w GROUP BY stage, bucket`);

  const inbound = all(
    `SELECT to_stage AS stage, COUNT(*) AS docs, COALESCE(SUM(expected_count - received_count), 0) AS units
       FROM movement_docs WHERE status IN ('DISPATCHED','VARIANCE') GROUP BY to_stage`);

  const today = all(
    `SELECT stage_to AS stage,
            SUM(CASE WHEN event_type = 'RECEIVE'  THEN 1 ELSE 0 END) AS received_today
       FROM article_events
      WHERE ts >= date('now','localtime') AND event_type = 'RECEIVE'
      GROUP BY stage_to`);
  const dispatchedToday = all(
    `SELECT stage_from AS stage, COUNT(*) AS dispatched_today
       FROM article_events
      WHERE ts >= date('now','localtime') AND event_type = 'DISPATCH'
      GROUP BY stage_from`);

  const wipMap = new Map(wip.map((r) => [r.stage, r]));
  const inbMap = new Map(inbound.map((r) => [r.stage, r]));
  const recMap = new Map(today.map((r) => [r.stage, r]));
  const dspMap = new Map(dispatchedToday.map((r) => [r.stage, r]));
  const bucketMap = new Map();
  for (const b of buckets) {
    if (!bucketMap.has(b.stage)) bucketMap.set(b.stage, {});
    bucketMap.get(b.stage)[b.bucket] = b.qty;
  }

  const sections = [materialSection('FABRIC_WH'), materialSection('CUTTING')];

  sections.push(...WIP_STAGES.map((code) => {
    const w = wipMap.get(code) || {};
    const ageing = bucketMap.get(code) || {};
    return {
      stage: code,
      name: STAGES[code].name,
      color: STAGES[code].color,
      seq: STAGES[code].seq,
      unit: 'PIECES',
      wip: w.wip || 0,
      in_transit_out: w.in_transit_out || 0,
      on_hold: w.on_hold || 0,
      in_rework: w.in_rework || 0,
      awaiting_receipt_docs: inbMap.get(code)?.docs || 0,
      awaiting_receipt_units: inbMap.get(code)?.units || 0,
      received_today: recMap.get(code)?.received_today || 0,
      dispatched_today: dspMap.get(code)?.dispatched_today || 0,
      oldest_hours: w.oldest_hours || 0,
      avg_hours: w.avg_hours || 0,
      oldest_since: w.oldest_since || null,
      ageing: AGE_BUCKETS.map((b) => ({ bucket: b, qty: ageing[b] || 0 })),
    };
  }));

  sections.sort((a, b) => a.seq - b.seq);
  return { sections, generated_at: new Date().toISOString(), shift: shiftFor() };
}

/**
 * Fabric warehouse and cutting hold inventory too, just not in garments.
 * They are reported in their own units so the dashboard covers every department.
 */
function materialSection(code) {
  const base = { stage: code, name: STAGES[code].name, color: STAGES[code].color, seq: STAGES[code].seq,
    in_transit_out: 0, on_hold: 0, in_rework: 0, awaiting_receipt_docs: 0, awaiting_receipt_units: 0 };

  if (code === 'FABRIC_WH') {
    const s = get(
      `SELECT COUNT(*) AS rolls, COALESCE(ROUND(SUM(remaining_m), 0), 0) AS metres,
              ROUND(MAX((${nowJulian()} - julianday(received_at)) * 24.0), 1) AS oldest_hours,
              ROUND(AVG((${nowJulian()} - julianday(received_at)) * 24.0), 1) AS avg_hours,
              MIN(received_at) AS oldest_since
         FROM fabric_rolls WHERE status IN ('IN_STOCK','PARTIAL')`);
    const ageing = all(
      `SELECT CASE
                WHEN (${nowJulian()} - julianday(received_at)) * 24.0 < 2  THEN '0-2h'
                WHEN (${nowJulian()} - julianday(received_at)) * 24.0 < 8  THEN '2-8h'
                WHEN (${nowJulian()} - julianday(received_at)) * 24.0 < 24 THEN '8-24h'
                WHEN (${nowJulian()} - julianday(received_at)) * 24.0 < 72 THEN '1-3d'
                ELSE '3d+' END AS bucket, COUNT(*) AS qty
         FROM fabric_rolls WHERE status IN ('IN_STOCK','PARTIAL') GROUP BY bucket`);
    const map = Object.fromEntries(ageing.map((r) => [r.bucket, r.qty]));
    return {
      ...base, unit: 'ROLLS', wip: s.rolls || 0,
      secondary_label: 'Metres available', secondary: s.metres || 0,
      received_today: get(`SELECT COUNT(*) AS c FROM fabric_rolls WHERE received_at >= date('now','localtime')`).c,
      dispatched_today: get(`SELECT COUNT(*) AS c FROM fabric_issues WHERE issued_at >= date('now','localtime')`).c,
      oldest_hours: s.oldest_hours || 0, avg_hours: s.avg_hours || 0, oldest_since: s.oldest_since || null,
      ageing: AGE_BUCKETS.map((b) => ({ bucket: b, qty: map[b] || 0 })),
    };
  }

  // CUTTING: bundles cut but not yet fully tagged in stitching.
  const s = get(
    `SELECT COUNT(*) AS bundles, COALESCE(SUM(qty - tagged_qty), 0) AS pieces,
            ROUND(MAX((${nowJulian()} - julianday(created_at)) * 24.0), 1) AS oldest_hours,
            ROUND(AVG((${nowJulian()} - julianday(created_at)) * 24.0), 1) AS avg_hours,
            MIN(created_at) AS oldest_since
       FROM bundles WHERE status <> 'CLOSED'`);
  const ageing = all(
    `SELECT CASE
              WHEN (${nowJulian()} - julianday(created_at)) * 24.0 < 2  THEN '0-2h'
              WHEN (${nowJulian()} - julianday(created_at)) * 24.0 < 8  THEN '2-8h'
              WHEN (${nowJulian()} - julianday(created_at)) * 24.0 < 24 THEN '8-24h'
              WHEN (${nowJulian()} - julianday(created_at)) * 24.0 < 72 THEN '1-3d'
              ELSE '3d+' END AS bucket, COUNT(*) AS qty
       FROM bundles WHERE status <> 'CLOSED' GROUP BY bucket`);
  const map = Object.fromEntries(ageing.map((r) => [r.bucket, r.qty]));
  return {
    ...base, unit: 'BUNDLES', wip: s.bundles || 0,
    secondary_label: 'Pieces awaiting tagging', secondary: s.pieces || 0,
    received_today: get(`SELECT COUNT(*) AS c FROM bundles WHERE created_at >= date('now','localtime')`).c,
    dispatched_today: get(`SELECT COUNT(*) AS c FROM bundles WHERE issued_at >= date('now','localtime')`).c,
    oldest_hours: s.oldest_hours || 0, avg_hours: s.avg_hours || 0, oldest_since: s.oldest_since || null,
    ageing: AGE_BUCKETS.map((b) => ({ bucket: b, qty: map[b] || 0 })),
  };
}

export function plantHeadline() {
  const totals = get(
    `SELECT
       (SELECT COUNT(*) FROM articles WHERE stage <> 'SHIPPED')                                        AS wip_total,
       (SELECT COUNT(*) FROM articles WHERE created_at >= date('now','localtime'))                     AS commissioned_today,
       (SELECT COUNT(*) FROM articles WHERE shipped_at >= date('now','localtime'))                      AS shipped_today,
       (SELECT COUNT(*) FROM articles WHERE status = 'IN_TRANSIT')                                      AS in_transit,
       (SELECT COUNT(*) FROM articles WHERE status = 'HOLD')                                            AS on_hold,
       (SELECT COUNT(*) FROM movement_docs WHERE status IN ('DISPATCHED','VARIANCE'))                   AS open_docs,
       (SELECT COUNT(*) FROM movement_docs WHERE status = 'VARIANCE')                                   AS variance_docs,
       (SELECT COUNT(*) FROM rework_jobs WHERE status IN ('OPEN','IN_PROGRESS'))                        AS open_rework,
       (SELECT COUNT(*) FROM qc_inspections WHERE inspected_at >= date('now','localtime'))              AS qc_today,
       (SELECT COUNT(*) FROM qc_inspections WHERE inspected_at >= date('now','localtime') AND result='FAIL') AS qc_fail_today,
       (SELECT COUNT(*) FROM fabric_rolls WHERE status IN ('IN_STOCK','PARTIAL'))                       AS rolls_in_stock,
       (SELECT COALESCE(ROUND(SUM(remaining_m),0),0) FROM fabric_rolls WHERE status IN ('IN_STOCK','PARTIAL')) AS fabric_metres`);
  totals.qc_pass_rate_today = totals.qc_today
    ? Math.round(((totals.qc_today - totals.qc_fail_today) / totals.qc_today) * 1000) / 10
    : null;
  totals.shift = shiftFor();
  return totals;
}

/* ------------------------------------------------------------------ */
/* WIP slice-and-dice                                                   */
/* ------------------------------------------------------------------ */
export function wipBreakdown({ stage = null, groupBy = ['style', 'color', 'size'], filters = {},
  sort = 'qty_desc', limit = 500 } = {}) {
  const dims = (Array.isArray(groupBy) ? groupBy : String(groupBy).split(','))
    .map((d) => d.trim()).filter(Boolean);
  if (!dims.length) throw badRequest('Choose at least one grouping');
  for (const d of dims) if (!GROUP_DIMS[d]) throw badRequest(`Unknown grouping "${d}"`);

  const where = ["a.stage <> 'SHIPPED'"];
  const params = [];
  if (stage) { where.push('a.stage = ?'); params.push(stage); }
  if (filters.customer_id) { where.push('a.customer_id = ?'); params.push(filters.customer_id); }
  if (filters.order_id)    { where.push('a.order_id = ?');    params.push(filters.order_id); }
  if (filters.style_id)    { where.push('a.style_id = ?');    params.push(filters.style_id); }
  if (filters.color_id)    { where.push('a.color_id = ?');    params.push(filters.color_id); }
  if (filters.size_id)     { where.push('a.size_id = ?');     params.push(filters.size_id); }
  if (filters.status)      { where.push('a.status = ?');      params.push(filters.status); }
  if (filters.qc_state)    { where.push('a.qc_state = ?');    params.push(filters.qc_state); }
  if (filters.arrived_doc) { where.push('a.arrived_doc = ?'); params.push(filters.arrived_doc); }
  if (filters.received_from) { where.push('a.stage_since >= ?'); params.push(filters.received_from); }
  if (filters.received_to)   { where.push('a.stage_since <= ?'); params.push(filters.received_to + ' 23:59:59'); }
  if (filters.min_age_hours) { where.push(`${ageHours()} >= ?`); params.push(Number(filters.min_age_hours)); }

  const selects = dims.map((d, i) => `${GROUP_DIMS[d].expr} AS g${i}`);
  const extras = dims.flatMap((d) => (GROUP_DIMS[d].extra ? [GROUP_DIMS[d].extra] : []));
  const groupExprs = dims.map((d) => GROUP_DIMS[d].expr);

  const ORDER = {
    qty_desc: 'qty DESC',
    qty_asc: 'qty ASC',
    oldest: 'oldest_since ASC',
    newest: 'oldest_since DESC',
    age_desc: 'max_age_hours DESC',
    label: groupExprs.map((_, i) => `g${i}`).join(', '),
  };
  const orderBy = ORDER[sort] || ORDER.qty_desc;

  // Only join the tables this particular breakdown actually references.
  const usedExprs = [...selects, ...extras, ...groupExprs, ...where];
  const from = buildFrom(WIP_BASE, WIP_JOINS, usedExprs);
  const age = ageHours();

  const rows = all(
    `SELECT ${selects.join(', ')}${extras.length ? ', ' + extras.join(', ') : ''},
            COUNT(*) AS qty,
            SUM(CASE WHEN a.status = 'IN_TRANSIT' THEN 1 ELSE 0 END) AS in_transit,
            SUM(CASE WHEN a.status = 'HOLD' THEN 1 ELSE 0 END) AS on_hold,
            ROUND(MAX(${age}), 1) AS max_age_hours,
            ROUND(AVG(${age}), 1) AS avg_age_hours,
            MIN(a.stage_since) AS oldest_since,
            MAX(a.stage_since) AS newest_since
       ${from}
      WHERE ${where.join(' AND ')}
      GROUP BY ${groupExprs.join(', ')}${extras.length ? ', ' + extras.map((e) => e.split(' AS ')[0]).join(', ') : ''}
      ORDER BY ${orderBy}
      LIMIT ?`, ...params, Math.min(limit, 5000));

  const totalsFrom = buildFrom(WIP_BASE, WIP_JOINS, where);
  const totals = get(
    `SELECT COUNT(*) AS qty, ROUND(AVG(${age}),1) AS avg_age_hours, ROUND(MAX(${age}),1) AS max_age_hours
       ${totalsFrom} WHERE ${where.join(' AND ')}`, ...params);

  return {
    group_by: dims,
    labels: dims.map((d) => GROUP_DIMS[d].label),
    rows: rows.map((r) => {
      const key = dims.map((_, i) => r[`g${i}`]);
      return { ...r, key, label: key.join(' / ') };
    }),
    totals,
  };
}

/** The bulk receipts a section has taken in, newest first - "what came in when". */
export function receiptsInto(stage, { limit = 100, from = null, to = null } = {}) {
  const where = ['d.to_stage = ?'];
  const params = [stage];
  if (from) { where.push('d.received_at >= ?'); params.push(from); }
  if (to)   { where.push('d.received_at <= ?'); params.push(to + ' 23:59:59'); }
  return all(
    `SELECT d.id, d.doc_no, d.from_stage, d.status, d.batch_ref, d.group_key,
            d.expected_count, d.received_count, d.missing_count, d.extra_count,
            d.created_at AS dispatched_at, d.received_at,
            uc.full_name AS dispatched_by, ur.full_name AS received_by,
            (SELECT COUNT(*) FROM articles a WHERE a.arrived_doc = d.id AND a.stage = d.to_stage) AS still_here,
            ROUND((${nowJulian()} - julianday(d.received_at)) * 24.0, 1) AS hours_since_receipt
       FROM movement_docs d
       LEFT JOIN users uc ON uc.id = d.created_by
       LEFT JOIN users ur ON ur.id = d.received_by
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(d.received_at, d.created_at) DESC
      LIMIT ?`, ...params, Math.min(limit, 500));
}

/* ------------------------------------------------------------------ */
/* Throughput & flow                                                    */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Event rollup                                                        */
/* ------------------------------------------------------------------ */

/**
 * Bring the hourly rollup up to date.
 *
 * article_events is append-only, so everything above the stored watermark is
 * new and can be folded in without re-reading history. The first call on an
 * existing database backfills; after that each call handles only what has
 * happened since.
 */
export function refreshRollup() {
  return tx(() => {
    const mark = get("SELECT value FROM counters WHERE name = 'event_rollup'")?.value ?? 0;
    const maxId = get('SELECT COALESCE(MAX(id), 0) AS m FROM article_events').m;
    if (maxId <= mark) return { added: 0, watermark: mark };

    run(
      `INSERT INTO event_rollup(period, day, shift_code, event_type, stage_from, stage_to, qty)
       SELECT substr(ts, 1, 13) || ':00', substr(ts, 1, 10), COALESCE(shift_code, '-'),
              event_type, COALESCE(stage_from, '-'), COALESCE(stage_to, '-'), COUNT(*)
         FROM article_events
        WHERE id > ? AND id <= ?
        GROUP BY 1, 2, 3, 4, 5, 6
       ON CONFLICT(period, shift_code, event_type, stage_from, stage_to)
       DO UPDATE SET qty = qty + excluded.qty`, mark, maxId);

    run(`INSERT INTO counters(name, period, value) VALUES('event_rollup', '-', ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`, maxId);
    return { added: maxId - mark, watermark: maxId };
  });
}

export function throughput({ from = null, to = null, bucket = 'hour', stage = null } = {}) {
  refreshRollup();
  const period = bucket === 'hour' ? 'period' : 'day';
  const where = [];
  const params = [];
  if (from) { where.push('day >= ?'); params.push(from); }
  if (to)   { where.push('day <= ?'); params.push(to); }
  if (!from && !to) {
    where.push('period >= ?');
    params.push(localStamp(new Date(Date.now() - 24 * 3600_000)).slice(0, 13) + ':00');
  }
  if (stage) { where.push('(stage_from = ? OR stage_to = ?)'); params.push(stage, stage); }
  where.push(`event_type IN ('COMMISSION','RECEIVE','DISPATCH','QC_PASS','QC_FAIL','SHIP')`);

  return all(
    `SELECT ${period} AS period,
            ${bucket === 'shift' ? 'shift_code AS shift,' : ''}
            event_type,
            CASE WHEN stage_to <> '-' THEN stage_to ELSE stage_from END AS stage,
            SUM(qty) AS qty
       FROM event_rollup
      WHERE ${where.join(' AND ')}
      GROUP BY ${period}${bucket === 'shift' ? ', shift_code' : ''}, event_type, stage
      ORDER BY period`, ...params);
}

/**
 * Average dwell time per section, measured from arrival to departure events.
 * Sampled rather than exhaustive: a few thousand recent journeys give a stable
 * average without walking every event in the window.
 */
export function dwellTimes({ days = 7, sample = 20000 } = {}) {
  const since = localStamp(new Date(Date.now() - Math.min(Number(days) || 7, 90) * 86400_000));
  return all(
    `WITH arrivals AS (
       SELECT id, article_id, stage_to AS stage, ts
         FROM article_events
        WHERE event_type IN ('RECEIVE','COMMISSION') AND ts >= ? AND stage_to IS NOT NULL
        ORDER BY id DESC LIMIT ?
     ),
     moves AS (
       SELECT a.stage,
              (SELECT MIN(e2.ts) FROM article_events e2
                WHERE e2.article_id = a.article_id AND e2.id > a.id
                  AND e2.event_type IN ('DISPATCH','SHIP')) AS left_at,
              a.ts AS arrived
         FROM arrivals a
     )
     SELECT stage,
            COUNT(*) AS samples,
            ROUND(AVG((julianday(left_at) - julianday(arrived)) * 24.0), 2) AS avg_hours,
            ROUND(MIN((julianday(left_at) - julianday(arrived)) * 24.0), 2) AS min_hours,
            ROUND(MAX((julianday(left_at) - julianday(arrived)) * 24.0), 2) AS max_hours
       FROM moves
      WHERE left_at IS NOT NULL
      GROUP BY stage
      ORDER BY avg_hours DESC`, since, Math.min(Number(sample) || 20000, 200000));
}

export function shiftPerformance({ date = null, days = 7 } = {}) {
  refreshRollup();
  const where = ["shift_code <> '-'"];
  const params = [];
  if (date) { where.push('day = ?'); params.push(date); }
  else {
    where.push('day >= ?');
    params.push(localStamp(new Date(Date.now() - Math.min(Number(days) || 7, 90) * 86400_000)).slice(0, 10));
  }
  return all(
    `SELECT day, shift_code AS shift,
            SUM(CASE WHEN event_type = 'COMMISSION' THEN qty ELSE 0 END) AS commissioned,
            SUM(CASE WHEN event_type = 'RECEIVE'    THEN qty ELSE 0 END) AS received,
            SUM(CASE WHEN event_type = 'DISPATCH'   THEN qty ELSE 0 END) AS dispatched,
            SUM(CASE WHEN event_type = 'QC_PASS'    THEN qty ELSE 0 END) AS qc_passed,
            SUM(CASE WHEN event_type = 'QC_FAIL'    THEN qty ELSE 0 END) AS qc_failed,
            SUM(CASE WHEN event_type = 'SHIP'       THEN qty ELSE 0 END) AS shipped
       FROM event_rollup
      WHERE ${where.join(' AND ')}
      GROUP BY day, shift_code
      ORDER BY day DESC, shift_code`, ...params);
}

export function operatorProductivity({ from = null, to = null, stage = null, limit = 50 } = {}) {
  const where = ['e.user_id IS NOT NULL'];
  const params = [];
  if (from) { where.push('e.ts >= ?'); params.push(from); }
  if (to)   { where.push('e.ts <= ?'); params.push(to + ' 23:59:59'); }
  if (!from && !to) where.push("e.ts >= date('now','localtime')");
  if (stage) { where.push('(e.stage_from = ? OR e.stage_to = ?)'); params.push(stage, stage); }
  return all(
    `SELECT u.id, u.username, u.full_name, u.role, u.section,
            COUNT(*) AS actions,
            SUM(CASE WHEN e.event_type = 'COMMISSION' THEN 1 ELSE 0 END) AS tagged,
            SUM(CASE WHEN e.event_type = 'RECEIVE'    THEN 1 ELSE 0 END) AS received,
            SUM(CASE WHEN e.event_type = 'DISPATCH'   THEN 1 ELSE 0 END) AS dispatched,
            SUM(CASE WHEN e.event_type IN ('QC_PASS','QC_FAIL') THEN 1 ELSE 0 END) AS inspected,
            SUM(CASE WHEN e.event_type = 'REWORK_DONE' THEN 1 ELSE 0 END) AS reworked,
            MIN(e.ts) AS first_action, MAX(e.ts) AS last_action
       FROM article_events e JOIN users u ON u.id = e.user_id
      WHERE ${where.join(' AND ')}
      GROUP BY u.id, u.username, u.full_name, u.role, u.section
      ORDER BY actions DESC LIMIT ?`, ...params, Math.min(limit, 200));
}

/* ------------------------------------------------------------------ */
/* Quality                                                              */
/* ------------------------------------------------------------------ */
export function qualitySummary({ from = null, to = null } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('q.inspected_at >= ?'); params.push(from); }
  if (to)   { where.push('q.inspected_at <= ?'); params.push(to + ' 23:59:59'); }
  if (!from && !to) where.push("q.inspected_at >= datetime('now','localtime','-7 days')");
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const overall = get(
    `SELECT COUNT(*) AS inspections,
            SUM(CASE WHEN q.result = 'PASS' THEN 1 ELSE 0 END) AS passed,
            SUM(CASE WHEN q.result = 'FAIL' THEN 1 ELSE 0 END) AS failed,
            COUNT(DISTINCT q.article_id) AS articles
       FROM qc_inspections q ${w}`, ...params);
  overall.pass_rate = overall.inspections ? Math.round((overall.passed / overall.inspections) * 1000) / 10 : null;

  const firstPass = get(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN result = 'PASS' THEN 1 ELSE 0 END) AS ok
       FROM qc_inspections q ${w}${w ? ' AND' : 'WHERE'} q.attempt = 1`, ...params);
  overall.first_pass_yield = firstPass.n ? Math.round((firstPass.ok / firstPass.n) * 1000) / 10 : null;

  const byStyle = all(
    `SELECT st.code AS style_code, st.name AS style_name,
            COUNT(*) AS inspections,
            SUM(CASE WHEN q.result = 'FAIL' THEN 1 ELSE 0 END) AS failed,
            ROUND(100.0 * SUM(CASE WHEN q.result = 'FAIL' THEN 1 ELSE 0 END) / COUNT(*), 1) AS fail_rate
       FROM qc_inspections q
       JOIN articles a ON a.id = q.article_id
       JOIN styles st ON st.id = a.style_id
       ${w}
      GROUP BY st.code, st.name ORDER BY failed DESC LIMIT 20`, ...params);

  const byInspector = all(
    `SELECT u.full_name, u.username, COUNT(*) AS inspections,
            SUM(CASE WHEN q.result = 'FAIL' THEN 1 ELSE 0 END) AS failed,
            ROUND(100.0 * SUM(CASE WHEN q.result = 'FAIL' THEN 1 ELSE 0 END) / COUNT(*), 1) AS fail_rate
       FROM qc_inspections q JOIN users u ON u.id = q.inspector_id
       ${w}
      GROUP BY u.full_name, u.username ORDER BY inspections DESC LIMIT 30`, ...params);

  const trend = all(
    `SELECT substr(q.inspected_at, 1, 10) AS day, COUNT(*) AS inspections,
            SUM(CASE WHEN q.result = 'FAIL' THEN 1 ELSE 0 END) AS failed,
            ROUND(100.0 * SUM(CASE WHEN q.result = 'PASS' THEN 1 ELSE 0 END) / COUNT(*), 1) AS pass_rate
       FROM qc_inspections q ${w} GROUP BY day ORDER BY day`, ...params);

  return { overall, by_style: byStyle, by_inspector: byInspector, trend };
}

/* ------------------------------------------------------------------ */
/* Exceptions worth a supervisor's attention                            */
/* ------------------------------------------------------------------ */
export function alerts() {
  const stale = all(
    `WITH w AS (
       SELECT stage, ${ageHours('stage_since')} AS h FROM articles
        WHERE stage <> 'SHIPPED' AND status <> 'IN_TRANSIT'
     )
     SELECT stage, COUNT(*) AS qty, ROUND(MAX(h),1) AS oldest_hours
       FROM w WHERE h > 24 GROUP BY stage ORDER BY qty DESC`);
  const variances = all(
    `SELECT id, doc_no, from_stage, to_stage, expected_count, received_count, missing_count, extra_count, created_at
       FROM movement_docs WHERE status = 'VARIANCE' ORDER BY created_at DESC LIMIT 25`);
  const unreceived = all(
    `SELECT id, doc_no, from_stage, to_stage, expected_count, created_at,
            ROUND((${nowJulian()} - julianday(created_at)) * 24.0, 1) AS hours_open
       FROM movement_docs
      WHERE status = 'DISPATCHED' AND created_at < datetime('now','localtime','-4 hours')
      ORDER BY created_at LIMIT 25`);
  const held = get(`SELECT COUNT(*) AS c FROM articles WHERE status = 'HOLD'`).c;
  const scrapped = get(`SELECT COUNT(*) AS c FROM articles WHERE status = 'SCRAP'`).c;
  const oldRework = all(
    `SELECT r.id, a.serial_no, a.epc, r.opened_at,
            ROUND((${nowJulian()} - julianday(r.opened_at)) * 24.0, 1) AS hours_open
       FROM rework_jobs r JOIN articles a ON a.id = r.article_id
      WHERE r.status IN ('OPEN','IN_PROGRESS') AND r.opened_at < datetime('now','localtime','-8 hours')
      ORDER BY r.opened_at LIMIT 25`);
  return { stale_wip: stale, variance_docs: variances, unreceived_docs: unreceived,
    on_hold: held, scrapped, ageing_rework: oldRework };
}

export function shiftDefs() { return SHIFT_DEFS; }
