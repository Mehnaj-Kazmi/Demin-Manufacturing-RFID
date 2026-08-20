/**
 * End-to-end API smoke test. Exercises the full garment journey over HTTP
 * exactly as the stations do, then checks KPIs and the report builder.
 *
 *   node tools/apitest.js [baseUrl]
 */
const BASE = process.argv[2] || 'http://localhost:8080';

let token = null;
let pass = 0, fail = 0;

async function call(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token && !opts.noAuth) headers.Authorization = `Bearer ${token}`;
  if (opts.readerKey) headers['X-Reader-Key'] = opts.readerKey;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

function check(name, cond, info) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${info ? '  ->  ' + JSON.stringify(info).slice(0, 400) : ''}`); }
}

function section(t) { console.log(`\n--- ${t} ---`); }

const asUser = async (username, password) => {
  const r = await call('POST', '/api/auth/login', { username, password }, { noAuth: true });
  if (r.status !== 200) throw new Error(`login failed for ${username}: ${JSON.stringify(r.data)}`);
  token = r.data.token;
  return r.data;
};

const run = async () => {
  section('Authentication & permissions');
  const bad = await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' }, { noAuth: true });
  check('wrong password is rejected', bad.status === 401, bad.data);

  const me = await asUser('admin', 'admin123');
  check('admin can sign in', !!token && me.user.role === 'ADMIN');

  const noauth = await call('GET', '/api/kpi/headline', undefined, { noAuth: true });
  check('unauthenticated request is refused', noauth.status === 401);

  await asUser('qc1', 'qc123');
  const denied = await call('POST', '/api/masters/colors', { code: 'XX', name: 'Nope' });
  check('QC inspector cannot edit master data', denied.status === 403, denied.data);

  section('Master data & metadata');
  await asUser('admin', 'admin123');
  const meta = await call('GET', '/api/meta');
  check('metadata lists all sections', meta.data.stages.length === 10, meta.data.stages?.length);
  const styles = await call('GET', '/api/masters/styles');
  check('styles are seeded', styles.data.rows.length >= 5);

  section('Fabric warehouse -> cutting');
  await asUser('store.sup', 'store123');
  const grn = await call('POST', '/api/fabric/grn', {
    supplier: 'API Test Mills', invoice_ref: 'INV-API-1',
    rolls: [{ fabric_type_id: styles.data.rows[0].fabric_type_id, color_id: 1, length_m: 500, shade_batch: 'API-1' }],
  });
  check('GRN created', grn.status === 201 && grn.data.count === 1, grn.data);

  const badRoll = await call('POST', '/api/fabric/grn', {
    supplier: 'API Test Mills', rolls: [{ fabric_type_id: 1, color_id: 1, length_m: 0 }] });
  check('zero-length roll is rejected', badRoll.status === 400, badRoll.data);

  await asUser('cut.sup', 'cut123');
  const cut = await call('POST', '/api/cutting/orders', {
    style_id: styles.data.rows[0].id, color_id: 1, planned_qty: 120, remarks: 'API test lay' });
  check('cut order created', cut.status === 201, cut.data);
  const cutId = cut.data.cut_order.id;

  await asUser('store.sup', 'store123');
  const issue = await call('POST', `/api/cutting/orders/${cutId}/issue`, {
    rolls: [{ roll_id: grn.data.rolls[0].id, issued_m: 400 }] });
  check('rolls issued to cutting', issue.status === 200, issue.data);

  const over = await call('POST', `/api/cutting/orders/${cutId}/issue`, {
    rolls: [{ roll_id: grn.data.rolls[0].id, issued_m: 9999 }] });
  check('over-issue beyond remaining metres is blocked', over.status === 409, over.data);

  await asUser('cut.sup', 'cut123');
  const bundles = await call('POST', `/api/cutting/orders/${cutId}/bundles`, {
    lines: [{ size_id: 3, bundles: 2, qty_per_bundle: 25 }] });
  check('bundles created', bundles.status === 201 && bundles.data.total_qty === 50, bundles.data);
  const bundleIds = bundles.data.bundles.map((b) => b.id);
  await call('POST', '/api/cutting/bundles/issue', { bundle_ids: bundleIds });

  section('Stitching: manual count then tag commissioning');
  await asUser('stitch.op1', 'op123');
  const recvB = await call('POST', `/api/stitching/bundles/${bundleIds[0]}/receive`, { counted_qty: 24 });
  check('manual count variance is recorded', recvB.data.variance === -1 && recvB.data.matched === false, recvB.data);
  await call('POST', `/api/stitching/bundles/${bundleIds[1]}/receive`, { counted_qty: 25 });

  const sim = await call('POST', '/api/sim/tags', { count: 49 });
  check('tag simulator issues unique EPCs', sim.data.count === 49);
  const tagsA = sim.data.epcs.slice(0, 24);
  const tagsB = sim.data.epcs.slice(24, 49);

  const comm = await call('POST', '/api/stitching/commission', { bundle_id: bundleIds[0], epcs: tagsA });
  check('articles commissioned', comm.status === 201 && comm.data.count === 24, comm.data);

  const dupe = await call('POST', '/api/stitching/commission', { bundle_id: bundleIds[1], epcs: [tagsA[0]] });
  check('re-using a live tag is refused', dupe.status === 409, dupe.data);

  const overTag = await call('POST', '/api/stitching/commission', { bundle_id: bundleIds[0], epcs: sim.data.epcs.slice(0, 1) });
  check('tagging beyond the bundle count is refused', overTag.status === 409, overTag.data);

  await call('POST', '/api/stitching/commission', { bundle_id: bundleIds[1], epcs: tagsB });
  const allTags = [...tagsA, ...tagsB];

  section('Transfers: dispatch, bulk receive, tally');
  const wrongRoute = await call('POST', '/api/movements/dispatch', { from: 'STITCHING', to: 'QC', epcs: allTags });
  check('an illegal section-to-section move is refused', wrongRoute.status === 400, wrongRoute.data);

  const disp1 = await call('POST', '/api/movements/dispatch', {
    from: 'STITCHING', to: 'SORTING', epcs: allTags, batch_ref: 'API-BATCH-1' });
  check('dispatch document generated', disp1.status === 201 && disp1.data.accepted === 49, disp1.data);
  const doc1 = disp1.data.doc.id;

  const twice = await call('POST', '/api/movements/dispatch', { from: 'STITCHING', to: 'SORTING', epcs: [allTags[0]] });
  check('dispatching an in-transit article is refused', twice.status === 409, twice.data);

  await asUser('sort.op1', 'op123');
  const short = await call('POST', `/api/movements/${doc1}/receive`, { epcs: allTags.slice(0, 47) });
  check('short receipt is flagged as a variance', short.data.doc.status === 'VARIANCE' && short.data.tally.missing === 2, short.data.tally);
  check('missing pieces are listed by serial', short.data.missing_articles.length === 2);

  const rest = await call('POST', `/api/movements/${doc1}/receive`, { epcs: allTags.slice(47) });
  check('second pass clears the variance', rest.data.doc.status === 'RECEIVED' && rest.data.tally.missing === 0, rest.data.tally);

  const printed = await fetch(`${BASE}/api/movements/${doc1}/print`, { headers: { Authorization: `Bearer ${token}` } });
  const html = await printed.text();
  check('transfer note prints as HTML', printed.status === 200 && html.includes('TRANSFER &amp; RECEIPT NOTE'));

  section('Sorting station');
  const sess = await call('POST', '/api/sorting/sessions', { stage: 'SORTING', group_by: ['style', 'color', 'size'] });
  check('sorting session opened', sess.status === 201, sess.data);
  const reads = await call('POST', `/api/sorting/sessions/${sess.data.session.id}/read`, { epcs: allTags });
  check('bulk read grouped into buckets', reads.data.buckets.length >= 1, reads.data.buckets);
  const bucket = reads.data.buckets[0];

  const sortDisp = await call('POST', `/api/sorting/sessions/${sess.data.session.id}/dispatch`, {
    bucket_key: bucket.bucket_key, to: 'WASHING', batch_ref: 'API-WASH-1', wash_recipe: 'Stone wash 45 min' });
  check('bucket dispatched to washing', sortDisp.status === 201 && sortDisp.data.accepted === bucket.qty, sortDisp.data.accepted);

  section('Wash -> finishing -> QC');
  await asUser('wash.op1', 'op123');
  const washDoc = sortDisp.data.doc.id;
  const washEpcs = (await call('GET', `/api/sim/doc/${washDoc}`)).data.epcs;
  const washRecv = await call('POST', `/api/movements/${washDoc}/receive`, { epcs: washEpcs });
  check('wash receives the full batch', washRecv.data.tally.matched === true, washRecv.data.tally);

  await asUser('wash.sup', 'wash123');
  const d2 = await call('POST', '/api/movements/dispatch', { from: 'WASHING', to: 'FINISHING', epcs: washEpcs, batch_ref: 'API-FIN-1' });
  await asUser('finish.sup', 'finish123');
  await call('POST', `/api/movements/${d2.data.doc.id}/receive`, { epcs: washEpcs });
  const d3 = await call('POST', '/api/movements/dispatch', { from: 'FINISHING', to: 'QC', epcs: washEpcs, batch_ref: 'API-QC-1' });
  await asUser('qc1', 'qc123');
  const qcRecv = await call('POST', `/api/movements/${d3.data.doc.id}/receive`, { epcs: washEpcs });
  check('QC receives the finished batch', qcRecv.data.tally.matched === true, qcRecv.data.tally);

  section('QC, defect map and retrofitting');
  const defects = await call('GET', '/api/masters/defect_codes');
  const defectId = defects.data.rows[0].id;

  const failNoReason = await call('POST', '/api/qc/inspect', { epc: washEpcs[0], result: 'FAIL', defects: [] });
  check('a QC failure without a reason is refused', failNoReason.status === 400, failNoReason.data);

  const failed = await call('POST', '/api/qc/inspect', {
    epc: washEpcs[0], result: 'FAIL', remarks: 'API test failure',
    defects: [{ defect_code_id: defectId, view: 'FRONT', pos_x: 0.42, pos_y: 0.63, note: 'Left knee' }] });
  check('QC failure recorded with a positioned defect', failed.status === 201
    && failed.data.inspection.defects[0].pos_x === 0.42, failed.data.inspection?.defects);
  check('failed article moves to REWORK', failed.data.article.status === 'REWORK' && failed.data.article.qc_state === 'FAIL');

  const batchPass = await call('POST', '/api/qc/batch-pass', { epcs: washEpcs.slice(1) });
  check('bulk QC pass processes the rest', batchPass.data.passed === washEpcs.length - 1, batchPass.data);

  const toRetro = await call('POST', '/api/movements/dispatch', { from: 'QC', to: 'RETROFIT', epcs: [washEpcs[0]] });
  await asUser('retro.op1', 'op123');
  await call('POST', `/api/movements/${toRetro.data.doc.id}/receive`, { epcs: [washEpcs[0]] });

  const scan = await call('GET', `/api/rework/scan/${washEpcs[0]}`);
  check('retrofit scan pops up the defect file', scan.data.open_defects.length === 1
    && scan.data.article.style_code, scan.data.open_defects);
  check('retrofit scan returns the design image for the defect map', !!scan.data.article.image_front);

  const artId = scan.data.article.id;
  const noAction = await call('POST', `/api/rework/${artId}/complete`, {});
  check('rework completion requires a description', noAction.status === 400, noAction.data);

  const done = await call('POST', `/api/rework/${artId}/complete`, { action_taken: 'Re-stitched left knee seam' });
  check('rework closes and resolves the defect', done.data.open_defects.length === 0 && done.data.article.qc_state === 'REWORKED', done.data.article);

  const backToQc = await call('POST', '/api/movements/dispatch', { from: 'RETROFIT', to: 'QC', epcs: [washEpcs[0]] });
  await asUser('qc1', 'qc123');
  await call('POST', `/api/movements/${backToQc.data.doc.id}/receive`, { epcs: [washEpcs[0]] });
  const rePass = await call('POST', '/api/qc/inspect', { epc: washEpcs[0], result: 'PASS', remarks: 'Correction verified' });
  check('re-inspection passes', rePass.data.article.qc_state === 'PASS' && rePass.data.inspection.attempt === 2, rePass.data.inspection);

  section('Dispatch: tag swap and shipping');
  const toDispatch = await call('POST', '/api/movements/dispatch', {
    from: 'QC', to: 'DISPATCH', epcs: washEpcs, require_qc_pass: true });
  check('only QC-passed goods reach dispatch', toDispatch.data.accepted === washEpcs.length, toDispatch.data);
  await asUser('disp.sup', 'disp123');
  await call('POST', `/api/movements/${toDispatch.data.doc.id}/receive`, { epcs: washEpcs });

  const ship = await call('POST', '/api/dispatch/shipments', { customer_id: 1, carrier: 'API Carrier' });
  const custTags = (await call('POST', '/api/sim/tags', { count: washEpcs.length, prefix: 'C001' })).data.epcs;
  const swapped = await call('POST', `/api/dispatch/shipments/${ship.data.shipment.id}/swap`, {
    pairs: washEpcs.map((e, i) => ({ tracking_epc: e, customer_epc: custTags[i], carton_no: 'CTN-API-1' })) });
  check('tracking tags swapped for customer tags', swapped.data.swapped === washEpcs.length, swapped.data.failed);

  const oldTag = await call('GET', `/api/articles/by-epc/${washEpcs[0]}`);
  check('the removed tracking tag no longer resolves', oldTag.status === 404, oldTag.data);
  const newTag = await call('GET', `/api/articles/by-epc/${custTags[0]}`);
  check('the customer tag resolves to the same garment', newTag.status === 200
    && newTag.data.article.final_tag_epc === custTags[0]);
  check('full history is preserved through the tag change', newTag.data.history.length >= 8, newTag.data.history?.length);

  const shipped = await call('POST', `/api/dispatch/shipments/${ship.data.shipment.id}/ship`, {});
  check('shipment despatched', shipped.data.shipped === washEpcs.length, shipped.data);

  section('KPIs');
  await asUser('pmanager', 'manager123');
  const head = await call('GET', '/api/kpi/headline');
  check('headline KPIs returned', head.data.wip_total >= 0 && head.data.commissioned_today > 0, head.data);
  const overview = await call('GET', '/api/kpi/overview');
  check('every WIP section reports', overview.data.sections.length === 9, overview.data.sections?.length);
  check('sections carry an ageing profile', overview.data.sections[0].ageing.length === 5);

  const wipByCustomer = await call('POST', '/api/kpi/wip', { group_by: ['customer', 'size'], sort: 'qty_desc' });
  check('WIP can be grouped by customer and size', wipByCustomer.data.rows.length > 0, wipByCustomer.data.totals);
  const wipByBatch = await call('POST', '/api/kpi/wip', { stage: 'QC', group_by: ['batch'] });
  check('WIP can be grouped by the batch it arrived on', Array.isArray(wipByBatch.data.rows), wipByBatch.data);
  const badGroup = await call('POST', '/api/kpi/wip', { group_by: ['; DROP TABLE articles'] });
  check('an unknown grouping is rejected', badGroup.status === 400, badGroup.data);

  const receipts = await call('GET', '/api/kpi/receipts/QC');
  check('receipts into a section are listed with times', Array.isArray(receipts.data.rows));
  const quality = await call('GET', '/api/kpi/quality');
  check('quality summary computes pass rate', quality.data.overall.pass_rate !== null, quality.data.overall);
  const alerts = await call('GET', '/api/kpi/alerts');
  check('alerts surface open variances', Array.isArray(alerts.data.variance_docs));

  section('Report builder');
  const cat = await call('GET', '/api/reports/catalogue');
  check('report catalogue exposes datasets', cat.data.datasets.length >= 7, cat.data.datasets?.length);

  const rep = await call('POST', '/api/reports/run', {
    dataset: 'articles', group_by: ['stage', 'customer_name'],
    aggregates: [{ fn: 'COUNT', field: 'article_id', label: 'Pieces' }],
    filters: [{ field: 'stage', op: 'ne', value: 'SHIPPED' }], limit: 100 });
  check('grouped report runs', rep.status === 200 && rep.data.columns.length === 3, rep.data.columns);

  const detail = await call('POST', '/api/reports/run', {
    dataset: 'qc', columns: ['inspected_at', 'serial_no', 'result', 'defect_name'],
    filters: [{ field: 'result', op: 'eq', value: 'FAIL' }], sort: [{ field: 'inspected_at', dir: 'desc' }], limit: 10 });
  check('detail report runs with filters and sorting', detail.data.rows.length > 0, detail.data.row_count);

  const injection = await call('POST', '/api/reports/run', {
    dataset: 'articles', columns: ['stage'], filters: [{ field: "1=1; DROP TABLE articles;--", op: 'eq', value: 'x' }] });
  check('an injected field name is rejected', injection.status === 400, injection.data);

  const badAgg = await call('POST', '/api/reports/run', {
    dataset: 'articles', group_by: ['stage'], aggregates: [{ fn: 'SUM', field: 'serial_no' }] });
  check('summing a text field is rejected', badAgg.status === 400, badAgg.data);

  const csv = await fetch(`${BASE}/api/reports/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ dataset: 'articles', columns: ['serial_no', 'stage'], limit: 5, name: 'apitest' }) });
  const csvText = await csv.text();
  check('report exports as CSV', csv.status === 200 && csvText.includes('Serial No'), csvText.slice(0, 80));

  const saved = await call('POST', '/api/reports/saved', {
    name: 'API test report', dataset: 'articles',
    definition: { group_by: ['stage'], aggregates: [{ fn: 'COUNT', field: 'article_id', label: 'Pieces' }] } });
  check('report definition saved', saved.status === 200 && saved.data.report.id, saved.data);
  await call('DELETE', `/api/reports/saved/${saved.data.report.id}`);

  section('Reader gateway');
  await asUser('admin', 'admin123');
  const readers = await call('GET', '/api/admin/readers');
  const rdr = readers.data.rows.find((r) => r.section === 'QC');
  const key = await call('POST', `/api/admin/readers/${rdr.id}/key`, {});
  check('reader API key issued', !!key.data.api_key);

  const ping = await call('GET', '/api/gateway/ping', undefined, { noAuth: true, readerKey: key.data.api_key });
  check('reader authenticates with its key', ping.status === 200 && ping.data.reader.code === rdr.code, ping.data);
  const noKey = await call('GET', '/api/gateway/ping', undefined, { noAuth: true, readerKey: 'nope' });
  check('an invalid reader key is refused', noKey.status === 403);

  const gw = await call('POST', '/api/gateway/reads', { epcs: custTags.slice(0, 3) },
    { noAuth: true, readerKey: key.data.api_key });
  check('gateway resolves a raw tag stream', gw.data.resolved === 3, gw.data);

  section('Audit trail');
  const audit = await call('GET', '/api/admin/audit', undefined);
  check('audit log records who did what', audit.data.rows.length > 20, audit.data.rows?.length);
  check('audit entries carry a username', audit.data.rows.every((r) => r.username || r.action === 'LOGIN_FAILED'));

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(50));
  process.exit(fail ? 1 : 0);
};

run().catch((e) => { console.error('\nTest run aborted:', e); process.exit(1); });
