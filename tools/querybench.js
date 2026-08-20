/**
 * Times the queries that sit behind the dashboards, against whatever database
 * DATA_DIR points at. Each query runs once to warm the page cache, then five
 * more times; the best and median are reported.
 *
 *   DATA_DIR=./data/loadtest node tools/querybench.js
 */
if (!process.env.DATA_DIR) {
  console.log('Set DATA_DIR to the database you want to measure, e.g.');
  console.log('  DATA_DIR=./data/loadtest node tools/querybench.js');
  process.exit(1);
}

const { db, migrate, get } = await import('../server/lib/db.js');
migrate();

const KPI = await import('../server/services/kpi.js');
const Reports = await import('../server/services/reports.js');
const Articles = await import('../server/services/articles.js');

const counts = get(`SELECT
  (SELECT COUNT(*) FROM articles) AS articles,
  (SELECT COUNT(*) FROM article_events) AS events,
  (SELECT COUNT(*) FROM doc_lines) AS lines`);
const size = db.prepare('SELECT page_count * page_size / 1048576.0 AS mb FROM pragma_page_count(), pragma_page_size()').get();

const epcs = db.prepare('SELECT epc FROM articles LIMIT 2500').all().map((r) => r.epc);

const CASES = [
  ['Plant headline KPIs',              () => KPI.plantHeadline()],
  ['Section overview with ageing',      () => KPI.sectionOverview()],
  ['WIP by design/colour/size',         () => KPI.wipBreakdown({ groupBy: ['style', 'color', 'size'] })],
  ['WIP by receiving batch',            () => KPI.wipBreakdown({ stage: 'QC', groupBy: ['batch'] })],
  ['WIP by customer and order',         () => KPI.wipBreakdown({ groupBy: ['customer', 'order'] })],
  ['Exception alerts',                  () => KPI.alerts()],
  ['Throughput by hour (last 24h)',     () => KPI.throughput({ bucket: 'hour' })],
  ['Shift performance (7 days)',        () => KPI.shiftPerformance({ days: 7 })],
  ['Quality summary (7 days)',          () => KPI.qualitySummary()],
  ['Report: articles by section',       () => Reports.runReport({ dataset: 'articles', group_by: ['stage'],
                                            aggregates: [{ fn: 'COUNT', field: 'article_id', label: 'Pieces' }] })],
  ['Report: 7-day event history',       () => Reports.runReport({ dataset: 'events', group_by: ['day', 'event_type'],
                                            aggregates: [{ fn: 'COUNT', field: 'qty', label: 'Events' }],
                                            filters: [{ field: 'ts', op: 'last_days', value: 7 }], limit: 500 })],
  ['Report: transfer variances',        () => Reports.runReport({ dataset: 'movements',
                                            columns: ['doc_no', 'from_stage', 'to_stage', 'missing_count'],
                                            filters: [{ field: 'missing_count', op: 'gt', value: 0 }], limit: 200 })],
  ['Single tag lookup (bench scan)',    () => Articles.articleByEpc(epcs[Math.floor(epcs.length / 2)])],
  ['Resolve a 2,500-tag portal read',   () => Articles.resolveEpcs(epcs)],
];

console.log(`\nDatabase: ${counts.articles.toLocaleString()} articles, ${counts.events.toLocaleString()} events, ` +
  `${counts.lines.toLocaleString()} document lines, ${size.mb.toFixed(0)} MB\n`);
console.log('Query                                          best     median');
console.log('-'.repeat(64));

let worst = { name: '', ms: 0 };
for (const [name, fn] of CASES) {
  fn();                                    // warm the cache
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  runs.sort((a, b) => a - b);
  const best = runs[0];
  const median = runs[2];
  if (median > worst.ms) worst = { name, ms: median };
  console.log(`  ${name.padEnd(42)} ${best.toFixed(0).padStart(5)} ms ${median.toFixed(0).padStart(8)} ms`);
}

console.log('-'.repeat(64));
console.log(`Slowest: ${worst.name} at ${worst.ms.toFixed(0)} ms.`);
db.close();
