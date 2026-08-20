/**
 * Throughput test against the target load: 125,000 garments a day across two
 * 8-hour shifts (~2.2 garments/second average, with bursts at the portals).
 *
 * Runs against the service layer so it measures the database work, not HTTP.
 * Use a scratch database so live data is not touched:
 *
 *   DATA_DIR=./data/loadtest node tools/loadtest.js 125000
 *
 * Then delete ./data/loadtest when finished.
 */
import { mkdirSync } from 'node:fs';

const TARGET = Number(process.argv[2] || 125000);
const SHIFT_SECONDS = 16 * 3600;                 // two 8-hour shifts
const REQUIRED_RATE = TARGET / SHIFT_SECONDS;

if (!process.env.DATA_DIR) {
  console.log('\nRefusing to run against the live database.');
  console.log('Re-run with a scratch directory, for example:\n');
  console.log('  DATA_DIR=./data/loadtest node tools/loadtest.js 125000\n');
  process.exit(1);
}
mkdirSync(process.env.DATA_DIR, { recursive: true });

const { db, migrate, run, get, all } = await import('../server/lib/db.js');
const { hashPassword } = await import('../server/lib/auth.js');
const Fabric = await import('../server/services/fabric.js');
const Articles = await import('../server/services/articles.js');
const Movement = await import('../server/services/movement.js');
const KPI = await import('../server/services/kpi.js');
const Reports = await import('../server/services/reports.js');

migrate();

/* ------------------------------ Fixtures -------------------------------- */
function ensure(table, cols, values, key = 'code') {
  const existing = get(`SELECT id FROM ${table} WHERE ${key} = ?`, values[cols.indexOf(key)]);
  if (existing) return existing.id;
  const res = run(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...values);
  return Number(res.lastInsertRowid);
}

let userId = get("SELECT id FROM users WHERE username = 'loadtest'")?.id;
if (!userId) {
  const { hash, salt } = hashPassword('loadtest');
  userId = Number(run(
    `INSERT INTO users(username, full_name, pass_hash, pass_salt, role) VALUES('loadtest','Load Test',?,?,'ADMIN')`,
    hash, salt).lastInsertRowid);
}
const fabricId = ensure('fabric_types', ['code', 'name'], ['LT-DNM', 'Load Test Denim']);
const colorId = ensure('colors', ['code', 'name', 'hex'], ['LT-IND', 'Load Test Indigo', '#28418c']);
const sizeId = ensure('sizes', ['code', 'name', 'sort_ord'], ['LT-32', 'Load Test 32', 1]);
const styleId = ensure('styles', ['code', 'name', 'fabric_type_id'], ['LT-STYLE', 'Load Test Jean', fabricId]);
const customerId = ensure('customers', ['code', 'name'], ['LTC', 'Load Test Customer']);
let orderId = get("SELECT id FROM orders WHERE order_no = 'LT-ORDER'")?.id;
if (!orderId) {
  orderId = Number(run(`INSERT INTO orders(order_no, customer_id) VALUES('LT-ORDER', ?)`, customerId).lastInsertRowid);
}

/* -------------------------------- Timing -------------------------------- */
const results = [];
function phase(name, units, fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const rate = units / secs;
  results.push({ name, units, secs, rate });
  console.log(`  ${name.padEnd(40)} ${units.toLocaleString().padStart(9)} in ${secs.toFixed(2).padStart(7)}s  =  ${Math.round(rate).toLocaleString().padStart(8)}/s`);
  return out;
}

const BUNDLE_SIZE = 50;
const COMMISSION_CHUNK = 1000;
const MOVE_CHUNK = 2500;

let epcCounter = Date.now() % 1e9;
const makeEpc = () => ('E2' + (epcCounter++).toString(16).toUpperCase().padStart(22, '0')).slice(0, 24);

console.log(`\nLoad test: ${TARGET.toLocaleString()} garments`);
console.log(`Target rate to clear this in a 16-hour operating day: ${REQUIRED_RATE.toFixed(2)} garments/second\n`);
console.log('Phase                                        Units        Time        Rate');
console.log('-'.repeat(78));

/* 1. Cutting: bundles for the whole run */
const bundleCount = Math.ceil(TARGET / BUNDLE_SIZE);
const cut = Fabric.createCutOrder({ orderId, styleId, colorId, plannedQty: TARGET, userId, remarks: 'Load test' });
const bundles = phase('Create cut bundles', bundleCount, () =>
  Fabric.createBundles({ cutOrderId: cut.id, userId,
    lines: [{ size_id: sizeId, bundles: bundleCount, qty_per_bundle: BUNDLE_SIZE }] }).bundles);

phase('Issue bundles to stitching', bundleCount, () => {
  for (let i = 0; i < bundles.length; i += 500) {
    Fabric.issueBundlesToStitching({ bundleIds: bundles.slice(i, i + 500).map((b) => b.id), userId });
  }
});

phase('Count bundles in at stitching', bundleCount, () => {
  for (const b of bundles) Fabric.receiveBundle({ bundleId: b.id, countedQty: BUNDLE_SIZE, userId });
});

/* 2. Stitching: tag commissioning - the highest-volume write in the system */
const allEpcs = [];
phase('Commission tags (stitching)', TARGET, () => {
  for (const b of bundles) {
    const epcs = Array.from({ length: BUNDLE_SIZE }, makeEpc);
    Articles.commissionArticles({ bundleId: b.id, epcs, userId, orderId });
    allEpcs.push(...epcs);
  }
});

/* 3. Move the whole day's output through every section */
const LEGS = [
  ['STITCHING', 'SORTING'], ['SORTING', 'WASHING'], ['WASHING', 'FINISHING'], ['FINISHING', 'QC'],
];
let current = allEpcs;
for (const [from, to] of LEGS) {
  const docs = [];
  phase(`Dispatch ${from} -> ${to}`, current.length, () => {
    for (let i = 0; i < current.length; i += MOVE_CHUNK) {
      docs.push(Movement.dispatch({ from, to, epcs: current.slice(i, i + MOVE_CHUNK), userId,
        batchRef: `LT-${to}-${i / MOVE_CHUNK}` }).doc.id);
    }
  });
  phase(`Bulk receive into ${to}`, current.length, () => {
    for (const docId of docs) {
      const epcs = all(`SELECT epc FROM doc_lines WHERE doc_id = ? AND line_state = 'EXPECTED'`, docId).map((r) => r.epc);
      Movement.receive({ docId, epcs, userId });
    }
  });
}

/* 4. Read performance on the loaded database */
console.log('-'.repeat(78));
console.log('Query performance on the loaded database:');
const timeQuery = (name, fn) => {
  const t0 = process.hrtime.bigint();
  const out = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const rows = Array.isArray(out) ? out.length : (out?.rows?.length ?? out?.sections?.length ?? 1);
  console.log(`  ${name.padEnd(46)} ${ms.toFixed(0).padStart(6)} ms   (${rows} rows)`);
  return ms;
};

timeQuery('Plant headline KPIs', () => KPI.plantHeadline());
timeQuery('Section overview with ageing', () => KPI.sectionOverview());
timeQuery('WIP grouped by style/colour/size', () => KPI.wipBreakdown({ groupBy: ['style', 'color', 'size'] }));
timeQuery('WIP grouped by receiving batch', () => KPI.wipBreakdown({ stage: 'QC', groupBy: ['batch'] }));
timeQuery('Alerts (stale WIP, variances)', () => KPI.alerts());
timeQuery('Report: articles grouped by section', () => Reports.runReport({
  dataset: 'articles', group_by: ['stage'], aggregates: [{ fn: 'COUNT', field: 'article_id', label: 'Pieces' }] }));
timeQuery('Report: 7-day event history', () => Reports.runReport({
  dataset: 'events', group_by: ['day', 'event_type'],
  aggregates: [{ fn: 'COUNT', field: 'qty', label: 'Events' }],
  filters: [{ field: 'ts', op: 'last_days', value: 7 }], limit: 500 }));
timeQuery('Single tag lookup (bench scan)', () => Articles.articleByEpc(allEpcs[Math.floor(allEpcs.length / 2)]));
timeQuery('Resolve a 2,500-tag portal read', () => Articles.resolveEpcs(allEpcs.slice(0, 2500)).found);

/* 5. Verdict */
const counts = get(`SELECT
  (SELECT COUNT(*) FROM articles) AS articles,
  (SELECT COUNT(*) FROM article_events) AS events,
  (SELECT COUNT(*) FROM movement_docs) AS docs,
  (SELECT COUNT(*) FROM doc_lines) AS lines`);

const slowest = results.reduce((a, b) => (a.rate < b.rate ? a : b));
const totalSecs = results.reduce((s, r) => s + r.secs, 0);

console.log('-'.repeat(78));
console.log(`\nDatabase now holds ${counts.articles.toLocaleString()} articles, ` +
  `${counts.events.toLocaleString()} tracking events, ${counts.docs.toLocaleString()} transfer documents, ` +
  `${counts.lines.toLocaleString()} document lines.`);
console.log(`Whole day's production processed end to end in ${(totalSecs / 60).toFixed(1)} minutes of database time.`);
console.log(`\nSlowest phase: ${slowest.name} at ${Math.round(slowest.rate).toLocaleString()} garments/second.`);
console.log(`Required sustained rate: ${REQUIRED_RATE.toFixed(2)} garments/second.`);
console.log(slowest.rate >= REQUIRED_RATE * 10
  ? `\nVERDICT: comfortable - the slowest phase runs ${Math.round(slowest.rate / REQUIRED_RATE)}x faster than required.`
  : slowest.rate >= REQUIRED_RATE
    ? `\nVERDICT: adequate, but headroom is thin (${(slowest.rate / REQUIRED_RATE).toFixed(1)}x).`
    : `\nVERDICT: too slow - ${slowest.name} cannot keep up with the required rate.`);

db.close();
