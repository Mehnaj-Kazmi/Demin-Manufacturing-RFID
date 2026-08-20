import { db, all, get, run, tx, chunked, holders, nextNumber } from '../lib/db.js';
import { shiftFor, STAGES } from '../lib/process.js';
import { badRequest, notFound, conflict } from '../lib/http.js';

/** Canonical article projection used by every screen. */
export const ARTICLE_SELECT = `
  SELECT a.id, a.epc, a.serial_no, a.tid, a.stage, a.status, a.stage_since, a.qc_state,
         a.qc_fail_count, a.final_tag_epc, a.created_at, a.created_by, a.created_shift,
         a.in_transit_doc, a.shipped_at, a.bundle_id, a.cut_order_id, a.order_id, a.customer_id,
         a.style_id, a.color_id, a.size_id,
         st.code AS style_code, st.name AS style_name, st.image_front, st.image_back,
         cl.code AS color_code, cl.name AS color_name, cl.hex AS color_hex,
         sz.code AS size_code, sz.name AS size_name, sz.sort_ord AS size_ord,
         o.order_no, o.ship_date,
         cu.code AS customer_code, cu.name AS customer_name,
         ft.code AS fabric_code, ft.name AS fabric_name,
         b.bundle_no, co.cut_no,
         usr.full_name AS created_by_name
    FROM articles a
    JOIN styles st      ON st.id = a.style_id
    JOIN colors cl      ON cl.id = a.color_id
    JOIN sizes  sz      ON sz.id = a.size_id
    LEFT JOIN orders o     ON o.id  = a.order_id
    LEFT JOIN customers cu ON cu.id = a.customer_id
    LEFT JOIN fabric_types ft ON ft.id = st.fabric_type_id
    LEFT JOIN bundles b    ON b.id  = a.bundle_id
    LEFT JOIN cut_orders co ON co.id = a.cut_order_id
    LEFT JOIN users usr    ON usr.id = a.created_by`;

/**
 * Resolve a bulk RFID read to articles.
 *
 * Matches the active EPC first, then any tag still bound in epc_history, then the
 * customer tag. Tags that were unbound (damaged tag replaced, tracking tag removed
 * at dispatch) deliberately do NOT resolve - that physical tag is back in the pool
 * and may already be on a different garment.
 */
export function resolveEpcs(epcs) {
  const found = new Map();
  if (!epcs.length) return { found, unknown: [] };

  for (const part of chunked(epcs)) {
    const q = holders(part.length);
    for (const r of all(`${ARTICLE_SELECT} WHERE a.epc IN (${q})`, ...part)) {
      found.set(r.epc, r);
    }
  }
  let missing = epcs.filter((e) => !found.has(e));

  if (missing.length) {
    for (const part of chunked(missing)) {
      const q = holders(part.length);
      const rows = all(
        `SELECT h.epc AS scanned_epc, h.kind, a.id AS aid
           FROM epc_history h JOIN articles a ON a.id = h.article_id
          WHERE h.epc IN (${q}) AND h.unbound_at IS NULL`, ...part);
      for (const row of rows) {
        if (found.has(row.scanned_epc)) continue;
        const art = get(`${ARTICLE_SELECT} WHERE a.id = ?`, row.aid);
        if (art) found.set(row.scanned_epc, { ...art, matched_via: row.kind, scanned_epc: row.scanned_epc });
      }
    }
    missing = epcs.filter((e) => !found.has(e));
  }

  if (missing.length) {
    for (const part of chunked(missing)) {
      const q = holders(part.length);
      for (const r of all(`${ARTICLE_SELECT} WHERE a.final_tag_epc IN (${q})`, ...part)) {
        found.set(r.final_tag_epc, { ...r, matched_via: 'CUSTOMER' });
      }
    }
    missing = epcs.filter((e) => !found.has(e));
  }

  return { found, unknown: missing };
}

export function articleByEpc(epc) {
  const { found } = resolveEpcs([String(epc).trim().toUpperCase()]);
  const [art] = [...found.values()];
  if (!art) throw notFound(`No article is registered against tag ${epc}`);
  return art;
}

export function articleById(id) {
  const a = get(`${ARTICLE_SELECT} WHERE a.id = ?`, id);
  if (!a) throw notFound('Article not found');
  return a;
}

/* ------------------------------------------------------------------ */
/* Event trail                                                          */
/* ------------------------------------------------------------------ */
const insertEvent = () => db.prepare(
  `INSERT INTO article_events(article_id, event_type, stage_from, stage_to, doc_id, reader_id, user_id, shift_code, detail)
   VALUES(?,?,?,?,?,?,?,?,?)`);

let _evStmt = null;
export function logEvent(articleId, type, opts = {}) {
  _evStmt ??= insertEvent();
  _evStmt.run(
    articleId, type,
    opts.from ?? null, opts.to ?? null,
    opts.docId ?? null, opts.readerId ?? null, opts.userId ?? null,
    opts.shift ?? shiftFor(),
    opts.detail == null ? null : (typeof opts.detail === 'string' ? opts.detail : JSON.stringify(opts.detail))
  );
}

export function logEvents(articleIds, type, opts = {}) {
  _evStmt ??= insertEvent();
  const shift = opts.shift ?? shiftFor();
  const detail = opts.detail == null ? null
    : (typeof opts.detail === 'string' ? opts.detail : JSON.stringify(opts.detail));
  for (const id of articleIds) {
    _evStmt.run(id, type, opts.from ?? null, opts.to ?? null, opts.docId ?? null,
      opts.readerId ?? null, opts.userId ?? null, shift, detail);
  }
}

export function articleHistory(articleId) {
  return all(
    `SELECT e.*, u.full_name AS user_name, u.username, r.code AS reader_code, r.name AS reader_name,
            d.doc_no
       FROM article_events e
       LEFT JOIN users u   ON u.id = e.user_id
       LEFT JOIN readers r ON r.id = e.reader_id
       LEFT JOIN movement_docs d ON d.id = e.doc_id
      WHERE e.article_id = ?
      ORDER BY e.ts ASC, e.id ASC`, articleId);
}

/* ------------------------------------------------------------------ */
/* Commissioning - stitching attaches and registers the tracking tag    */
/* ------------------------------------------------------------------ */
const SERIAL_PREFIX = 'ART';

export function commissionArticles({ bundleId, epcs, tids = {}, userId, readerId, orderId = null }) {
  if (!epcs.length) throw badRequest('No tags were scanned');

  return tx(() => {
    const bundle = get(
      `SELECT b.*, c.style_id, c.color_id, c.order_id AS cut_order_ref, c.id AS cut_id, c.cut_no, c.status AS cut_status
         FROM bundles b JOIN cut_orders c ON c.id = b.cut_order_id
        WHERE b.id = ?`, bundleId);
    if (!bundle) throw notFound('Bundle not found');
    if (bundle.status === 'CLOSED') throw conflict(`Bundle ${bundle.bundle_no} is already closed`);
    if (bundle.status === 'CUT') {
      throw conflict(`Bundle ${bundle.bundle_no} has not been issued to stitching yet`);
    }

    // Tags already in use anywhere in the system are rejected, not silently reused.
    const clash = [];
    for (const part of chunked(epcs)) {
      const q = holders(part.length);
      clash.push(...all(`SELECT epc FROM articles WHERE epc IN (${q})`, ...part).map((r) => r.epc));
      clash.push(...all(`SELECT epc FROM epc_history WHERE epc IN (${q}) AND unbound_at IS NULL`, ...part).map((r) => r.epc));
    }
    const clashSet = [...new Set(clash)];
    if (clashSet.length) {
      throw conflict(
        `${clashSet.length} tag(s) are already registered to other articles`,
        { epcs: clashSet.slice(0, 50) });
    }

    const remaining = bundle.qty - bundle.tagged_qty;
    if (epcs.length > remaining) {
      throw conflict(
        `Bundle ${bundle.bundle_no} has ${remaining} garment(s) left to tag but ${epcs.length} tags were scanned`,
        { bundle_qty: bundle.qty, already_tagged: bundle.tagged_qty, scanned: epcs.length });
    }

    const orderIdFinal = orderId ?? bundle.cut_order_ref;
    const customerId = orderIdFinal
      ? (get('SELECT customer_id FROM orders WHERE id = ?', orderIdFinal)?.customer_id ?? null)
      : null;
    const shift = shiftFor();

    const insArt = db.prepare(
      `INSERT INTO articles(epc, serial_no, tid, style_id, color_id, size_id, order_id, customer_id,
                            bundle_id, cut_order_id, stage, status, stage_since, created_by, created_shift)
       VALUES(?,?,?,?,?,?,?,?,?,?, 'STITCHING', 'IN_STAGE', datetime('now','localtime'), ?, ?)`);
    const insHist = db.prepare(
      `INSERT INTO epc_history(article_id, epc, kind, user_id) VALUES(?,?,'TRACKING',?)`);

    const created = [];
    for (const epc of epcs) {
      const serial = nextNumber(SERIAL_PREFIX, { daily: true, width: 6 });
      const res = insArt.run(
        epc, serial, tids[epc] ?? null,
        bundle.style_id, bundle.color_id, bundle.size_id,
        orderIdFinal, customerId, bundle.id, bundle.cut_id, userId ?? null, shift);
      const id = Number(res.lastInsertRowid);
      insHist.run(id, epc, userId ?? null);
      logEvent(id, 'COMMISSION', {
        to: 'STITCHING', userId, readerId, shift,
        detail: { bundle: bundle.bundle_no, cut_order: bundle.cut_no, epc },
      });
      created.push({ id, epc, serial_no: serial });
    }

    const tagged = bundle.tagged_qty + epcs.length;
    run(`UPDATE bundles SET tagged_qty = ?, status = ? WHERE id = ?`,
      tagged, tagged >= bundle.qty ? 'CLOSED' : 'IN_STITCHING', bundle.id);

    return {
      created,
      count: created.length,
      bundle: { id: bundle.id, bundle_no: bundle.bundle_no, qty: bundle.qty, tagged_qty: tagged, remaining: bundle.qty - tagged },
    };
  });
}

/**
 * Replace a damaged tracking tag. The article keeps its identity and history;
 * the old EPC is unbound so it can never resolve to this garment again.
 */
export function swapTrackingTag({ articleId, newEpc, userId, reason }) {
  return tx(() => {
    const art = get('SELECT * FROM articles WHERE id = ?', articleId);
    if (!art) throw notFound('Article not found');
    if (get('SELECT id FROM articles WHERE epc = ?', newEpc)) {
      throw conflict(`Tag ${newEpc} is already registered to another article`);
    }
    const oldEpc = art.epc;
    run("UPDATE epc_history SET unbound_at = datetime('now','localtime'), reason = ? WHERE article_id = ? AND epc = ? AND unbound_at IS NULL",
      reason || 'Tag replaced', articleId, oldEpc);
    run('UPDATE articles SET epc = ? WHERE id = ?', newEpc, articleId);
    run("INSERT INTO epc_history(article_id, epc, kind, user_id, reason) VALUES(?,?,'REPLACEMENT',?,?)",
      articleId, newEpc, userId ?? null, reason || null);
    logEvent(articleId, 'TAG_SWAP', { from: art.stage, to: art.stage, userId, detail: { old_epc: oldEpc, new_epc: newEpc, reason } });
    return { article_id: articleId, old_epc: oldEpc, new_epc: newEpc };
  });
}

/** Supervisor correction of a stuck article; always leaves an audit trail. */
export function adjustStage({ articleId, toStage, status, userId, reason }) {
  if (!STAGES[toStage]) throw badRequest(`Unknown section ${toStage}`);
  return tx(() => {
    const art = get('SELECT * FROM articles WHERE id = ?', articleId);
    if (!art) throw notFound('Article not found');
    run(`UPDATE articles SET stage = ?, status = ?, stage_since = datetime('now','localtime'), in_transit_doc = NULL WHERE id = ?`,
      toStage, status || 'IN_STAGE', articleId);
    logEvent(articleId, 'ADJUST', { from: art.stage, to: toStage, userId, detail: { reason, status } });
    return articleById(articleId);
  });
}
