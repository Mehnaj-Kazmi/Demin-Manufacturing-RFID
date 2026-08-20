import { db, all, get, run, tx, nextNumber, chunked, holders } from '../lib/db.js';
import { findRoute, STAGES, shiftFor } from '../lib/process.js';
import { badRequest, notFound, conflict } from '../lib/http.js';
import { resolveEpcs, logEvents, ARTICLE_SELECT } from './articles.js';

/**
 * Inter-section transfer engine.
 *
 * Dispatch  : source bulk-reads the batch -> document is generated, articles go IN_TRANSIT.
 * Receive   : destination bulk-reads -> tally against the document, variance recorded.
 * A document may be received in several passes; stragglers picked up later just
 * flip their line from MISSING to RECEIVED.
 */

const DOC_PREFIX = {
  'STITCHING>SORTING':   'STS',
  'SORTING>WASHING':     'WSH',
  'WASHING>FINISHING':   'FIN',
  'FINISHING>QC':        'QCI',
  'QC>RETROFIT':         'RTF',
  'RETROFIT>QC':         'RQC',
  'QC>DISPATCH':         'DSP',
};

export const docPrefix = (from, to) => DOC_PREFIX[`${from}>${to}`] || 'TRF';

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */
export function dispatch({
  from, to, epcs, userId, readerId = null,
  batchRef = null, washRecipe = null, groupKey = null, remarks = null,
  requireQcPass = false, allowPartial = true,
}) {
  const route = findRoute(from, to);
  if (!route) {
    throw badRequest(`${STAGES[from]?.name || from} cannot transfer directly to ${STAGES[to]?.name || to}`);
  }
  if (!epcs.length) throw badRequest('No tags were scanned - nothing to dispatch');

  return tx(() => {
    const { found, unknown } = resolveEpcs(epcs);

    const accepted = [];
    const rejected = [];
    for (const [scanned, art] of found) {
      if (art.status === 'IN_TRANSIT') {
        const doc = get('SELECT doc_no FROM movement_docs WHERE id = ?', art.in_transit_doc);
        rejected.push({ epc: scanned, serial_no: art.serial_no, reason: 'ALREADY_IN_TRANSIT',
          message: `Already dispatched on ${doc?.doc_no || 'another document'}` });
      } else if (art.stage !== from) {
        rejected.push({ epc: scanned, serial_no: art.serial_no, reason: 'WRONG_SECTION',
          message: `Currently in ${STAGES[art.stage]?.name || art.stage}, not ${STAGES[from].name}` });
      } else if (art.status === 'SCRAP' || art.status === 'HOLD') {
        rejected.push({ epc: scanned, serial_no: art.serial_no, reason: art.status,
          message: `Article is on ${art.status.toLowerCase()} and needs supervisor release` });
      } else if (requireQcPass && art.qc_state !== 'PASS') {
        rejected.push({ epc: scanned, serial_no: art.serial_no, reason: 'QC_NOT_PASSED',
          message: `QC state is ${art.qc_state} - only QC-passed articles may go to dispatch` });
      } else {
        accepted.push(art);
      }
    }
    for (const epc of unknown) {
      rejected.push({ epc, reason: 'UNKNOWN_TAG', message: 'Tag is not registered to any article' });
    }

    if (!accepted.length) throw conflict('No valid articles in this scan', { rejected });
    if (!allowPartial && rejected.length) {
      throw conflict(`${rejected.length} tag(s) failed validation and partial dispatch is disabled`, { rejected });
    }

    const docNo = nextNumber(docPrefix(from, to));
    const res = run(
      `INSERT INTO movement_docs(doc_no, doc_type, from_stage, to_stage, status, expected_count,
                                 batch_ref, wash_recipe, group_key, created_by, dispatch_reader, remarks)
       VALUES(?, 'TRANSFER', ?, ?, 'DISPATCHED', ?, ?, ?, ?, ?, ?, ?)`,
      docNo, from, to, accepted.length, batchRef, washRecipe, groupKey, userId ?? null, readerId, remarks);
    const docId = Number(res.lastInsertRowid);

    const insLine = db.prepare(
      `INSERT INTO doc_lines(doc_id, article_id, epc, line_state) VALUES(?,?,?,'EXPECTED')`);
    const updArt = db.prepare(
      `UPDATE articles SET status = 'IN_TRANSIT', in_transit_doc = ? WHERE id = ?`);
    for (const a of accepted) {
      insLine.run(docId, a.id, a.epc);
      updArt.run(docId, a.id);
    }
    logEvents(accepted.map((a) => a.id), 'DISPATCH', {
      from, to, docId, readerId, userId, detail: { doc_no: docNo, batch_ref: batchRef },
    });

    return { doc: docById(docId), accepted: accepted.length, rejected, summary: summarise(accepted) };
  });
}

/** Build a dispatch straight from a saved sorting bucket or a query filter. */
export function candidatesFor(stage, filter = {}) {
  const where = ['a.stage = ?', "a.status = 'IN_STAGE'"];
  const params = [stage];
  if (filter.style_id)    { where.push('a.style_id = ?');    params.push(filter.style_id); }
  if (filter.color_id)    { where.push('a.color_id = ?');    params.push(filter.color_id); }
  if (filter.size_id)     { where.push('a.size_id = ?');     params.push(filter.size_id); }
  if (filter.order_id)    { where.push('a.order_id = ?');    params.push(filter.order_id); }
  if (filter.customer_id) { where.push('a.customer_id = ?'); params.push(filter.customer_id); }
  if (filter.qc_state)    { where.push('a.qc_state = ?');    params.push(filter.qc_state); }
  const limit = Math.min(Number(filter.limit) || 5000, 50000);
  return all(`${ARTICLE_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.stage_since ASC LIMIT ${limit}`, ...params);
}

/* ------------------------------------------------------------------ */
/* Receive                                                             */
/* ------------------------------------------------------------------ */
export function receive({ docId, epcs, userId, readerId = null, acceptExtras = false, remarks = null }) {
  return tx(() => {
    const doc = get('SELECT * FROM movement_docs WHERE id = ?', docId);
    if (!doc) throw notFound('Dispatch document not found');
    if (doc.status === 'CANCELLED') throw conflict(`Document ${doc.doc_no} was cancelled`);
    if (doc.status === 'CLOSED') throw conflict(`Document ${doc.doc_no} is already closed`);

    const lines = all('SELECT * FROM doc_lines WHERE doc_id = ?', docId);
    const byEpc = new Map(lines.map((l) => [l.epc, l]));

    const { found, unknown } = resolveEpcs(epcs);

    const newlyReceived = [];
    const duplicates = [];
    const extras = [];
    const extrasRejected = [];

    const markReceived = db.prepare(
      "UPDATE doc_lines SET line_state = 'RECEIVED', received_at = datetime('now','localtime') WHERE id = ?");
    // arrived_doc lets KPI screens group a section's WIP by the batch it came in on.
    const moveArt = db.prepare(
      `UPDATE articles SET stage = ?, status = 'IN_STAGE', stage_since = datetime('now','localtime'),
                           in_transit_doc = NULL, arrived_doc = ? WHERE id = ?`);

    for (const [scanned, art] of found) {
      const line = byEpc.get(scanned) || byEpc.get(art.epc);
      if (line) {
        if (line.line_state === 'RECEIVED') { duplicates.push({ epc: scanned, serial_no: art.serial_no }); continue; }
        markReceived.run(line.id);
        moveArt.run(doc.to_stage, docId, art.id);
        newlyReceived.push(art);
      } else if (art.stage === doc.to_stage && art.status === 'IN_STAGE') {
        // Already sitting in this section - a re-read, not a real extra.
        duplicates.push({ epc: scanned, serial_no: art.serial_no, note: 'Already in this section' });
      } else if (acceptExtras && art.stage === doc.from_stage) {
        const r = run(`INSERT INTO doc_lines(doc_id, article_id, epc, line_state, received_at)
                       VALUES(?,?,?,'EXTRA', datetime('now','localtime'))`, docId, art.id, art.epc);
        void r;
        moveArt.run(doc.to_stage, docId, art.id);
        extras.push(art);
      } else {
        const where = STAGES[art.stage]?.name || art.stage;
        extrasRejected.push({ epc: scanned, serial_no: art.serial_no, reason: 'NOT_ON_DOCUMENT',
          message: `Not listed on ${doc.doc_no}; article is in ${where}` });
        run(`INSERT OR IGNORE INTO doc_lines(doc_id, article_id, epc, line_state, received_at)
             VALUES(?,?,?,'EXTRA', datetime('now','localtime'))`, docId, art.id, art.epc);
      }
    }
    for (const epc of unknown) {
      extrasRejected.push({ epc, reason: 'UNKNOWN_TAG', message: 'Tag is not registered to any article' });
      run(`INSERT OR IGNORE INTO doc_lines(doc_id, article_id, epc, line_state, received_at)
           VALUES(?,NULL,?,'UNKNOWN', datetime('now','localtime'))`, docId, epc);
    }

    const moved = [...newlyReceived, ...extras];
    if (moved.length) {
      logEvents(moved.map((a) => a.id), 'RECEIVE', {
        from: doc.from_stage, to: doc.to_stage, docId, readerId, userId,
        detail: { doc_no: doc.doc_no },
      });
    }

    // Recount from the document itself so repeated passes stay consistent.
    const tally = get(
      `SELECT
         SUM(CASE WHEN line_state IN ('RECEIVED','EXTRA') THEN 1 ELSE 0 END) AS received,
         SUM(CASE WHEN line_state = 'EXPECTED' THEN 1 ELSE 0 END)            AS missing,
         SUM(CASE WHEN line_state = 'EXTRA'    THEN 1 ELSE 0 END)            AS extra,
         SUM(CASE WHEN line_state = 'UNKNOWN'  THEN 1 ELSE 0 END)            AS unknown
       FROM doc_lines WHERE doc_id = ?`, docId);

    const missing = tally.missing ?? 0;
    const extraCount = tally.extra ?? 0;
    const status = missing === 0 && extraCount === 0 && (tally.unknown ?? 0) === 0 ? 'RECEIVED' : 'VARIANCE';

    run(`UPDATE movement_docs
            SET status = ?, received_count = ?, missing_count = ?, extra_count = ?,
                received_at = COALESCE(received_at, datetime('now','localtime')),
                received_by = COALESCE(received_by, ?), receive_reader = COALESCE(receive_reader, ?),
                remarks = COALESCE(?, remarks)
          WHERE id = ?`,
      status, tally.received ?? 0, missing, extraCount, userId ?? null, readerId, remarks, docId);

    return {
      doc: docById(docId),
      tally: {
        expected: doc.expected_count,
        received: tally.received ?? 0,
        missing, extra: extraCount, unknown: tally.unknown ?? 0,
        newly_received: newlyReceived.length,
        duplicates: duplicates.length,
        matched: missing === 0 && extraCount === 0 && (tally.unknown ?? 0) === 0,
      },
      missing_articles: missingLines(docId),
      exceptions: extrasRejected,
      duplicates,
      summary: summarise(newlyReceived),
    };
  });
}

export function missingLines(docId) {
  return all(
    `SELECT dl.epc, a.serial_no, a.id AS article_id, st.code AS style_code, cl.code AS color_code, sz.code AS size_code
       FROM doc_lines dl
       LEFT JOIN articles a ON a.id = dl.article_id
       LEFT JOIN styles st  ON st.id = a.style_id
       LEFT JOIN colors cl  ON cl.id = a.color_id
       LEFT JOIN sizes  sz  ON sz.id = a.size_id
      WHERE dl.doc_id = ? AND dl.line_state = 'EXPECTED'
      ORDER BY a.serial_no`, docId);
}

/**
 * Accept a variance: outstanding articles are put on HOLD in the source section
 * so they stop counting as in-transit, and the document is closed with a reason.
 */
export function closeVariance({ docId, note, userId, disposition = 'HOLD' }) {
  if (!note || note.trim().length < 5) throw badRequest('A variance reason of at least 5 characters is required');
  return tx(() => {
    const doc = get('SELECT * FROM movement_docs WHERE id = ?', docId);
    if (!doc) throw notFound('Dispatch document not found');
    if (doc.status === 'CLOSED') throw conflict('Document is already closed');

    const outstanding = all(
      "SELECT article_id FROM doc_lines WHERE doc_id = ? AND line_state = 'EXPECTED' AND article_id IS NOT NULL", docId);
    const ids = outstanding.map((r) => r.article_id);
    const newStatus = disposition === 'SCRAP' ? 'SCRAP' : 'HOLD';

    for (const part of chunked(ids)) {
      run(`UPDATE articles SET status = '${newStatus}', in_transit_doc = NULL, stage_since = datetime('now','localtime')
            WHERE id IN (${holders(part.length)})`, ...part);
    }
    if (ids.length) {
      run(`UPDATE doc_lines SET line_state = 'MISSING' WHERE doc_id = ? AND line_state = 'EXPECTED'`, docId);
      logEvents(ids, 'VARIANCE_CLOSED', {
        from: doc.from_stage, to: doc.from_stage, docId, userId,
        detail: { doc_no: doc.doc_no, note, disposition: newStatus },
      });
    }
    run(`UPDATE movement_docs SET status = 'CLOSED', closed_at = datetime('now','localtime'), closed_by = ?, variance_note = ?
          WHERE id = ?`, userId ?? null, note.trim(), docId);

    return { doc: docById(docId), affected: ids.length, disposition: newStatus };
  });
}

/** Cancel a dispatch that has not been received; articles return to the source. */
export function cancelDoc({ docId, userId, reason }) {
  return tx(() => {
    const doc = get('SELECT * FROM movement_docs WHERE id = ?', docId);
    if (!doc) throw notFound('Dispatch document not found');
    if (doc.received_count > 0) throw conflict('Cannot cancel - part of this batch has already been received');
    if (doc.status === 'CANCELLED') return { doc };

    const ids = all("SELECT article_id FROM doc_lines WHERE doc_id = ? AND article_id IS NOT NULL", docId)
      .map((r) => r.article_id);
    for (const part of chunked(ids)) {
      run(`UPDATE articles SET status = 'IN_STAGE', in_transit_doc = NULL WHERE id IN (${holders(part.length)})`, ...part);
    }
    if (ids.length) {
      logEvents(ids, 'DISPATCH_CANCELLED', { from: doc.from_stage, to: doc.from_stage, docId, userId, detail: { reason } });
    }
    run(`UPDATE movement_docs SET status = 'CANCELLED', variance_note = ?, closed_at = datetime('now','localtime'), closed_by = ?
          WHERE id = ?`, reason || null, userId ?? null, docId);
    return { doc: docById(docId), returned: ids.length };
  });
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */
export function docById(id) {
  const d = get(
    `SELECT d.*, uc.full_name AS created_by_name, ur.full_name AS received_by_name,
            ucl.full_name AS closed_by_name, rd.code AS dispatch_reader_code, rr.code AS receive_reader_code
       FROM movement_docs d
       LEFT JOIN users uc  ON uc.id = d.created_by
       LEFT JOIN users ur  ON ur.id = d.received_by
       LEFT JOIN users ucl ON ucl.id = d.closed_by
       LEFT JOIN readers rd ON rd.id = d.dispatch_reader
       LEFT JOIN readers rr ON rr.id = d.receive_reader
      WHERE d.id = ?`, id);
  if (!d) throw notFound('Dispatch document not found');
  return d;
}

export function docByNo(docNo) {
  const d = get('SELECT id FROM movement_docs WHERE doc_no = ?', docNo);
  if (!d) throw notFound(`Document ${docNo} not found`);
  return docById(d.id);
}

export function docDetail(id) {
  const doc = docById(id);
  const breakdown = all(
    `SELECT st.code AS style_code, st.name AS style_name, cl.code AS color_code, sz.code AS size_code,
            cu.name AS customer_name, o.order_no,
            COUNT(*) AS qty,
            SUM(CASE WHEN dl.line_state IN ('RECEIVED','EXTRA') THEN 1 ELSE 0 END) AS received_qty
       FROM doc_lines dl
       JOIN articles a ON a.id = dl.article_id
       JOIN styles st  ON st.id = a.style_id
       JOIN colors cl  ON cl.id = a.color_id
       JOIN sizes  sz  ON sz.id = a.size_id
       LEFT JOIN orders o     ON o.id = a.order_id
       LEFT JOIN customers cu ON cu.id = a.customer_id
      WHERE dl.doc_id = ?
      GROUP BY st.code, st.name, cl.code, sz.code, cu.name, o.order_no
      ORDER BY st.code, cl.code, sz.sort_ord`, id);
  const states = all(
    `SELECT line_state, COUNT(*) AS n FROM doc_lines WHERE doc_id = ? GROUP BY line_state`, id);
  return { doc, breakdown, states, missing: missingLines(id) };
}

export function docLines(id, { state = null, limit = 2000, offset = 0 } = {}) {
  const where = ['dl.doc_id = ?'];
  const params = [id];
  if (state) { where.push('dl.line_state = ?'); params.push(state); }
  return all(
    `SELECT dl.id, dl.epc, dl.line_state, dl.received_at, a.serial_no, a.id AS article_id,
            st.code AS style_code, cl.code AS color_code, sz.code AS size_code, o.order_no
       FROM doc_lines dl
       LEFT JOIN articles a ON a.id = dl.article_id
       LEFT JOIN styles st  ON st.id = a.style_id
       LEFT JOIN colors cl  ON cl.id = a.color_id
       LEFT JOIN sizes  sz  ON sz.id = a.size_id
       LEFT JOIN orders o   ON o.id = a.order_id
      WHERE ${where.join(' AND ')}
      ORDER BY dl.id LIMIT ? OFFSET ?`, ...params, Math.min(limit, 10000), offset);
}

export function listDocs({ stage = null, direction = 'any', status = null, from = null, to = null,
  q = null, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (stage && direction === 'in')       { where.push('d.to_stage = ?');   params.push(stage); }
  else if (stage && direction === 'out') { where.push('d.from_stage = ?'); params.push(stage); }
  else if (stage)                        { where.push('(d.from_stage = ? OR d.to_stage = ?)'); params.push(stage, stage); }
  if (status) { where.push('d.status = ?'); params.push(status); }
  if (from)   { where.push('d.created_at >= ?'); params.push(from); }
  if (to)     { where.push('d.created_at <= ?'); params.push(to + ' 23:59:59'); }
  if (q)      { where.push('(d.doc_no LIKE ? OR d.batch_ref LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const sql = `SELECT d.*, uc.full_name AS created_by_name, ur.full_name AS received_by_name
                 FROM movement_docs d
                 LEFT JOIN users uc ON uc.id = d.created_by
                 LEFT JOIN users ur ON ur.id = d.received_by
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`;
  const rows = all(sql, ...params, Math.min(limit, 500), offset);
  const total = get(`SELECT COUNT(*) AS c FROM movement_docs d ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...params).c;
  return { rows, total };
}

/** Inbound documents a section still has to receive. */
export function pendingInbound(stage) {
  return all(
    `SELECT d.*, uc.full_name AS created_by_name
       FROM movement_docs d LEFT JOIN users uc ON uc.id = d.created_by
      WHERE d.to_stage = ? AND d.status IN ('DISPATCHED','VARIANCE')
      ORDER BY d.created_at ASC`, stage);
}

function summarise(articles) {
  const map = new Map();
  for (const a of articles) {
    const key = `${a.style_code}|${a.color_code}|${a.size_code}`;
    const cur = map.get(key) || {
      style_code: a.style_code, style_name: a.style_name,
      color_code: a.color_code, size_code: a.size_code,
      order_no: a.order_no, customer_name: a.customer_name, qty: 0,
    };
    cur.qty++;
    map.set(key, cur);
  }
  return [...map.values()].sort((x, y) => y.qty - x.qty);
}

export { summarise };
