import { db, all, get, run, tx, nextNumber } from '../lib/db.js';
import { STAGES, SORT_DIMENSIONS } from '../lib/process.js';
import { badRequest, notFound, conflict } from '../lib/http.js';
import { resolveEpcs, logEvents } from './articles.js';
import { dispatch } from './movement.js';

/**
 * Sorting stations. An operator bulk-reads a pile of garments; the system
 * splits the read into buckets by the chosen dimensions (design/colour/size
 * before wash, customer order/size/type after wash) and each bucket can then be
 * dispatched as its own batch with its own document.
 */

const DIM_KEYS = Object.keys(SORT_DIMENSIONS);

function bucketOf(article, dims) {
  return dims.map((d) => {
    switch (d) {
      case 'style':    return article.style_code;
      case 'color':    return article.color_code;
      case 'size':     return article.size_code;
      case 'order':    return article.order_no || 'NO-ORDER';
      case 'customer': return article.customer_code || 'NO-CUSTOMER';
      case 'fabric':   return article.fabric_code || 'NO-FABRIC';
      default:         return '';
    }
  }).join(' | ');
}

export function openSession({ stage, groupBy, userId, readerId = null }) {
  if (!STAGES[stage]) throw badRequest(`Unknown section ${stage}`);
  const dims = (Array.isArray(groupBy) ? groupBy : String(groupBy || '').split(','))
    .map((s) => s.trim()).filter(Boolean);
  if (!dims.length) throw badRequest('Choose at least one dimension to sort by');
  for (const d of dims) if (!DIM_KEYS.includes(d)) throw badRequest(`Unknown sort dimension "${d}"`);

  const no = nextNumber('SRT');
  const res = run(
    `INSERT INTO sort_sessions(session_no, stage, group_by, created_by, reader_id) VALUES(?,?,?,?,?)`,
    no, stage, dims.join(','), userId ?? null, readerId);
  return sessionById(Number(res.lastInsertRowid));
}

export function sessionById(id) {
  const s = get(
    `SELECT ss.*, u.full_name AS created_by_name, r.code AS reader_code
       FROM sort_sessions ss
       LEFT JOIN users u   ON u.id = ss.created_by
       LEFT JOIN readers r ON r.id = ss.reader_id
      WHERE ss.id = ?`, id);
  if (!s) throw notFound('Sorting session not found');
  return s;
}

/** Add a bulk read to an open session. Safe to call repeatedly. */
export function addReads({ sessionId, epcs, userId }) {
  return tx(() => {
    const s = sessionById(sessionId);
    if (s.status !== 'OPEN') throw conflict(`Session ${s.session_no} is closed`);
    const dims = s.group_by.split(',');

    const { found, unknown } = resolveEpcs(epcs);
    const existing = new Set(all('SELECT epc FROM sort_reads WHERE session_id = ?', sessionId).map((r) => r.epc));

    const ins = db.prepare(
      `INSERT INTO sort_reads(session_id, article_id, epc, bucket_key, state) VALUES(?,?,?,?,?)`);

    let added = 0, dupes = 0, wrongStage = 0;
    for (const [scanned, art] of found) {
      if (existing.has(scanned)) { dupes++; continue; }
      let state = 'OK';
      if (art.stage !== s.stage) { state = 'WRONG_STAGE'; wrongStage++; }
      else if (art.status === 'IN_TRANSIT') state = 'WRONG_STAGE';
      ins.run(sessionId, art.id, scanned, state === 'OK' ? bucketOf(art, dims) : null, state);
      existing.add(scanned);
      added++;
    }
    for (const epc of unknown) {
      if (existing.has(epc)) { dupes++; continue; }
      ins.run(sessionId, null, epc, null, 'UNKNOWN');
      existing.add(epc);
      added++;
    }

    const total = get("SELECT COUNT(*) AS c FROM sort_reads WHERE session_id = ? AND state = 'OK'", sessionId).c;
    run('UPDATE sort_sessions SET scanned = ? WHERE id = ?', total, sessionId);

    return { session: sessionById(sessionId), added, duplicates: dupes, wrong_stage: wrongStage, unknown: unknown.length,
      buckets: buckets(sessionId) };
  });
}

/** Bucket summary, plus the exception list the operator has to deal with. */
export function buckets(sessionId) {
  return all(
    `SELECT sr.bucket_key,
            COUNT(*) AS qty,
            MIN(a.style_id) AS style_id, MIN(a.color_id) AS color_id, MIN(a.size_id) AS size_id,
            MIN(a.order_id) AS order_id, MIN(a.customer_id) AS customer_id,
            MAX(st.name) AS style_name, MAX(cl.name) AS color_name, MAX(cl.hex) AS color_hex,
            MAX(sz.name) AS size_name, MAX(o.order_no) AS order_no, MAX(cu.name) AS customer_name,
            SUM(CASE WHEN a.status = 'IN_STAGE' THEN 1 ELSE 0 END) AS dispatchable
       FROM sort_reads sr
       JOIN articles a ON a.id = sr.article_id
       JOIN styles st  ON st.id = a.style_id
       JOIN colors cl  ON cl.id = a.color_id
       JOIN sizes  sz  ON sz.id = a.size_id
       LEFT JOIN orders o     ON o.id = a.order_id
       LEFT JOIN customers cu ON cu.id = a.customer_id
      WHERE sr.session_id = ? AND sr.state = 'OK'
      GROUP BY sr.bucket_key
      ORDER BY qty DESC`, sessionId);
}

export function exceptions(sessionId) {
  return all(
    `SELECT sr.epc, sr.state, a.serial_no, a.stage, a.status, st.code AS style_code, sz.code AS size_code
       FROM sort_reads sr
       LEFT JOIN articles a ON a.id = sr.article_id
       LEFT JOIN styles st  ON st.id = a.style_id
       LEFT JOIN sizes  sz  ON sz.id = a.size_id
      WHERE sr.session_id = ? AND sr.state <> 'OK'
      ORDER BY sr.state, sr.epc`, sessionId);
}

export function sessionDetail(id) {
  return { session: sessionById(id), buckets: buckets(id), exceptions: exceptions(id) };
}

/** Turn one bucket into a dispatch document for the next section. */
export function dispatchBucket({ sessionId, bucketKey, to, userId, readerId = null,
  batchRef = null, washRecipe = null, remarks = null, requireQcPass = false }) {
  const s = sessionById(sessionId);
  if (s.status !== 'OPEN') throw conflict(`Session ${s.session_no} is closed`);

  const rows = all(
    `SELECT sr.epc FROM sort_reads sr
       JOIN articles a ON a.id = sr.article_id
      WHERE sr.session_id = ? AND sr.bucket_key = ? AND sr.state = 'OK'
        AND a.status = 'IN_STAGE' AND a.stage = ?`, sessionId, bucketKey, s.stage);
  if (!rows.length) throw conflict('Nothing left to dispatch in this group - it may already have been sent');

  const result = dispatch({
    from: s.stage, to, epcs: rows.map((r) => r.epc), userId, readerId,
    batchRef, washRecipe, groupKey: `${s.group_by}=${bucketKey}`, remarks, requireQcPass,
  });
  run('UPDATE sort_sessions SET scanned = scanned WHERE id = ?', sessionId);
  return result;
}

export function closeSession({ sessionId, userId }) {
  const s = sessionById(sessionId);
  run("UPDATE sort_sessions SET status = 'CLOSED', closed_at = datetime('now','localtime') WHERE id = ?", sessionId);
  const ids = all("SELECT article_id FROM sort_reads WHERE session_id = ? AND state='OK' AND article_id IS NOT NULL", sessionId)
    .map((r) => r.article_id);
  if (ids.length) logEvents(ids, 'SORT', { from: s.stage, to: s.stage, userId, detail: { session: s.session_no, group_by: s.group_by } });
  return sessionById(sessionId);
}

export function listSessions({ stage = null, status = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (stage)  { where.push('ss.stage = ?');  params.push(stage); }
  if (status) { where.push('ss.status = ?'); params.push(status); }
  return all(
    `SELECT ss.*, u.full_name AS created_by_name
       FROM sort_sessions ss LEFT JOIN users u ON u.id = ss.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ss.created_at DESC LIMIT ?`, ...params, Math.min(limit, 200));
}
