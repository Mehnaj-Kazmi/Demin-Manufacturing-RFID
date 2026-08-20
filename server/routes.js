import { randomBytes } from 'node:crypto';
import { all, get, run, tx, db } from './lib/db.js';
import {
  Router, sendJson, sendCsv, sendText, readJson, toCsv,
  badRequest, notFound, conflict, forbidden,
  str, int, num, bool, oneOf, epcList,
} from './lib/http.js';
import {
  STAGES, STAGE_CODES, WIP_STAGES, ROUTES, ROLES, CAPS, SHIFT_DEFS,
  SORT_DIMENSIONS, roleHas, routesFrom, shiftFor,
} from './lib/process.js';
import {
  login, logout, publicUser, requireUser, requireCap, changePassword,
  hashPassword, auditCtx, listSessions,
} from './lib/auth.js';
import * as Articles from './services/articles.js';
import * as Movement from './services/movement.js';
import * as Sorting from './services/sorting.js';
import * as QC from './services/qc.js';
import * as Fabric from './services/fabric.js';
import * as Dispatch from './services/dispatch.js';
import * as KPI from './services/kpi.js';
import * as Reports from './services/reports.js';
import { printDocument, printShipment } from './lib/print.js';

export const api = new Router();

const ok = (res, data) => sendJson(res, 200, data);
const created = (res, data) => sendJson(res, 201, data);

/* =================================================================== */
/* Authentication                                                      */
/* =================================================================== */
api.post('/api/auth/login', async (ctx) => {
  const body = await readJson(ctx.req);
  const out = login(body.username, body.password, ctx.ip);
  ctx.res.setHeader('Set-Cookie',
    `drfid_token=${out.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${12 * 3600}`);
  ok(ctx.res, { ...out, caps: capsFor(out.user.role) });
});

api.post('/api/auth/logout', (ctx) => {
  logout(ctx.token, ctx.user, ctx.ip);
  ctx.res.setHeader('Set-Cookie', 'drfid_token=; Path=/; HttpOnly; Max-Age=0');
  ok(ctx.res, { ok: true });
});

api.get('/api/auth/me', (ctx) => {
  const u = requireUser(ctx);
  ok(ctx.res, { user: publicUser(u), caps: capsFor(u.role), shift: shiftFor() });
});

api.post('/api/auth/change-password', async (ctx) => {
  const u = requireUser(ctx);
  const body = await readJson(ctx.req);
  const { verifyPassword } = await import('./lib/auth.js');
  if (!verifyPassword(String(body.current_password || ''), u.pass_hash, u.pass_salt)) {
    throw badRequest('Current password is incorrect');
  }
  changePassword(u.id, body.new_password);
  auditCtx(ctx, 'PASSWORD_CHANGED', 'user', u.id);
  ok(ctx.res, { ok: true, message: 'Password changed - please sign in again' });
});

function capsFor(role) {
  const r = ROLES[role];
  if (!r) return [];
  return r.caps.includes('*') ? CAPS.slice() : r.caps.slice();
}

/* =================================================================== */
/* Metadata that drives the UI                                         */
/* =================================================================== */
api.get('/api/meta', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, {
    stages: STAGE_CODES.map((code) => ({ code, ...STAGES[code], routes: routesFrom(code) })),
    wip_stages: WIP_STAGES,
    routes: ROUTES,
    roles: Object.entries(ROLES).map(([key, r]) => ({ key, name: r.name, caps: capsFor(key) })),
    caps: CAPS,
    shifts: SHIFT_DEFS,
    sort_dimensions: Object.entries(SORT_DIMENSIONS).map(([key, d]) => ({ key, label: d.label })),
    group_dimensions: Object.entries(KPI.GROUP_DIMS).map(([key, d]) => ({ key, label: d.label })),
    age_buckets: KPI.AGE_BUCKETS,
    current_shift: shiftFor(),
  });
});

/* =================================================================== */
/* Master data                                                         */
/* =================================================================== */
const MASTERS = {
  customers:    { table: 'customers',    cols: ['code', 'name', 'country', 'tag_spec', 'active'], order: 'code' },
  fabric_types: { table: 'fabric_types', cols: ['code', 'name', 'composition', 'weight_oz', 'active'], order: 'code' },
  colors:       { table: 'colors',       cols: ['code', 'name', 'hex', 'active'], order: 'code' },
  sizes:        { table: 'sizes',        cols: ['code', 'name', 'sort_ord', 'active'], order: 'sort_ord, code' },
  styles:       { table: 'styles',       cols: ['code', 'name', 'description', 'fabric_type_id', 'image_front', 'image_back', 'wash_recipe', 'smv', 'active'], order: 'code' },
  defect_codes: { table: 'defect_codes', cols: ['code', 'name', 'category', 'severity', 'active'], order: 'category, code' },
  readers:      { table: 'readers',      cols: ['code', 'name', 'section', 'mode', 'host', 'active'], order: 'section, code', cap: 'admin.readers' },
};

api.get('/api/masters/:entity', (ctx) => {
  requireUser(ctx);
  const m = MASTERS[ctx.params.entity];
  if (!m) throw notFound(`Unknown master data set "${ctx.params.entity}"`);
  const activeOnly = bool(ctx.query.active_only, false);
  const rows = all(`SELECT * FROM ${m.table} ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY ${m.order}`);
  ok(ctx.res, { rows });
});

api.post('/api/masters/:entity', async (ctx) => {
  const m = MASTERS[ctx.params.entity];
  if (!m) throw notFound(`Unknown master data set "${ctx.params.entity}"`);
  requireCap(ctx, m.cap || 'masters.manage');
  const body = await readJson(ctx.req);
  const cols = m.cols.filter((c) => body[c] !== undefined);
  if (!cols.length) throw badRequest('Nothing to save');
  if (!body.code || !body.name) throw badRequest('Code and name are required');
  const res = run(
    `INSERT INTO ${m.table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
    ...cols.map((c) => body[c]));
  const row = get(`SELECT * FROM ${m.table} WHERE id = ?`, Number(res.lastInsertRowid));
  auditCtx(ctx, 'MASTER_CREATE', m.table, row.id, row);
  created(ctx.res, { row });
});

api.put('/api/masters/:entity/:id', async (ctx) => {
  const m = MASTERS[ctx.params.entity];
  if (!m) throw notFound(`Unknown master data set "${ctx.params.entity}"`);
  requireCap(ctx, m.cap || 'masters.manage');
  const id = int(ctx.params.id, 'id', { required: true });
  const body = await readJson(ctx.req);
  const cols = m.cols.filter((c) => body[c] !== undefined);
  if (!cols.length) throw badRequest('Nothing to update');
  run(`UPDATE ${m.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    ...cols.map((c) => body[c]), id);
  const row = get(`SELECT * FROM ${m.table} WHERE id = ?`, id);
  if (!row) throw notFound('Record not found');
  auditCtx(ctx, 'MASTER_UPDATE', m.table, id, row);
  ok(ctx.res, { row });
});

/* =================================================================== */
/* Orders                                                              */
/* =================================================================== */
api.get('/api/orders', (ctx) => {
  requireUser(ctx);
  const where = [];
  const params = [];
  if (ctx.query.status) { where.push('o.status = ?'); params.push(ctx.query.status); }
  if (ctx.query.customer_id) { where.push('o.customer_id = ?'); params.push(Number(ctx.query.customer_id)); }
  if (ctx.query.q) { where.push('(o.order_no LIKE ? OR o.po_ref LIKE ? OR cu.name LIKE ?)');
    params.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`, `%${ctx.query.q}%`); }
  const rows = all(
    `SELECT o.*, cu.code AS customer_code, cu.name AS customer_name,
            (SELECT COALESCE(SUM(qty),0) FROM order_lines ol WHERE ol.order_id = o.id) AS ordered_qty,
            (SELECT COUNT(*) FROM articles a WHERE a.order_id = o.id) AS in_production,
            (SELECT COUNT(*) FROM articles a WHERE a.order_id = o.id AND a.stage = 'SHIPPED') AS shipped_qty
       FROM orders o JOIN customers cu ON cu.id = o.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.order_date DESC, o.id DESC LIMIT 300`, ...params);
  ok(ctx.res, { rows });
});

api.post('/api/orders', async (ctx) => {
  requireCap(ctx, 'orders.manage');
  const b = await readJson(ctx.req);
  const orderNo = str(b.order_no, 'order_no', { required: true });
  const customerId = int(b.customer_id, 'customer_id', { required: true });
  if (get('SELECT id FROM orders WHERE order_no = ?', orderNo)) throw conflict(`Order ${orderNo} already exists`);
  const out = tx(() => {
    const res = run(
      `INSERT INTO orders(order_no, customer_id, po_ref, order_date, ship_date, remarks)
       VALUES(?,?,?,COALESCE(?, date('now','localtime')),?,?)`,
      orderNo, customerId, str(b.po_ref, 'po_ref'), b.order_date || null, b.ship_date || null, str(b.remarks, 'remarks'));
    const id = Number(res.lastInsertRowid);
    for (const l of b.lines || []) {
      run(`INSERT INTO order_lines(order_id, style_id, color_id, size_id, qty, unit_price) VALUES(?,?,?,?,?,?)`,
        id, int(l.style_id, 'style_id', { required: true }), int(l.color_id, 'color_id', { required: true }),
        int(l.size_id, 'size_id', { required: true }), int(l.qty, 'qty', { required: true, min: 1 }), l.unit_price ?? null);
    }
    return id;
  });
  auditCtx(ctx, 'ORDER_CREATE', 'orders', out, { order_no: orderNo });
  created(ctx.res, Dispatch.orderProgress(out));
});

api.get('/api/orders/:id', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, Dispatch.orderProgress(int(ctx.params.id, 'id', { required: true })));
});

/* =================================================================== */
/* Fabric warehouse                                                    */
/* =================================================================== */
api.get('/api/fabric/grn', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: Fabric.listGrn({ q: ctx.query.q, limit: Number(ctx.query.limit) || 100 }) });
});

api.post('/api/fabric/grn', async (ctx) => {
  const u = requireCap(ctx, 'fabric.receive');
  const b = await readJson(ctx.req);
  const out = Fabric.receiveGrn({
    supplier: str(b.supplier, 'supplier'), invoiceRef: str(b.invoice_ref, 'invoice_ref'),
    remarks: str(b.remarks, 'remarks'), rolls: b.rolls, userId: u.id,
  });
  auditCtx(ctx, 'GRN_RECEIVE', 'grn', out.grn.id, { grn_no: out.grn.grn_no, rolls: out.count });
  created(ctx.res, out);
});

api.get('/api/fabric/grn/:id', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { grn: Fabric.grnById(int(ctx.params.id, 'id', { required: true })) });
});

api.get('/api/fabric/rolls', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, Fabric.listRolls({
    status: ctx.query.status, q: ctx.query.q,
    fabricTypeId: ctx.query.fabric_type_id ? Number(ctx.query.fabric_type_id) : null,
    colorId: ctx.query.color_id ? Number(ctx.query.color_id) : null,
    limit: Number(ctx.query.limit) || 200, offset: Number(ctx.query.offset) || 0,
  }));
});

api.post('/api/fabric/rolls/scan', async (ctx) => {
  requireUser(ctx);
  const b = await readJson(ctx.req);
  ok(ctx.res, Fabric.rollsByEpcs(epcList(b.epcs)));
});

api.get('/api/fabric/stock', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: Fabric.stockSummary() });
});

/* =================================================================== */
/* Cutting                                                             */
/* =================================================================== */
api.get('/api/cutting/orders', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: Fabric.listCutOrders({ status: ctx.query.status, q: ctx.query.q, limit: Number(ctx.query.limit) || 100 }) });
});

api.post('/api/cutting/orders', async (ctx) => {
  const u = requireCap(ctx, 'cutting.manage');
  const b = await readJson(ctx.req);
  const out = Fabric.createCutOrder({
    orderId: b.order_id ? int(b.order_id, 'order_id') : null,
    styleId: int(b.style_id, 'style_id', { required: true }),
    colorId: int(b.color_id, 'color_id', { required: true }),
    plannedQty: int(b.planned_qty, 'planned_qty', { min: 0 }) || 0,
    remarks: str(b.remarks, 'remarks'), userId: u.id,
  });
  auditCtx(ctx, 'CUT_ORDER_CREATE', 'cut_orders', out.id, { cut_no: out.cut_no });
  created(ctx.res, { cut_order: out });
});

api.get('/api/cutting/orders/:id', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { cut_order: Fabric.cutOrderById(int(ctx.params.id, 'id', { required: true })) });
});

api.post('/api/cutting/orders/:id/issue', async (ctx) => {
  const u = requireCap(ctx, 'fabric.issue');
  const b = await readJson(ctx.req);
  const out = Fabric.issueRolls({
    cutOrderId: int(ctx.params.id, 'id', { required: true }),
    rolls: b.rolls || [], epcs: b.epcs ? epcList(b.epcs, 'epcs', { required: false }) : [], userId: u.id,
  });
  auditCtx(ctx, 'FABRIC_ISSUE', 'cut_orders', ctx.params.id, { issue_no: out.issue_no, rolls: out.issued.length });
  ok(ctx.res, out);
});

api.post('/api/cutting/orders/:id/bundles', async (ctx) => {
  const u = requireCap(ctx, 'cutting.manage');
  const b = await readJson(ctx.req);
  const out = Fabric.createBundles({
    cutOrderId: int(ctx.params.id, 'id', { required: true }), lines: b.lines, userId: u.id });
  auditCtx(ctx, 'BUNDLES_CREATE', 'cut_orders', ctx.params.id, { bundles: out.bundles.length, qty: out.total_qty });
  created(ctx.res, out);
});

api.get('/api/cutting/bundles', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: Fabric.openBundles({ status: ctx.query.status, q: ctx.query.q, limit: Number(ctx.query.limit) || 200 }) });
});

api.post('/api/cutting/bundles/issue', async (ctx) => {
  const u = requireCap(ctx, 'cutting.manage');
  const b = await readJson(ctx.req);
  if (!Array.isArray(b.bundle_ids) || !b.bundle_ids.length) throw badRequest('Select at least one bundle');
  const out = Fabric.issueBundlesToStitching({ bundleIds: b.bundle_ids.map(Number), userId: u.id });
  auditCtx(ctx, 'BUNDLE_ISSUE', 'bundles', null, out);
  ok(ctx.res, out);
});

/* =================================================================== */
/* Stitching                                                           */
/* =================================================================== */
api.post('/api/stitching/bundles/:id/receive', async (ctx) => {
  const u = requireCap(ctx, 'stitching.commission');
  const b = await readJson(ctx.req);
  const out = Fabric.receiveBundle({
    bundleId: int(ctx.params.id, 'id', { required: true }),
    countedQty: int(b.counted_qty, 'counted_qty', { required: true, min: 0 }), userId: u.id });
  auditCtx(ctx, 'BUNDLE_RECEIVE', 'bundles', ctx.params.id, out);
  ok(ctx.res, out);
});

api.post('/api/stitching/commission', async (ctx) => {
  const u = requireCap(ctx, 'stitching.commission');
  const b = await readJson(ctx.req);
  const out = Articles.commissionArticles({
    bundleId: int(b.bundle_id, 'bundle_id', { required: true }),
    epcs: epcList(b.epcs), tids: b.tids || {},
    userId: u.id, readerId: ctx.reader?.id ?? (b.reader_id ? Number(b.reader_id) : null),
    orderId: b.order_id ? Number(b.order_id) : null,
  });
  auditCtx(ctx, 'COMMISSION', 'bundles', b.bundle_id, { count: out.count });
  created(ctx.res, out);
});

/* =================================================================== */
/* Articles                                                            */
/* =================================================================== */
api.get('/api/articles', (ctx) => {
  requireUser(ctx);
  const where = [];
  const params = [];
  const q = ctx.query;
  if (q.stage)       { where.push('a.stage = ?');       params.push(q.stage); }
  if (q.status)      { where.push('a.status = ?');      params.push(q.status); }
  if (q.qc_state)    { where.push('a.qc_state = ?');    params.push(q.qc_state); }
  if (q.order_id)    { where.push('a.order_id = ?');    params.push(Number(q.order_id)); }
  if (q.customer_id) { where.push('a.customer_id = ?'); params.push(Number(q.customer_id)); }
  if (q.style_id)    { where.push('a.style_id = ?');    params.push(Number(q.style_id)); }
  if (q.size_id)     { where.push('a.size_id = ?');     params.push(Number(q.size_id)); }
  if (q.arrived_doc) { where.push('a.arrived_doc = ?'); params.push(Number(q.arrived_doc)); }
  if (q.q) {
    where.push('(a.serial_no LIKE ? OR a.epc LIKE ? OR a.final_tag_epc LIKE ?)');
    const like = `%${String(q.q).toUpperCase()}%`;
    params.push(like, like, like);
  }
  const limit = Math.min(Number(q.limit) || 100, 1000);
  const offset = Number(q.offset) || 0;
  const rows = all(
    `${Articles.ARTICLE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.stage_since DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = get(`SELECT COUNT(*) AS c FROM articles a ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...params).c;
  ok(ctx.res, { rows, total, limit, offset });
});

api.get('/api/articles/by-epc/:epc', (ctx) => {
  requireUser(ctx);
  const art = Articles.articleByEpc(ctx.params.epc);
  ok(ctx.res, { article: art, history: Articles.articleHistory(art.id) });
});

api.post('/api/articles/resolve', async (ctx) => {
  requireUser(ctx);
  const b = await readJson(ctx.req);
  const { found, unknown } = Articles.resolveEpcs(epcList(b.epcs));
  ok(ctx.res, { articles: [...found.values()], unknown, count: found.size, summary: Movement.summarise([...found.values()]) });
});

api.get('/api/articles/:id', (ctx) => {
  requireUser(ctx);
  const id = int(ctx.params.id, 'id', { required: true });
  ok(ctx.res, {
    article: Articles.articleById(id),
    history: Articles.articleHistory(id),
    qc: QC.articleQcFile(id),
    tags: all('SELECT * FROM epc_history WHERE article_id = ? ORDER BY id', id),
  });
});

api.get('/api/articles/:id/history', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { history: Articles.articleHistory(int(ctx.params.id, 'id', { required: true })) });
});

api.post('/api/articles/:id/tag-swap', async (ctx) => {
  const u = requireCap(ctx, 'article.adjust');
  const b = await readJson(ctx.req);
  const out = Articles.swapTrackingTag({
    articleId: int(ctx.params.id, 'id', { required: true }),
    newEpc: epcList([b.new_epc])[0], userId: u.id, reason: str(b.reason, 'reason', { required: true }),
  });
  auditCtx(ctx, 'TAG_SWAP', 'articles', ctx.params.id, out);
  ok(ctx.res, out);
});

api.post('/api/articles/:id/adjust', async (ctx) => {
  const u = requireCap(ctx, 'article.adjust');
  const b = await readJson(ctx.req);
  const out = Articles.adjustStage({
    articleId: int(ctx.params.id, 'id', { required: true }),
    toStage: oneOf(b.stage, 'stage', STAGE_CODES, { required: true }),
    status: oneOf(b.status, 'status', ['IN_STAGE', 'HOLD', 'REWORK', 'READY', 'SCRAP']),
    userId: u.id, reason: str(b.reason, 'reason', { required: true }),
  });
  auditCtx(ctx, 'ARTICLE_ADJUST', 'articles', ctx.params.id, { stage: b.stage, reason: b.reason });
  ok(ctx.res, { article: out });
});

/* =================================================================== */
/* Sorting stations                                                    */
/* =================================================================== */
api.get('/api/sorting/sessions', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: Sorting.listSessions({ stage: ctx.query.stage, status: ctx.query.status }) });
});

api.post('/api/sorting/sessions', async (ctx) => {
  const u = requireCap(ctx, 'sort.run');
  const b = await readJson(ctx.req);
  const s = Sorting.openSession({
    stage: oneOf(b.stage, 'stage', STAGE_CODES, { required: true }),
    groupBy: b.group_by, userId: u.id, readerId: ctx.reader?.id ?? null,
  });
  auditCtx(ctx, 'SORT_OPEN', 'sort_sessions', s.id, { session_no: s.session_no, group_by: s.group_by });
  created(ctx.res, { session: s });
});

api.get('/api/sorting/sessions/:id', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, Sorting.sessionDetail(int(ctx.params.id, 'id', { required: true })));
});

api.post('/api/sorting/sessions/:id/read', async (ctx) => {
  const u = requireCap(ctx, 'sort.run');
  const b = await readJson(ctx.req);
  ok(ctx.res, Sorting.addReads({
    sessionId: int(ctx.params.id, 'id', { required: true }), epcs: epcList(b.epcs), userId: u.id }));
});

api.post('/api/sorting/sessions/:id/dispatch', async (ctx) => {
  const u = requireCap(ctx, 'movement.dispatch');
  const b = await readJson(ctx.req);
  const out = Sorting.dispatchBucket({
    sessionId: int(ctx.params.id, 'id', { required: true }),
    bucketKey: str(b.bucket_key, 'bucket_key', { required: true }),
    to: oneOf(b.to, 'to', STAGE_CODES, { required: true }),
    userId: u.id, readerId: ctx.reader?.id ?? null,
    batchRef: str(b.batch_ref, 'batch_ref'), washRecipe: str(b.wash_recipe, 'wash_recipe'),
    remarks: str(b.remarks, 'remarks'), requireQcPass: bool(b.require_qc_pass, false),
  });
  auditCtx(ctx, 'SORT_DISPATCH', 'movement_docs', out.doc.id, { doc_no: out.doc.doc_no, qty: out.accepted });
  created(ctx.res, out);
});

api.post('/api/sorting/sessions/:id/close', async (ctx) => {
  const u = requireCap(ctx, 'sort.run');
  const s = Sorting.closeSession({ sessionId: int(ctx.params.id, 'id', { required: true }), userId: u.id });
  auditCtx(ctx, 'SORT_CLOSE', 'sort_sessions', s.id, { session_no: s.session_no });
  ok(ctx.res, { session: s });
});

/* =================================================================== */
/* Movement documents                                                  */
/* =================================================================== */
api.get('/api/movements', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, Movement.listDocs({
    stage: ctx.query.stage, direction: ctx.query.direction || 'any', status: ctx.query.status,
    from: ctx.query.from, to: ctx.query.to, q: ctx.query.q,
    limit: Number(ctx.query.limit) || 100, offset: Number(ctx.query.offset) || 0,
  }));
});

api.get('/api/movements/pending/:stage', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: Movement.pendingInbound(oneOf(ctx.params.stage, 'stage', STAGE_CODES, { required: true })) });
});

api.post('/api/movements/candidates', async (ctx) => {
  requireUser(ctx);
  const b = await readJson(ctx.req);
  const rows = Movement.candidatesFor(oneOf(b.stage, 'stage', STAGE_CODES, { required: true }), b.filter || {});
  ok(ctx.res, { rows, count: rows.length, summary: Movement.summarise(rows) });
});

api.post('/api/movements/dispatch', async (ctx) => {
  const u = requireCap(ctx, 'movement.dispatch');
  const b = await readJson(ctx.req);
  const out = Movement.dispatch({
    from: oneOf(b.from, 'from', STAGE_CODES, { required: true }),
    to: oneOf(b.to, 'to', STAGE_CODES, { required: true }),
    epcs: epcList(b.epcs), userId: u.id, readerId: ctx.reader?.id ?? (b.reader_id ? Number(b.reader_id) : null),
    batchRef: str(b.batch_ref, 'batch_ref'), washRecipe: str(b.wash_recipe, 'wash_recipe'),
    groupKey: str(b.group_key, 'group_key'), remarks: str(b.remarks, 'remarks'),
    requireQcPass: bool(b.require_qc_pass, false), allowPartial: bool(b.allow_partial, true),
  });
  auditCtx(ctx, 'DISPATCH', 'movement_docs', out.doc.id,
    { doc_no: out.doc.doc_no, from: b.from, to: b.to, qty: out.accepted, rejected: out.rejected.length });
  created(ctx.res, out);
});

api.get('/api/movements/:id', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, Movement.docDetail(int(ctx.params.id, 'id', { required: true })));
});

api.get('/api/movements/:id/lines', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: Movement.docLines(int(ctx.params.id, 'id', { required: true }), {
    state: ctx.query.state, limit: Number(ctx.query.limit) || 2000, offset: Number(ctx.query.offset) || 0 }) });
});

api.post('/api/movements/:id/receive', async (ctx) => {
  const u = requireCap(ctx, 'movement.receive');
  const b = await readJson(ctx.req);
  const out = Movement.receive({
    docId: int(ctx.params.id, 'id', { required: true }), epcs: epcList(b.epcs),
    userId: u.id, readerId: ctx.reader?.id ?? (b.reader_id ? Number(b.reader_id) : null),
    acceptExtras: bool(b.accept_extras, false), remarks: str(b.remarks, 'remarks'),
  });
  auditCtx(ctx, 'RECEIVE', 'movement_docs', ctx.params.id,
    { doc_no: out.doc.doc_no, received: out.tally.received, missing: out.tally.missing, extra: out.tally.extra });
  ok(ctx.res, out);
});

api.post('/api/movements/:id/close-variance', async (ctx) => {
  const u = requireCap(ctx, 'movement.close_variance');
  const b = await readJson(ctx.req);
  const out = Movement.closeVariance({
    docId: int(ctx.params.id, 'id', { required: true }), note: str(b.note, 'note', { required: true }),
    userId: u.id, disposition: oneOf(b.disposition, 'disposition', ['HOLD', 'SCRAP']) || 'HOLD',
  });
  auditCtx(ctx, 'VARIANCE_CLOSE', 'movement_docs', ctx.params.id, { note: b.note, affected: out.affected });
  ok(ctx.res, out);
});

api.post('/api/movements/:id/cancel', async (ctx) => {
  const u = requireCap(ctx, 'movement.close_variance');
  const b = await readJson(ctx.req);
  const out = Movement.cancelDoc({
    docId: int(ctx.params.id, 'id', { required: true }), userId: u.id,
    reason: str(b.reason, 'reason', { required: true }) });
  auditCtx(ctx, 'DISPATCH_CANCEL', 'movement_docs', ctx.params.id, { reason: b.reason });
  ok(ctx.res, out);
});

api.get('/api/movements/:id/print', (ctx) => {
  requireUser(ctx);
  const detail = Movement.docDetail(int(ctx.params.id, 'id', { required: true }));
  const lines = Movement.docLines(detail.doc.id, { limit: 10000 });
  sendText(ctx.res, 200, printDocument(detail, lines), 'text/html; charset=utf-8');
});

api.get('/api/movements/:id/export', (ctx) => {
  requireUser(ctx);
  const id = int(ctx.params.id, 'id', { required: true });
  const doc = Movement.docById(id);
  const rows = Movement.docLines(id, { limit: 100000 });
  const cols = [
    { key: 'epc', label: 'EPC' }, { key: 'serial_no', label: 'Serial No' },
    { key: 'style_code', label: 'Style' }, { key: 'color_code', label: 'Colour' },
    { key: 'size_code', label: 'Size' }, { key: 'order_no', label: 'Order' },
    { key: 'line_state', label: 'State' }, { key: 'received_at', label: 'Received At' },
  ];
  sendCsv(ctx.res, `${doc.doc_no}.csv`, toCsv(cols, rows));
});

/* =================================================================== */
/* QC                                                                  */
/* =================================================================== */
api.get('/api/qc/queue', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: QC.qcQueue({
    limit: Number(ctx.query.limit) || 200, offset: Number(ctx.query.offset) || 0, qcState: ctx.query.qc_state }) });
});

api.post('/api/qc/inspect', async (ctx) => {
  const u = requireCap(ctx, 'qc.inspect');
  const b = await readJson(ctx.req);
  const out = QC.inspect({
    articleId: b.article_id ? Number(b.article_id) : null,
    epc: b.epc ? epcList([b.epc])[0] : null,
    result: oneOf(b.result, 'result', ['PASS', 'FAIL'], { required: true }),
    defects: b.defects || [], remarks: str(b.remarks, 'remarks'),
    inspectorId: u.id, readerId: ctx.reader?.id ?? null,
  });
  auditCtx(ctx, `QC_${b.result}`, 'articles', out.article.id,
    { serial_no: out.article.serial_no, defects: (b.defects || []).length });
  created(ctx.res, out);
});

api.post('/api/qc/batch-pass', async (ctx) => {
  const u = requireCap(ctx, 'qc.inspect');
  const b = await readJson(ctx.req);
  const out = QC.batchPass({ epcs: epcList(b.epcs), inspectorId: u.id, readerId: ctx.reader?.id ?? null, remarks: str(b.remarks, 'remarks') });
  auditCtx(ctx, 'QC_BATCH_PASS', 'articles', null, { passed: out.passed, skipped: out.skipped.length });
  ok(ctx.res, out);
});

api.get('/api/qc/article/:id', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, QC.articleQcFile(int(ctx.params.id, 'id', { required: true })));
});

api.get('/api/qc/pareto', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: QC.defectPareto({
    from: ctx.query.from, to: ctx.query.to,
    styleId: ctx.query.style_id ? Number(ctx.query.style_id) : null }) });
});

api.get('/api/qc/defect-map', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: QC.defectMap({
    styleId: int(ctx.query.style_id, 'style_id', { required: true }),
    view: (ctx.query.view || 'FRONT').toUpperCase(), from: ctx.query.from, to: ctx.query.to }) });
});

/* =================================================================== */
/* Retrofitting                                                        */
/* =================================================================== */
api.get('/api/rework/queue', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: QC.reworkQueue({
    limit: Number(ctx.query.limit) || 200, offset: Number(ctx.query.offset) || 0, status: ctx.query.status }) });
});

api.get('/api/rework/scan/:epc', (ctx) => {
  requireCap(ctx, 'rework.perform');
  ok(ctx.res, QC.reworkScan(ctx.params.epc));
});

api.post('/api/rework/:id/start', (ctx) => {
  const u = requireCap(ctx, 'rework.perform');
  ok(ctx.res, { job: QC.startRework({ articleId: int(ctx.params.id, 'id', { required: true }), userId: u.id }) });
});

api.post('/api/rework/:id/complete', async (ctx) => {
  const u = requireCap(ctx, 'rework.perform');
  const b = await readJson(ctx.req);
  const out = QC.completeRework({
    articleId: int(ctx.params.id, 'id', { required: true }), userId: u.id,
    actionTaken: str(b.action_taken, 'action_taken', { required: true }),
    resolvedDefectIds: b.resolved_defect_ids || null, remarks: str(b.remarks, 'remarks'),
  });
  auditCtx(ctx, 'REWORK_DONE', 'articles', ctx.params.id, { action: b.action_taken });
  ok(ctx.res, out);
});

api.post('/api/rework/:id/scrap', async (ctx) => {
  const u = requireCap(ctx, 'article.adjust');
  const b = await readJson(ctx.req);
  const out = QC.scrapArticle({
    articleId: int(ctx.params.id, 'id', { required: true }), userId: u.id,
    reason: str(b.reason, 'reason', { required: true }) });
  auditCtx(ctx, 'SCRAP', 'articles', ctx.params.id, { reason: b.reason });
  ok(ctx.res, { article: out });
});

/* =================================================================== */
/* Dispatch & shipping                                                 */
/* =================================================================== */
api.get('/api/dispatch/shipments', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: Dispatch.listShipments({
    status: ctx.query.status, customerId: ctx.query.customer_id ? Number(ctx.query.customer_id) : null }) });
});

api.post('/api/dispatch/shipments', async (ctx) => {
  const u = requireCap(ctx, 'dispatch.tagswap');
  const b = await readJson(ctx.req);
  const s = Dispatch.createShipment({
    orderId: b.order_id ? Number(b.order_id) : null,
    customerId: b.customer_id ? Number(b.customer_id) : null,
    carrier: str(b.carrier, 'carrier'), remarks: str(b.remarks, 'remarks'), userId: u.id });
  auditCtx(ctx, 'SHIPMENT_CREATE', 'shipments', s.id, { shipment_no: s.shipment_no });
  created(ctx.res, { shipment: s });
});

api.get('/api/dispatch/ready', (ctx) => {
  requireUser(ctx);
  const rows = Dispatch.readyForTagSwap({
    customerId: ctx.query.customer_id ? Number(ctx.query.customer_id) : null,
    orderId: ctx.query.order_id ? Number(ctx.query.order_id) : null });
  ok(ctx.res, { rows, count: rows.length, summary: Movement.summarise(rows) });
});

api.get('/api/dispatch/prepare/:epc', (ctx) => {
  requireCap(ctx, 'dispatch.tagswap');
  ok(ctx.res, Dispatch.prepareSwap(ctx.params.epc));
});

api.get('/api/dispatch/shipments/:id', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { shipment: Dispatch.shipmentById(int(ctx.params.id, 'id', { required: true })) });
});

api.get('/api/dispatch/shipments/:id/lines', (ctx) => {
  requireUser(ctx);
  ok(ctx.res, { rows: Dispatch.shipmentLines(int(ctx.params.id, 'id', { required: true }), {
    limit: Number(ctx.query.limit) || 2000, offset: Number(ctx.query.offset) || 0 }) });
});

api.get('/api/dispatch/shipments/:id/print', (ctx) => {
  requireUser(ctx);
  const id = int(ctx.params.id, 'id', { required: true });
  sendText(ctx.res, 200,
    printShipment(Dispatch.shipmentById(id), Dispatch.shipmentLines(id, { limit: 100000 })),
    'text/html; charset=utf-8');
});

api.post('/api/dispatch/shipments/:id/swap', async (ctx) => {
  const u = requireCap(ctx, 'dispatch.tagswap');
  const b = await readJson(ctx.req);
  const out = Dispatch.swapTags({
    shipmentId: int(ctx.params.id, 'id', { required: true }),
    pairs: b.pairs, cartonNo: str(b.carton_no, 'carton_no'), userId: u.id });
  auditCtx(ctx, 'TAG_SWAP_DISPATCH', 'shipments', ctx.params.id,
    { swapped: out.swapped, failed: out.failed.length });
  ok(ctx.res, out);
});

api.post('/api/dispatch/shipments/:id/ship', async (ctx) => {
  const u = requireCap(ctx, 'dispatch.ship');
  const b = await readJson(ctx.req);
  const out = Dispatch.ship({
    shipmentId: int(ctx.params.id, 'id', { required: true }), carrier: str(b.carrier, 'carrier'), userId: u.id });
  auditCtx(ctx, 'SHIP', 'shipments', ctx.params.id, { qty: out.shipped });
  ok(ctx.res, out);
});

/* =================================================================== */
/* KPIs                                                                */
/* =================================================================== */
api.get('/api/kpi/headline', (ctx) => { requireCap(ctx, 'kpi.view'); ok(ctx.res, KPI.plantHeadline()); });
api.get('/api/kpi/overview', (ctx) => { requireCap(ctx, 'kpi.view'); ok(ctx.res, KPI.sectionOverview()); });
api.get('/api/kpi/alerts',   (ctx) => { requireCap(ctx, 'kpi.view'); ok(ctx.res, KPI.alerts()); });
api.get('/api/kpi/dwell',    (ctx) => { requireCap(ctx, 'kpi.view'); ok(ctx.res, { rows: KPI.dwellTimes({ days: Number(ctx.query.days) || 7 }) }); });

api.post('/api/kpi/wip', async (ctx) => {
  requireCap(ctx, 'kpi.view');
  const b = await readJson(ctx.req);
  ok(ctx.res, KPI.wipBreakdown({
    stage: b.stage || null, groupBy: b.group_by || ['style', 'color', 'size'],
    filters: b.filters || {}, sort: b.sort || 'qty_desc', limit: Number(b.limit) || 500 }));
});

api.get('/api/kpi/receipts/:stage', (ctx) => {
  requireCap(ctx, 'kpi.view');
  ok(ctx.res, { rows: KPI.receiptsInto(
    oneOf(ctx.params.stage, 'stage', STAGE_CODES, { required: true }),
    { limit: Number(ctx.query.limit) || 100, from: ctx.query.from, to: ctx.query.to }) });
});

api.get('/api/kpi/throughput', (ctx) => {
  requireCap(ctx, 'kpi.view');
  ok(ctx.res, { rows: KPI.throughput({
    from: ctx.query.from, to: ctx.query.to,
    bucket: oneOf(ctx.query.bucket, 'bucket', ['hour', 'day', 'shift']) || 'hour',
    stage: ctx.query.stage }) });
});

api.get('/api/kpi/shifts', (ctx) => {
  requireCap(ctx, 'kpi.view');
  ok(ctx.res, { rows: KPI.shiftPerformance({ date: ctx.query.date, days: Number(ctx.query.days) || 7 }) });
});

api.get('/api/kpi/operators', (ctx) => {
  requireCap(ctx, 'kpi.view');
  ok(ctx.res, { rows: KPI.operatorProductivity({
    from: ctx.query.from, to: ctx.query.to, stage: ctx.query.stage, limit: Number(ctx.query.limit) || 50 }) });
});

api.get('/api/kpi/quality', (ctx) => {
  requireCap(ctx, 'kpi.view');
  ok(ctx.res, KPI.qualitySummary({ from: ctx.query.from, to: ctx.query.to }));
});

/* =================================================================== */
/* Report builder                                                      */
/* =================================================================== */
api.get('/api/reports/catalogue', (ctx) => { requireCap(ctx, 'reports.view'); ok(ctx.res, Reports.catalogue()); });

api.post('/api/reports/run', async (ctx) => {
  requireCap(ctx, 'reports.view');
  const b = await readJson(ctx.req);
  ok(ctx.res, Reports.runReport(b));
});

api.post('/api/reports/export', async (ctx) => {
  requireCap(ctx, 'reports.view');
  const b = await readJson(ctx.req);
  const out = Reports.runReport({ ...b, limit: Math.min(Number(b.limit) || 50000, 200000) }, { limitCap: 200000 });
  const name = (b.name || 'report').replace(/[^A-Za-z0-9_-]+/g, '_');
  sendCsv(ctx.res, `${name}_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(out.columns, out.rows));
});

api.get('/api/reports/saved', (ctx) => {
  const u = requireCap(ctx, 'reports.view');
  ok(ctx.res, { rows: Reports.listReports(u.id) });
});

api.post('/api/reports/saved', async (ctx) => {
  const u = requireCap(ctx, 'reports.design');
  const b = await readJson(ctx.req);
  const r = Reports.saveReport({
    id: b.id ? Number(b.id) : null, name: str(b.name, 'name', { required: true }),
    dataset: str(b.dataset, 'dataset', { required: true }), definition: b.definition || {},
    shared: bool(b.shared, true), userId: u.id });
  auditCtx(ctx, 'REPORT_SAVE', 'report_defs', r.id, { name: r.name });
  ok(ctx.res, { report: r });
});

api.get('/api/reports/saved/:id', (ctx) => {
  requireCap(ctx, 'reports.view');
  ok(ctx.res, { report: Reports.reportById(int(ctx.params.id, 'id', { required: true })) });
});

api.del('/api/reports/saved/:id', (ctx) => {
  const u = requireCap(ctx, 'reports.design');
  const r = Reports.reportById(int(ctx.params.id, 'id', { required: true }));
  if (r.owner_id && r.owner_id !== u.id && !roleHas(u.role, 'admin.users')) {
    throw forbidden('Only the owner or an administrator can delete this report');
  }
  auditCtx(ctx, 'REPORT_DELETE', 'report_defs', r.id, { name: r.name });
  ok(ctx.res, Reports.deleteReport(r.id));
});

/* =================================================================== */
/* Administration                                                      */
/* =================================================================== */
api.get('/api/admin/users', (ctx) => {
  requireCap(ctx, 'admin.users');
  ok(ctx.res, { rows: all('SELECT id, username, full_name, emp_code, role, section, active, created_at FROM users ORDER BY username') });
});

api.post('/api/admin/users', async (ctx) => {
  requireCap(ctx, 'admin.users');
  const b = await readJson(ctx.req);
  const username = str(b.username, 'username', { required: true, max: 40 });
  if (get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', username)) {
    throw conflict(`Username "${username}" is taken`);
  }
  const password = str(b.password, 'password', { required: true });
  if (password.length < 6) throw badRequest('Password must be at least 6 characters');
  const { hash, salt } = hashPassword(password);
  const res = run(
    `INSERT INTO users(username, full_name, emp_code, pass_hash, pass_salt, role, section, active)
     VALUES(?,?,?,?,?,?,?,1)`,
    username, str(b.full_name, 'full_name', { required: true }), str(b.emp_code, 'emp_code'),
    hash, salt, oneOf(b.role, 'role', Object.keys(ROLES), { required: true }),
    b.section ? oneOf(b.section, 'section', STAGE_CODES) : null);
  const id = Number(res.lastInsertRowid);
  auditCtx(ctx, 'USER_CREATE', 'users', id, { username, role: b.role });
  created(ctx.res, { user: publicUser(get('SELECT * FROM users WHERE id = ?', id)) });
});

api.put('/api/admin/users/:id', async (ctx) => {
  const me = requireCap(ctx, 'admin.users');
  const id = int(ctx.params.id, 'id', { required: true });
  const b = await readJson(ctx.req);
  const target = get('SELECT * FROM users WHERE id = ?', id);
  if (!target) throw notFound('User not found');
  if (target.id === me.id && b.active === false) throw badRequest('You cannot deactivate your own account');

  const sets = [];
  const params = [];
  if (b.full_name !== undefined) { sets.push('full_name = ?'); params.push(str(b.full_name, 'full_name', { required: true })); }
  if (b.emp_code !== undefined)  { sets.push('emp_code = ?');  params.push(str(b.emp_code, 'emp_code')); }
  if (b.role !== undefined)      { sets.push('role = ?');      params.push(oneOf(b.role, 'role', Object.keys(ROLES), { required: true })); }
  if (b.section !== undefined)   { sets.push('section = ?');   params.push(b.section ? oneOf(b.section, 'section', STAGE_CODES) : null); }
  if (b.active !== undefined)    { sets.push('active = ?');    params.push(bool(b.active, true) ? 1 : 0); }
  if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  if (b.password) changePassword(id, b.password);
  auditCtx(ctx, 'USER_UPDATE', 'users', id, { fields: Object.keys(b).filter((k) => k !== 'password') });
  ok(ctx.res, { user: publicUser(get('SELECT * FROM users WHERE id = ?', id)) });
});

api.get('/api/admin/readers', (ctx) => {
  requireCap(ctx, 'admin.readers');
  ok(ctx.res, { rows: all('SELECT id, code, name, section, mode, host, active, last_seen_at, (api_key IS NOT NULL) AS has_key FROM readers ORDER BY section, code') });
});

api.post('/api/admin/readers/:id/key', (ctx) => {
  requireCap(ctx, 'admin.readers');
  const id = int(ctx.params.id, 'id', { required: true });
  const key = randomBytes(24).toString('hex');
  const r = run('UPDATE readers SET api_key = ? WHERE id = ?', key, id);
  if (!r.changes) throw notFound('Reader not found');
  auditCtx(ctx, 'READER_KEY_ISSUED', 'readers', id, null);
  ok(ctx.res, { api_key: key, note: 'Store this key on the reader now - it is not shown again' });
});

api.get('/api/admin/audit', (ctx) => {
  requireCap(ctx, 'admin.audit');
  const where = [];
  const params = [];
  if (ctx.query.user)   { where.push('username = ?'); params.push(ctx.query.user); }
  if (ctx.query.action) { where.push('action = ?');   params.push(ctx.query.action); }
  if (ctx.query.entity) { where.push('entity = ?');   params.push(ctx.query.entity); }
  if (ctx.query.from)   { where.push('ts >= ?');      params.push(ctx.query.from); }
  if (ctx.query.to)     { where.push('ts <= ?');      params.push(ctx.query.to + ' 23:59:59'); }
  ok(ctx.res, { rows: all(
    `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ts DESC, id DESC LIMIT ?`, ...params, Math.min(Number(ctx.query.limit) || 200, 2000)) });
});

api.get('/api/admin/sessions', (ctx) => {
  const u = requireUser(ctx);
  ok(ctx.res, { rows: listSessions(u.id) });
});

/* =================================================================== */
/* Reader gateway - fixed readers post here with X-Reader-Key           */
/* =================================================================== */
api.get('/api/gateway/ping', (ctx) => {
  if (!ctx.reader) throw forbidden('A valid reader key is required');
  ok(ctx.res, { reader: { code: ctx.reader.code, name: ctx.reader.name, section: ctx.reader.section, mode: ctx.reader.mode },
    server_time: new Date().toISOString(), shift: shiftFor() });
});

/**
 * Generic tag-stream endpoint. A portal or tunnel reader just posts what it saw;
 * the server resolves the tags and reports where each garment is, so the reader
 * needs no business logic of its own.
 */
api.post('/api/gateway/reads', async (ctx) => {
  if (!ctx.reader) throw forbidden('A valid reader key is required');
  const b = await readJson(ctx.req);
  const epcs = epcList(b.epcs);
  const { found, unknown } = Articles.resolveEpcs(epcs);
  const articles = [...found.values()];
  ok(ctx.res, {
    reader: ctx.reader.code, section: ctx.reader.section,
    read_count: epcs.length, resolved: articles.length, unknown,
    in_this_section: articles.filter((a) => a.stage === ctx.reader.section).length,
    elsewhere: articles.filter((a) => a.stage !== ctx.reader.section)
      .map((a) => ({ epc: a.epc, serial_no: a.serial_no, stage: a.stage, status: a.status })),
    summary: Movement.summarise(articles),
  });
});

/* =================================================================== */
/* Tag simulator - lets the whole flow be exercised without hardware    */
/* =================================================================== */
api.post('/api/sim/tags', async (ctx) => {
  requireUser(ctx);
  const b = await readJson(ctx.req);
  const count = int(b.count, 'count', { required: true, min: 1, max: 5000 });
  const prefix = (str(b.prefix, 'prefix') || 'E280').toUpperCase();
  const epcs = [];
  const seen = new Set();
  while (epcs.length < count) {
    const epc = (prefix + randomBytes(12).toString('hex').toUpperCase()).slice(0, 24);
    if (seen.has(epc)) continue;
    if (get('SELECT 1 AS x FROM articles WHERE epc = ?', epc)) continue;
    seen.add(epc);
    epcs.push(epc);
  }
  ok(ctx.res, { epcs, count: epcs.length });
});

/** Read back the tags currently sitting in a section - stands in for a portal scan. */
api.get('/api/sim/section/:stage', (ctx) => {
  requireUser(ctx);
  const stage = oneOf(ctx.params.stage, 'stage', STAGE_CODES, { required: true });
  const limit = Math.min(Number(ctx.query.limit) || 200, 20000);
  const status = ctx.query.status || 'IN_STAGE';
  const rows = all(
    `SELECT epc FROM articles WHERE stage = ? AND status = ? ORDER BY stage_since LIMIT ?`,
    stage, status, limit);
  ok(ctx.res, { epcs: rows.map((r) => r.epc), count: rows.length });
});

/** Tags belonging to an open dispatch document - stands in for the receiving portal. */
api.get('/api/sim/doc/:id', (ctx) => {
  requireUser(ctx);
  const id = int(ctx.params.id, 'id', { required: true });
  const drop = Math.max(0, Number(ctx.query.drop) || 0);   // simulate misreads
  const rows = all(
    `SELECT dl.epc FROM doc_lines dl WHERE dl.doc_id = ? AND dl.line_state = 'EXPECTED' ORDER BY dl.id`, id);
  const epcs = rows.map((r) => r.epc);
  ok(ctx.res, { epcs: drop ? epcs.slice(0, Math.max(0, epcs.length - drop)) : epcs, dropped: Math.min(drop, epcs.length) });
});

export default api;
