/**
 * Seeds master data, users and (optionally) a worked demo batch.
 *
 *   node server/seed.js            master data + users
 *   node server/seed.js --demo     master data + a batch walked through every section
 *   node server/seed.js --reset    delete the database first
 */
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const DEMO = args.includes('--demo') || RESET;

if (RESET) {
  const dataDir = join(process.cwd(), 'data');
  for (const f of ['denim_rfid.db', 'denim_rfid.db-wal', 'denim_rfid.db-shm']) {
    const p = join(dataDir, f);
    if (existsSync(p)) rmSync(p);
  }
  console.log('Existing database removed.');
}

const { db, migrate, run, get, all, tx } = await import('./lib/db.js');
const { hashPassword } = await import('./lib/auth.js');
const Fabric = await import('./services/fabric.js');
const Articles = await import('./services/articles.js');
const Movement = await import('./services/movement.js');
const Sorting = await import('./services/sorting.js');
const QC = await import('./services/qc.js');
const DispatchSvc = await import('./services/dispatch.js');
const { SHIFT_DEFS } = await import('./lib/process.js');

migrate();
for (const s of SHIFT_DEFS) {
  run(`INSERT INTO shifts(code, name, start_time, end_time) VALUES(?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name`, s.code, s.name, s.start, s.end);
}

const upsert = (table, cols, rows, key = 'code') => {
  const set = cols.filter((c) => c !== key).map((c) => `${c}=excluded.${c}`).join(', ');
  const stmt = db.prepare(
    `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})
     ON CONFLICT(${key}) DO UPDATE SET ${set}`);
  for (const r of rows) stmt.run(...cols.map((c) => r[c] ?? null));
};

/* ----------------------------- Users ------------------------------ */
const USERS = [
  ['admin',      'System Administrator',  'EMP-0001', 'ADMIN',      null,        'admin123'],
  ['pmanager',   'Ayesha Rahman',         'EMP-0100', 'MANAGER',    null,        'manager123'],
  ['store.sup',  'Imran Qureshi',         'EMP-0201', 'SUPERVISOR', 'FABRIC_WH', 'store123'],
  ['cut.sup',    'Nadia Aslam',           'EMP-0202', 'SUPERVISOR', 'CUTTING',   'cut123'],
  ['stitch.sup', 'Bilal Ahmed',           'EMP-0203', 'SUPERVISOR', 'STITCHING', 'stitch123'],
  ['stitch.op1', 'Sana Iqbal',            'EMP-0301', 'OPERATOR',   'STITCHING', 'op123'],
  ['sort.op1',   'Kamran Ali',            'EMP-0302', 'OPERATOR',   'SORTING',   'op123'],
  ['wash.sup',   'Tariq Mehmood',         'EMP-0204', 'SUPERVISOR', 'WASHING',   'wash123'],
  ['wash.op1',   'Farhan Sheikh',         'EMP-0303', 'OPERATOR',   'WASHING',   'op123'],
  ['finish.sup', 'Rabia Noor',            'EMP-0205', 'SUPERVISOR', 'FINISHING', 'finish123'],
  ['qc1',        'Hina Malik',            'EMP-0401', 'QC',         'QC',        'qc123'],
  ['qc2',        'Usman Ghani',           'EMP-0402', 'QC',         'QC',        'qc123'],
  ['retro.op1',  'Zeeshan Haider',        'EMP-0304', 'OPERATOR',   'RETROFIT',  'op123'],
  ['disp.sup',   'Maryam Khan',           'EMP-0206', 'SUPERVISOR', 'DISPATCH',  'disp123'],
  ['reader-service', 'Reader Gateway Service', null,  'OPERATOR',   null,        randomBytes(24).toString('hex')],
];
for (const [username, full_name, emp_code, role, section, password] of USERS) {
  if (get('SELECT id FROM users WHERE username = ?', username)) continue;
  const { hash, salt } = hashPassword(password);
  run(`INSERT INTO users(username, full_name, emp_code, pass_hash, pass_salt, role, section)
       VALUES(?,?,?,?,?,?,?)`, username, full_name, emp_code, hash, salt, role, section);
}

/* --------------------------- Master data -------------------------- */
upsert('customers', ['code', 'name', 'country', 'tag_spec'], [
  { code: 'LEVI',   name: 'Levi Strauss & Co.',   country: 'USA',     tag_spec: 'SGTIN-96, GS1 company prefix 0614141' },
  { code: 'HNM',    name: 'H&M Hennes & Mauritz', country: 'Sweden',  tag_spec: 'SGTIN-96, GS1 company prefix 7318570' },
  { code: 'ZARA',   name: 'Industria de Diseno Textil', country: 'Spain', tag_spec: 'SGTIN-96 + item-level serial' },
  { code: 'UNIQLO', name: 'Fast Retailing Co.',   country: 'Japan',   tag_spec: 'SGTIN-96, UII 96-bit' },
  { code: 'MNS',    name: 'Marks & Spencer',      country: 'UK',      tag_spec: 'SGTIN-96, GS1 UK' },
]);

upsert('fabric_types', ['code', 'name', 'composition', 'weight_oz'], [
  { code: 'DNM-12R', name: 'Rigid Denim 12oz',        composition: '100% Cotton',                 weight_oz: 12.0 },
  { code: 'DNM-11S', name: 'Stretch Denim 11oz',      composition: '98% Cotton, 2% Elastane',     weight_oz: 11.0 },
  { code: 'DNM-10L', name: 'Lightweight Denim 10oz',  composition: '99% Cotton, 1% Elastane',     weight_oz: 10.0 },
  { code: 'DNM-14H', name: 'Heavy Selvedge 14oz',     composition: '100% Cotton Selvedge',        weight_oz: 14.0 },
  { code: 'DNM-09J', name: 'Jegging Denim 9oz',       composition: '70% Cotton, 28% Poly, 2% Elastane', weight_oz: 9.0 },
]);

upsert('colors', ['code', 'name', 'hex'], [
  { code: 'IND',  name: 'Indigo Raw',      hex: '#28418c' },
  { code: 'MDW',  name: 'Mid Wash Blue',   hex: '#5578b5' },
  { code: 'LTW',  name: 'Light Wash Blue', hex: '#9db6d9' },
  { code: 'BLK',  name: 'Jet Black',       hex: '#1b1b1e' },
  { code: 'GRY',  name: 'Charcoal Grey',   hex: '#565a5e' },
  { code: 'ECR',  name: 'Ecru / Natural',  hex: '#d9cfba' },
]);

upsert('sizes', ['code', 'name', 'sort_ord'], [
  { code: '28', name: 'Waist 28', sort_ord: 1 },
  { code: '30', name: 'Waist 30', sort_ord: 2 },
  { code: '32', name: 'Waist 32', sort_ord: 3 },
  { code: '34', name: 'Waist 34', sort_ord: 4 },
  { code: '36', name: 'Waist 36', sort_ord: 5 },
  { code: '38', name: 'Waist 38', sort_ord: 6 },
  { code: 'S',  name: 'Small',    sort_ord: 11 },
  { code: 'M',  name: 'Medium',   sort_ord: 12 },
  { code: 'L',  name: 'Large',    sort_ord: 13 },
  { code: 'XL', name: 'X-Large',  sort_ord: 14 },
]);

const ft = (code) => get('SELECT id FROM fabric_types WHERE code = ?', code).id;
upsert('styles', ['code', 'name', 'description', 'fabric_type_id', 'image_front', 'image_back', 'wash_recipe', 'smv'], [
  { code: 'SLM-501', name: 'Slim Fit 5-Pocket Jean', description: 'Classic 5-pocket slim leg',
    fabric_type_id: ft('DNM-11S'), image_front: '/img/jeans-front.svg', image_back: '/img/jeans-back.svg',
    wash_recipe: 'Stone wash 45 min + softener', smv: 18.5 },
  { code: 'STR-712', name: 'Straight Leg Jean', description: 'Regular waist straight leg',
    fabric_type_id: ft('DNM-12R'), image_front: '/img/jeans-front.svg', image_back: '/img/jeans-back.svg',
    wash_recipe: 'Rinse wash + enzyme 30 min', smv: 16.2 },
  { code: 'SKN-330', name: 'Skinny Jegging', description: 'High stretch skinny fit',
    fabric_type_id: ft('DNM-09J'), image_front: '/img/jeans-front.svg', image_back: '/img/jeans-back.svg',
    wash_recipe: 'Bleach 20 min + whiskering', smv: 15.0 },
  { code: 'JKT-201', name: 'Trucker Denim Jacket', description: 'Classic trucker jacket',
    fabric_type_id: ft('DNM-14H'), image_front: '/img/jacket-front.svg', image_back: '/img/jacket-back.svg',
    wash_recipe: 'Vintage stone wash 60 min', smv: 32.0 },
  { code: 'SHT-140', name: 'Denim Overshirt', description: 'Lightweight denim shirt',
    fabric_type_id: ft('DNM-10L'), image_front: '/img/shirt-front.svg', image_back: '/img/shirt-back.svg',
    wash_recipe: 'Soft rinse + silicone', smv: 21.0 },
]);

upsert('defect_codes', ['code', 'name', 'category', 'severity'], [
  { code: 'D-SKIP', name: 'Skipped stitch',            category: 'STITCHING',   severity: 'MAJOR' },
  { code: 'D-BRKN', name: 'Broken stitch',             category: 'STITCHING',   severity: 'MAJOR' },
  { code: 'D-OPEN', name: 'Open seam',                 category: 'STITCHING',   severity: 'CRITICAL' },
  { code: 'D-PUCK', name: 'Puckering',                 category: 'STITCHING',   severity: 'MINOR' },
  { code: 'D-UNEV', name: 'Uneven topstitch',          category: 'STITCHING',   severity: 'MINOR' },
  { code: 'D-SLUB', name: 'Fabric slub / weaving flaw', category: 'FABRIC',     severity: 'MAJOR' },
  { code: 'D-HOLE', name: 'Hole / tear in fabric',     category: 'FABRIC',      severity: 'CRITICAL' },
  { code: 'D-SHAD', name: 'Shade variation',           category: 'FABRIC',      severity: 'MAJOR' },
  { code: 'D-STAIN', name: 'Stain / soil mark',        category: 'FINISHING',   severity: 'MAJOR' },
  { code: 'D-WASH', name: 'Uneven wash effect',        category: 'WASH',        severity: 'MAJOR' },
  { code: 'D-BLCH', name: 'Bleach spot',               category: 'WASH',        severity: 'MAJOR' },
  { code: 'D-CRSE', name: 'Harsh hand feel after wash', category: 'WASH',       severity: 'MINOR' },
  { code: 'D-ZIP',  name: 'Zipper malfunction',        category: 'FINISHING',   severity: 'CRITICAL' },
  { code: 'D-BTTN', name: 'Button loose / misaligned', category: 'FINISHING',   severity: 'MAJOR' },
  { code: 'D-RIVT', name: 'Rivet missing or damaged',  category: 'FINISHING',   severity: 'MAJOR' },
  { code: 'D-LBL',  name: 'Label wrong or missing',    category: 'FINISHING',   severity: 'CRITICAL' },
  { code: 'D-MEAS', name: 'Measurement out of tolerance', category: 'MEASUREMENT', severity: 'CRITICAL' },
  { code: 'D-PRES', name: 'Poor pressing / creasing',  category: 'FINISHING',   severity: 'MINOR' },
]);

upsert('readers', ['code', 'name', 'section', 'mode', 'host'], [
  { code: 'RDR-WH-01',  name: 'Fabric store handheld',        section: 'FABRIC_WH', mode: 'HANDHELD', host: null },
  { code: 'RDR-CUT-01', name: 'Cutting roll issue desk',      section: 'CUTTING',   mode: 'TABLETOP', host: '10.20.1.11' },
  { code: 'RDR-STI-01', name: 'Stitching tag encoder line 1', section: 'STITCHING', mode: 'ENCODER',  host: '10.20.2.11' },
  { code: 'RDR-STI-02', name: 'Stitching tag encoder line 2', section: 'STITCHING', mode: 'ENCODER',  host: '10.20.2.12' },
  { code: 'RDR-SRT-01', name: 'Sorting station tunnel',       section: 'SORTING',   mode: 'TUNNEL',   host: '10.20.3.11' },
  { code: 'RDR-WSH-IN', name: 'Wash inbound portal',          section: 'WASHING',   mode: 'PORTAL',   host: '10.20.4.11' },
  { code: 'RDR-WSH-OT', name: 'Wash outbound tunnel',         section: 'WASHING',   mode: 'TUNNEL',   host: '10.20.4.12' },
  { code: 'RDR-FIN-IN', name: 'Finishing inbound portal',     section: 'FINISHING', mode: 'PORTAL',   host: '10.20.5.11' },
  { code: 'RDR-QC-01',  name: 'QC bench reader 1',            section: 'QC',        mode: 'TABLETOP', host: '10.20.6.11' },
  { code: 'RDR-QC-02',  name: 'QC bench reader 2',            section: 'QC',        mode: 'TABLETOP', host: '10.20.6.12' },
  { code: 'RDR-RTF-01', name: 'Retrofit bench reader',        section: 'RETROFIT',  mode: 'TABLETOP', host: '10.20.7.11' },
  { code: 'RDR-DSP-01', name: 'Dispatch re-tagging station',  section: 'DISPATCH',  mode: 'ENCODER',  host: '10.20.8.11' },
  { code: 'RDR-DSP-02', name: 'Dispatch outbound portal',     section: 'DISPATCH',  mode: 'PORTAL',   host: '10.20.8.12' },
]);

console.log('Master data ready.');

/* ----------------------------- Orders ----------------------------- */
const cust = (c) => get('SELECT id FROM customers WHERE code = ?', c).id;
const style = (c) => get('SELECT id FROM styles WHERE code = ?', c).id;
const color = (c) => get('SELECT id FROM colors WHERE code = ?', c).id;
const size = (c) => get('SELECT id FROM sizes WHERE code = ?', c).id;

const ORDERS = [
  { order_no: 'SO-2026-0001', customer: 'LEVI',   po: 'PO-LV-88213', ship: '2026-09-30',
    lines: [['SLM-501', 'IND', '30', 4000], ['SLM-501', 'IND', '32', 6000], ['SLM-501', 'IND', '34', 5000], ['SLM-501', 'MDW', '32', 4500]] },
  { order_no: 'SO-2026-0002', customer: 'HNM',    po: 'PO-HM-55120', ship: '2026-10-15',
    lines: [['SKN-330', 'BLK', '28', 3500], ['SKN-330', 'BLK', '30', 5200], ['SKN-330', 'GRY', '30', 3000]] },
  { order_no: 'SO-2026-0003', customer: 'ZARA',   po: 'PO-ZR-77341', ship: '2026-09-20',
    lines: [['STR-712', 'MDW', '32', 4800], ['STR-712', 'LTW', '34', 4200], ['JKT-201', 'IND', 'M', 2500], ['JKT-201', 'IND', 'L', 2500]] },
  { order_no: 'SO-2026-0004', customer: 'UNIQLO', po: 'PO-UQ-31002', ship: '2026-11-05',
    lines: [['SHT-140', 'LTW', 'M', 3000], ['SHT-140', 'LTW', 'L', 3200], ['SHT-140', 'ECR', 'M', 1800]] },
  { order_no: 'SO-2026-0005', customer: 'MNS',    po: 'PO-MS-90045', ship: '2026-10-28',
    lines: [['SLM-501', 'BLK', '32', 5500], ['SLM-501', 'BLK', '34', 4500]] },
];

tx(() => {
  for (const o of ORDERS) {
    if (get('SELECT id FROM orders WHERE order_no = ?', o.order_no)) continue;
    const res = run(
      `INSERT INTO orders(order_no, customer_id, po_ref, ship_date, status) VALUES(?,?,?,?, 'IN_PRODUCTION')`,
      o.order_no, cust(o.customer), o.po, o.ship);
    const id = Number(res.lastInsertRowid);
    for (const [st, cl, sz, qty] of o.lines) {
      run(`INSERT INTO order_lines(order_id, style_id, color_id, size_id, qty) VALUES(?,?,?,?,?)`,
        id, style(st), color(cl), size(sz), qty);
    }
  }
});
console.log(`Orders ready (${ORDERS.length}).`);

if (!DEMO) {
  console.log('\nDone. Start the server with:  npm start');
  console.log('Sign in as admin / admin123 (or any user listed in server/seed.js).');
  process.exit(0);
}

/* =================================================================== */
/* Demo run - one batch walked through every section                   */
/* =================================================================== */
console.log('\nBuilding demo production data...');

const uid = (u) => get('SELECT id FROM users WHERE username = ?', u).id;
const U = {
  store: uid('store.sup'), cut: uid('cut.sup'), stitch: uid('stitch.op1'), sort: uid('sort.op1'),
  wash: uid('wash.op1'), washSup: uid('wash.sup'), finish: uid('finish.sup'),
  qc: uid('qc1'), retro: uid('retro.op1'), disp: uid('disp.sup'),
};

const epcSeq = { n: 0 };
const makeEpc = () => {
  epcSeq.n += 1;
  return ('E28011' + epcSeq.n.toString(16).toUpperCase().padStart(18, '0')).slice(0, 24);
};

// 1. Fabric receiving
const grnOut = Fabric.receiveGrn({
  supplier: 'Artistic Milliners Ltd.', invoiceRef: 'INV-AM-77120',
  remarks: 'Container AMLU-4471', userId: U.store,
  rolls: [
    { fabric_type_id: ft('DNM-11S'), color_id: color('IND'), shade_batch: 'SH-A1', length_m: 1200, width_in: 58, weight_kg: 310, location: 'A-01-03', epc: makeEpc() },
    { fabric_type_id: ft('DNM-11S'), color_id: color('IND'), shade_batch: 'SH-A1', length_m: 1180, width_in: 58, weight_kg: 305, location: 'A-01-04', epc: makeEpc() },
    { fabric_type_id: ft('DNM-11S'), color_id: color('IND'), shade_batch: 'SH-A2', length_m: 1250, width_in: 58, weight_kg: 322, location: 'A-01-05', epc: makeEpc() },
    { fabric_type_id: ft('DNM-12R'), color_id: color('MDW'), shade_batch: 'SH-B1', length_m: 980,  width_in: 60, weight_kg: 280, location: 'A-02-01', epc: makeEpc() },
    { fabric_type_id: ft('DNM-09J'), color_id: color('BLK'), shade_batch: 'SH-C1', length_m: 1400, width_in: 56, weight_kg: 300, location: 'B-01-01', epc: makeEpc() },
    { fabric_type_id: ft('DNM-14H'), color_id: color('IND'), shade_batch: 'SH-D1', length_m: 860,  width_in: 62, weight_kg: 340, location: 'B-02-01', epc: makeEpc() },
  ],
});
console.log(`  GRN ${grnOut.grn.grn_no}: ${grnOut.count} rolls received.`);

// 2. Cut order + roll issue + bundles
const orderId = get('SELECT id FROM orders WHERE order_no = ?', 'SO-2026-0001').id;
const cutOrder = Fabric.createCutOrder({
  orderId, styleId: style('SLM-501'), colorId: color('IND'),
  plannedQty: 900, remarks: 'Demo lay - marker 4 ply', userId: U.cut });

Fabric.issueRolls({
  cutOrderId: cutOrder.id,
  rolls: grnOut.rolls.slice(0, 2).map((r) => ({ roll_id: r.id, issued_m: 600 })),
  userId: U.store });

const bundleOut = Fabric.createBundles({
  cutOrderId: cutOrder.id, userId: U.cut,
  lines: [
    { size_id: size('30'), bundles: 3, qty_per_bundle: 60 },
    { size_id: size('32'), bundles: 4, qty_per_bundle: 60 },
    { size_id: size('34'), bundles: 3, qty_per_bundle: 60 },
  ],
});
console.log(`  Cut order ${cutOrder.cut_no}: ${bundleOut.bundles.length} bundles, ${bundleOut.total_qty} pcs.`);

// 3. Cutting -> stitching on a manual count, then tag commissioning
Fabric.issueBundlesToStitching({ bundleIds: bundleOut.bundles.map((b) => b.id), userId: U.cut });

const commissioned = [];
for (const b of bundleOut.bundles) {
  Fabric.receiveBundle({ bundleId: b.id, countedQty: b.qty, userId: U.stitch });
  const epcs = Array.from({ length: b.qty }, makeEpc);
  const out = Articles.commissionArticles({ bundleId: b.id, epcs, userId: U.stitch, orderId });
  commissioned.push(...out.created.map((c) => c.epc));
}
console.log(`  Stitching: ${commissioned.length} garments tagged and registered.`);

/** Walk a set of EPCs through one transfer, receiving `drop` fewer to create variance. */
function transfer(from, to, epcs, { dispatchBy, receiveBy, batchRef = null, washRecipe = null, drop = 0, requireQcPass = false }) {
  const d = Movement.dispatch({ from, to, epcs, userId: dispatchBy, batchRef, washRecipe, requireQcPass });
  const expected = all(`SELECT epc FROM doc_lines WHERE doc_id = ? AND line_state = 'EXPECTED'`, d.doc.id).map((r) => r.epc);
  const scanned = drop ? expected.slice(0, expected.length - drop) : expected;
  const r = Movement.receive({ docId: d.doc.id, epcs: scanned, userId: receiveBy });
  return { doc: d.doc, received: scanned, tally: r.tally };
}

// 4. Stitching -> sorting (sorted by design / colour / size)
const t1 = transfer('STITCHING', 'SORTING', commissioned, { dispatchBy: U.stitch, receiveBy: U.sort });
console.log(`  ${t1.doc.doc_no}: stitching -> sorting, ${t1.tally.received} received.`);

const sortSession = Sorting.openSession({ stage: 'SORTING', groupBy: ['style', 'color', 'size'], userId: U.sort });
Sorting.addReads({ sessionId: sortSession.id, epcs: t1.received, userId: U.sort });
const sortBuckets = Sorting.buckets(sortSession.id);
console.log(`  Sorting session ${sortSession.session_no}: ${sortBuckets.length} groups.`);

// 5. Sorting -> washing, one batch per size group; one batch loses 2 pieces in transit
const washed = [];
sortBuckets.forEach((b, i) => {
  const out = Sorting.dispatchBucket({
    sessionId: sortSession.id, bucketKey: b.bucket_key, to: 'WASHING', userId: U.sort,
    batchRef: `WASH-LOT-${String(i + 1).padStart(2, '0')}`,
    washRecipe: 'Stone wash 45 min + softener',
  });
  const expected = all(`SELECT epc FROM doc_lines WHERE doc_id = ? AND line_state = 'EXPECTED'`, out.doc.id).map((r) => r.epc);
  const drop = i === 0 ? 2 : 0;
  const scanned = expected.slice(0, expected.length - drop);
  Movement.receive({ docId: out.doc.id, epcs: scanned, userId: U.wash });
  washed.push(...scanned);
  if (drop) console.log(`  ${out.doc.doc_no}: variance created - ${drop} pieces not read at wash inbound.`);
});
Sorting.closeSession({ sessionId: sortSession.id, userId: U.sort });
console.log(`  Washing: ${washed.length} garments received across ${sortBuckets.length} batches.`);

// 6. Post-wash sorting by customer order + size, then on to finishing
const washSort = Sorting.openSession({ stage: 'WASHING', groupBy: ['order', 'size'], userId: U.washSup });
Sorting.addReads({ sessionId: washSort.id, epcs: washed, userId: U.washSup });
const finished = [];
for (const b of Sorting.buckets(washSort.id)) {
  const out = Sorting.dispatchBucket({
    sessionId: washSort.id, bucketKey: b.bucket_key, to: 'FINISHING', userId: U.washSup,
    batchRef: `FIN-${b.bucket_key.replace(/[^A-Za-z0-9]+/g, '-')}` });
  const expected = all(`SELECT epc FROM doc_lines WHERE doc_id = ? AND line_state = 'EXPECTED'`, out.doc.id).map((r) => r.epc);
  Movement.receive({ docId: out.doc.id, epcs: expected, userId: U.finish });
  finished.push(...expected);
}
Sorting.closeSession({ sessionId: washSort.id, userId: U.washSup });
console.log(`  Finishing: ${finished.length} garments received.`);

// 7. Finishing -> QC
const t2 = transfer('FINISHING', 'QC', finished, { dispatchBy: U.finish, receiveBy: U.qc, batchRef: 'QC-LOT-01' });
console.log(`  ${t2.doc.doc_no}: finishing -> QC, ${t2.tally.received} received.`);

// 8. QC: ~8% fail with positioned defects
const defectIds = all('SELECT id, code, severity FROM defect_codes WHERE active = 1');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const qcPassed = [];
const qcFailed = [];
for (const epc of t2.received) {
  const fail = Math.random() < 0.08;
  if (fail) {
    const n = 1 + Math.floor(Math.random() * 2);
    const defects = Array.from({ length: n }, () => {
      const d = pick(defectIds);
      return { defect_code_id: d.id, severity: d.severity, view: Math.random() < 0.7 ? 'FRONT' : 'BACK',
        pos_x: Math.round(Math.random() * 80 + 10) / 100, pos_y: Math.round(Math.random() * 80 + 10) / 100,
        note: 'Found during final inspection' };
    });
    QC.inspect({ epc, result: 'FAIL', defects, inspectorId: U.qc, remarks: 'Sent for correction' });
    qcFailed.push(epc);
  } else {
    QC.inspect({ epc, result: 'PASS', inspectorId: U.qc });
    qcPassed.push(epc);
  }
}
console.log(`  QC: ${qcPassed.length} passed, ${qcFailed.length} failed.`);

// 9. Failures -> retrofit -> corrected -> back to QC
if (qcFailed.length) {
  const t3 = transfer('QC', 'RETROFIT', qcFailed, { dispatchBy: U.qc, receiveBy: U.retro, batchRef: 'RTF-LOT-01' });
  for (const epc of t3.received) {
    const art = Articles.articleByEpc(epc);
    QC.startRework({ articleId: art.id, userId: U.retro });
    QC.completeRework({ articleId: art.id, userId: U.retro, actionTaken: 'Seam re-stitched and pressed' });
  }
  const t4 = transfer('RETROFIT', 'QC', t3.received, { dispatchBy: U.retro, receiveBy: U.qc, batchRef: 'RQC-LOT-01' });
  let reFail = 0;
  for (const epc of t4.received) {
    if (Math.random() < 0.1) { reFail++; continue; }   // still stuck at QC, awaiting re-inspection
    QC.inspect({ epc, result: 'PASS', inspectorId: U.qc, remarks: 'Correction verified' });
    qcPassed.push(epc);
  }
  console.log(`  Retrofit: ${t3.received.length} corrected, ${t4.received.length} returned to QC, ${reFail} left pending re-inspection.`);
}

// 10. QC-passed -> dispatch, tracking tags swapped for customer tags, then ship
const t5 = transfer('QC', 'DISPATCH', qcPassed, { dispatchBy: U.qc, receiveBy: U.disp, batchRef: 'DSP-LOT-01', requireQcPass: true });
const shipment = DispatchSvc.createShipment({ orderId, carrier: 'DHL Global Forwarding', userId: U.disp });
const pairs = t5.received.map((epc, i) => ({
  tracking_epc: epc, customer_epc: makeEpc(), carton_no: `CTN-${String(Math.floor(i / 40) + 1).padStart(3, '0')}`,
}));
const swap = DispatchSvc.swapTags({ shipmentId: shipment.id, pairs, userId: U.disp });
console.log(`  Dispatch: ${swap.swapped} tracking tags removed and customer tags applied (${shipment.shipment_no}).`);

const half = Math.floor(swap.done.length / 2);
if (half > 0) {
  // Ship half so the data set contains both packed and shipped goods.
  const shipment2 = DispatchSvc.createShipment({ orderId, carrier: 'DHL Global Forwarding', userId: U.disp });
  void shipment2;
  DispatchSvc.ship({ shipmentId: shipment.id, userId: U.disp });
  console.log(`  Shipped ${shipment.shipment_no}.`);
}

/* -------------------------------------------------------------------------
   A second wave that stops at different sections, so the plant looks like a
   plant: work sitting in every department rather than an empty floor.
   ------------------------------------------------------------------------- */
console.log('\nBuilding work in process across the sections...');

const STAGE_ORDER = ['STITCHING', 'SORTING', 'WASHING', 'FINISHING', 'QC', 'RETROFIT', 'DISPATCH'];

/** Cut, tag and walk a batch forward until it reaches `stopAt`, then leave it there. */
function wave({ styleCode, colorCode, sizeCode, orderNo, qty, stopAt, batchPrefix }) {
  const ordId = get('SELECT id FROM orders WHERE order_no = ?', orderNo).id;
  const cut = Fabric.createCutOrder({
    orderId: ordId, styleId: style(styleCode), colorId: color(colorCode),
    plannedQty: qty, remarks: `Wave to ${stopAt}`, userId: U.cut });

  const stock = all(
    `SELECT id, remaining_m FROM fabric_rolls WHERE color_id = ? AND remaining_m > 50 ORDER BY remaining_m DESC LIMIT 2`,
    color(colorCode));
  if (stock.length) {
    Fabric.issueRolls({ cutOrderId: cut.id, userId: U.store,
      rolls: stock.map((r) => ({ roll_id: r.id, issued_m: Math.min(200, r.remaining_m) })) });
  }

  const made = Fabric.createBundles({ cutOrderId: cut.id, userId: U.cut,
    lines: [{ size_id: size(sizeCode), bundles: Math.max(1, Math.round(qty / 50)), qty_per_bundle: 50 }] });
  Fabric.issueBundlesToStitching({ bundleIds: made.bundles.map((b) => b.id), userId: U.cut });

  let epcs = [];
  for (const b of made.bundles) {
    Fabric.receiveBundle({ bundleId: b.id, countedQty: b.qty, userId: U.stitch });
    const tags = Array.from({ length: b.qty }, makeEpc);
    const out = Articles.commissionArticles({ bundleId: b.id, epcs: tags, userId: U.stitch, orderId: ordId });
    epcs.push(...out.created.map((c) => c.epc));
  }
  if (stopAt === 'STITCHING') return epcs;

  const legs = [['STITCHING', 'SORTING', U.stitch, U.sort], ['SORTING', 'WASHING', U.sort, U.wash],
    ['WASHING', 'FINISHING', U.washSup, U.finish], ['FINISHING', 'QC', U.finish, U.qc]];

  for (const [from, to, sender, receiver] of legs) {
    const d = Movement.dispatch({ from, to, epcs, userId: sender, batchRef: `${batchPrefix}-${to}` });
    const expected = all(`SELECT epc FROM doc_lines WHERE doc_id = ? AND line_state = 'EXPECTED'`, d.doc.id).map((r) => r.epc);
    if (to === stopAt) {
      // Leave this one in transit so the receiving section has something inbound.
      if (stopAt === 'WASHING') return epcs;
      Movement.receive({ docId: d.doc.id, epcs: expected, userId: receiver });
      return expected;
    }
    Movement.receive({ docId: d.doc.id, epcs: expected, userId: receiver });
    epcs = expected;
  }

  // Reached QC: inspect, then push the outcome onwards.
  const passed = [];
  const failedNow = [];
  for (const epc of epcs) {
    if (Math.random() < 0.09) {
      const d = pick(defectIds);
      QC.inspect({ epc, result: 'FAIL', inspectorId: U.qc,
        defects: [{ defect_code_id: d.id, severity: d.severity, view: Math.random() < 0.7 ? 'FRONT' : 'BACK',
          pos_x: Math.round(Math.random() * 80 + 10) / 100, pos_y: Math.round(Math.random() * 80 + 10) / 100,
          note: 'Found at final inspection' }] });
      failedNow.push(epc);
    } else {
      QC.inspect({ epc, result: 'PASS', inspectorId: U.qc });
      passed.push(epc);
    }
  }

  if (stopAt === 'RETROFIT' && failedNow.length) {
    const d = Movement.dispatch({ from: 'QC', to: 'RETROFIT', epcs: failedNow, userId: U.qc, batchRef: `${batchPrefix}-RTF` });
    Movement.receive({ docId: d.doc.id, epcs: failedNow, userId: U.retro });
    return failedNow;
  }
  if (stopAt === 'DISPATCH' && passed.length) {
    const d = Movement.dispatch({ from: 'QC', to: 'DISPATCH', epcs: passed, userId: U.qc,
      batchRef: `${batchPrefix}-DSP`, requireQcPass: true });
    Movement.receive({ docId: d.doc.id, epcs: passed, userId: U.disp });
    return passed;
  }
  return epcs;   // stopAt === 'QC'
}

const WAVES = [
  { styleCode: 'SLM-501', colorCode: 'IND', sizeCode: '32', orderNo: 'SO-2026-0001', qty: 400, stopAt: 'STITCHING', batchPrefix: 'W1' },
  { styleCode: 'SKN-330', colorCode: 'BLK', sizeCode: '30', orderNo: 'SO-2026-0002', qty: 300, stopAt: 'SORTING',   batchPrefix: 'W2' },
  { styleCode: 'STR-712', colorCode: 'MDW', sizeCode: '32', orderNo: 'SO-2026-0003', qty: 250, stopAt: 'WASHING',   batchPrefix: 'W3' },
  { styleCode: 'JKT-201', colorCode: 'IND', sizeCode: 'M',  orderNo: 'SO-2026-0003', qty: 200, stopAt: 'FINISHING', batchPrefix: 'W4' },
  { styleCode: 'SHT-140', colorCode: 'LTW', sizeCode: 'M',  orderNo: 'SO-2026-0004', qty: 200, stopAt: 'QC',        batchPrefix: 'W5' },
  { styleCode: 'SLM-501', colorCode: 'BLK', sizeCode: '34', orderNo: 'SO-2026-0005', qty: 300, stopAt: 'RETROFIT',  batchPrefix: 'W6' },
  { styleCode: 'SLM-501', colorCode: 'BLK', sizeCode: '32', orderNo: 'SO-2026-0005', qty: 250, stopAt: 'DISPATCH',  batchPrefix: 'W7' },
];

for (const w of WAVES) {
  const left = wave(w);
  console.log(`  ${w.batchPrefix}: ${left.length} x ${w.styleCode}/${w.colorCode}/${w.sizeCode} left in ${w.stopAt}.`);
}

// A little more fabric so the store is not empty after all that cutting.
Fabric.receiveGrn({
  supplier: 'Soorty Enterprises', invoiceRef: 'INV-SE-4410', remarks: 'Second delivery', userId: U.store,
  rolls: [
    { fabric_type_id: ft('DNM-11S'), color_id: color('IND'), shade_batch: 'SH-A3', length_m: 1300, width_in: 58, weight_kg: 335, location: 'A-03-01', epc: makeEpc() },
    { fabric_type_id: ft('DNM-09J'), color_id: color('BLK'), shade_batch: 'SH-C2', length_m: 1500, width_in: 56, weight_kg: 320, location: 'B-01-02', epc: makeEpc() },
    { fabric_type_id: ft('DNM-12R'), color_id: color('MDW'), shade_batch: 'SH-B2', length_m: 1100, width_in: 60, weight_kg: 300, location: 'A-02-02', epc: makeEpc() },
    { fabric_type_id: ft('DNM-10L'), color_id: color('LTW'), shade_batch: 'SH-E1', length_m: 900,  width_in: 60, weight_kg: 240, location: 'C-01-01', epc: makeEpc() },
  ],
});

// Leave one bundle uncounted in cutting and one sorting session open, so the
// stitching and sorting screens have live work waiting.
const idleCut = Fabric.createCutOrder({
  orderId: get('SELECT id FROM orders WHERE order_no = ?', 'SO-2026-0004').id,
  styleId: style('SHT-140'), colorId: color('LTW'), plannedQty: 150,
  remarks: 'Awaiting handover to stitching', userId: U.cut });
const idleBundles = Fabric.createBundles({ cutOrderId: idleCut.id, userId: U.cut,
  lines: [{ size_id: size('L'), bundles: 3, qty_per_bundle: 50 }] });
Fabric.issueBundlesToStitching({ bundleIds: idleBundles.bundles.map((b) => b.id), userId: U.cut });
console.log(`  ${idleBundles.bundles.length} bundle(s) left waiting to be counted in at stitching.`);

const liveSort = Sorting.openSession({ stage: 'SORTING', groupBy: ['style', 'color', 'size'], userId: U.sort });
const atSorting = all(`SELECT epc FROM articles WHERE stage = 'SORTING' AND status = 'IN_STAGE' LIMIT 400`).map((r) => r.epc);
if (atSorting.length) {
  Sorting.addReads({ sessionId: liveSort.id, epcs: atSorting, userId: U.sort });
  console.log(`  Sorting session ${liveSort.session_no} left open with ${atSorting.length} garment(s) read.`);
}

/* Saved report examples so the report builder opens with something useful */
const Reports = await import('./services/reports.js');
const SAMPLES = [
  { name: 'WIP by section and style', dataset: 'articles',
    definition: { group_by: ['stage', 'style_code'], aggregates: [{ fn: 'COUNT', field: 'article_id', label: 'Pieces' },
      { fn: 'AVG', field: 'age_hours', label: 'Avg age (h)' }], filters: [{ field: 'stage', op: 'ne', value: 'SHIPPED' }], limit: 500 } },
  { name: 'Top defects last 30 days', dataset: 'qc',
    definition: { group_by: ['defect_name', 'severity'], aggregates: [{ fn: 'COUNT', field: 'inspections', label: 'Occurrences' }],
      filters: [{ field: 'result', op: 'eq', value: 'FAIL' }, { field: 'inspected_at', op: 'last_days', value: 30 }], limit: 50 } },
  { name: 'Transfer variances', dataset: 'movements',
    definition: { columns: ['doc_no', 'from_stage', 'to_stage', 'expected_count', 'received_count', 'missing_count', 'created_at'],
      filters: [{ field: 'missing_count', op: 'gt', value: 0 }], sort: [{ field: 'created_at', dir: 'desc' }], limit: 200 } },
  { name: 'Fabric stock by type and colour', dataset: 'rolls',
    definition: { group_by: ['fabric_name', 'color_name'], aggregates: [{ fn: 'COUNT', field: 'rolls', label: 'Rolls' },
      { fn: 'SUM', field: 'remaining_m', label: 'Metres left' }], filters: [{ field: 'status', op: 'in', value: 'IN_STOCK,PARTIAL' }], limit: 200 } },
  { name: 'Output per shift (7 days)', dataset: 'events',
    definition: { group_by: ['day', 'shift_code', 'event_type'], aggregates: [{ fn: 'COUNT', field: 'qty', label: 'Events' }],
      filters: [{ field: 'ts', op: 'last_days', value: 7 }], limit: 500 } },
];
for (const s of SAMPLES) {
  if (get('SELECT id FROM report_defs WHERE name = ?', s.name)) continue;
  Reports.saveReport({ name: s.name, dataset: s.dataset, definition: s.definition, shared: true, userId: uid('pmanager') });
}

const summary = get(`SELECT
  (SELECT COUNT(*) FROM articles) AS articles,
  (SELECT COUNT(*) FROM movement_docs) AS docs,
  (SELECT COUNT(*) FROM qc_inspections) AS inspections,
  (SELECT COUNT(*) FROM article_events) AS events`);

console.log(`\nDemo data complete: ${summary.articles} articles, ${summary.docs} transfer documents, ` +
  `${summary.inspections} QC inspections, ${summary.events} tracking events.`);
console.log('\nStart the server with:  npm start');
console.log('Sign in as admin / admin123  (see server/seed.js for the other station logins).');
process.exit(0);
