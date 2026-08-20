import { db, all, get, run, tx } from '../lib/db.js';
import { shiftFor } from '../lib/process.js';
import { badRequest, notFound, conflict } from '../lib/http.js';
import { articleById, articleByEpc, logEvent, logEvents, ARTICLE_SELECT } from './articles.js';

/**
 * QC inspection. A fail records one or more defects, each optionally pinned to a
 * coordinate on the style's reference image, and opens a retrofit job.
 */
export function inspect({ articleId, epc, result, defects = [], remarks = null, inspectorId, readerId = null }) {
  if (!['PASS', 'FAIL'].includes(result)) throw badRequest('Result must be PASS or FAIL');

  return tx(() => {
    const art = articleId ? articleById(articleId) : articleByEpc(epc);
    if (art.stage !== 'QC') {
      throw conflict(`${art.serial_no} is in ${art.stage}, not QC - receive it into QC first`);
    }
    if (art.status === 'IN_TRANSIT') throw conflict(`${art.serial_no} is in transit and cannot be inspected`);
    if (result === 'FAIL' && !defects.length) {
      throw badRequest('A QC failure must record at least one defect reason');
    }

    const attempt = (get('SELECT COUNT(*) AS c FROM qc_inspections WHERE article_id = ?', art.id).c || 0) + 1;
    const res = run(
      `INSERT INTO qc_inspections(article_id, attempt, result, inspector_id, reader_id, shift_code, remarks)
       VALUES(?,?,?,?,?,?,?)`,
      art.id, attempt, result, inspectorId, readerId, shiftFor(), remarks);
    const inspectionId = Number(res.lastInsertRowid);

    if (result === 'FAIL') {
      const insDef = db.prepare(
        `INSERT INTO qc_defects(inspection_id, defect_code_id, severity, view, pos_x, pos_y, note)
         VALUES(?,?,?,?,?,?,?)`);
      for (const d of defects) {
        const code = get('SELECT * FROM defect_codes WHERE id = ? AND active = 1', d.defect_code_id);
        if (!code) throw badRequest(`Unknown defect code id ${d.defect_code_id}`);
        insDef.run(
          inspectionId, code.id, d.severity || code.severity,
          (d.view || 'FRONT').toUpperCase(),
          d.pos_x == null ? null : Number(d.pos_x),
          d.pos_y == null ? null : Number(d.pos_y),
          d.note || null);
      }
      run(`UPDATE articles SET qc_state = 'FAIL', qc_fail_count = qc_fail_count + 1, status = 'REWORK' WHERE id = ?`, art.id);
      run(`INSERT INTO rework_jobs(article_id, inspection_id) VALUES(?,?)`, art.id, inspectionId);
      logEvent(art.id, 'QC_FAIL', {
        from: 'QC', to: 'QC', userId: inspectorId, readerId,
        detail: { attempt, defects: defects.length, remarks },
      });
    } else {
      run(`UPDATE articles SET qc_state = 'PASS', status = 'READY' WHERE id = ?`, art.id);
      run(`UPDATE rework_jobs SET status = 'DONE', done_at = datetime('now','localtime'), done_by = ?
            WHERE article_id = ? AND status IN ('OPEN','IN_PROGRESS')`, inspectorId, art.id);
      logEvent(art.id, 'QC_PASS', { from: 'QC', to: 'QC', userId: inspectorId, readerId, detail: { attempt, remarks } });
    }

    return { inspection: inspectionById(inspectionId), article: articleById(art.id) };
  });
}

/** Bulk pass for a clean batch - a fail always has to go through inspect(). */
export function batchPass({ epcs, inspectorId, readerId = null, remarks = null }) {
  return tx(() => {
    const passed = [];
    const skipped = [];
    for (const epc of epcs) {
      try {
        const art = articleByEpc(epc);
        if (art.stage !== 'QC' || art.status === 'IN_TRANSIT') {
          skipped.push({ epc, serial_no: art.serial_no, reason: `In ${art.stage} / ${art.status}` });
          continue;
        }
        inspect({ articleId: art.id, result: 'PASS', inspectorId, readerId, remarks });
        passed.push({ epc, serial_no: art.serial_no });
      } catch (e) {
        skipped.push({ epc, reason: e.message });
      }
    }
    return { passed: passed.length, skipped, details: passed };
  });
}

export function inspectionById(id) {
  const insp = get(
    `SELECT q.*, u.full_name AS inspector_name, u.username AS inspector_username, a.serial_no, a.epc
       FROM qc_inspections q
       JOIN users u ON u.id = q.inspector_id
       JOIN articles a ON a.id = q.article_id
      WHERE q.id = ?`, id);
  if (!insp) throw notFound('Inspection not found');
  insp.defects = all(
    `SELECT d.*, dc.code, dc.name, dc.category
       FROM qc_defects d JOIN defect_codes dc ON dc.id = d.defect_code_id
      WHERE d.inspection_id = ? ORDER BY d.id`, id);
  return insp;
}

export function articleQcFile(articleId) {
  const article = articleById(articleId);
  const inspections = all(
    `SELECT q.*, u.full_name AS inspector_name
       FROM qc_inspections q JOIN users u ON u.id = q.inspector_id
      WHERE q.article_id = ? ORDER BY q.attempt DESC`, articleId);
  for (const i of inspections) {
    i.defects = all(
      `SELECT d.*, dc.code, dc.name, dc.category
         FROM qc_defects d JOIN defect_codes dc ON dc.id = d.defect_code_id
        WHERE d.inspection_id = ? ORDER BY d.id`, i.id);
  }
  const openDefects = inspections
    .filter((i) => i.result === 'FAIL')
    .flatMap((i) => i.defects.filter((d) => !d.resolved));
  const rework = get(
    `SELECT r.*, us.full_name AS started_by_name, ud.full_name AS done_by_name
       FROM rework_jobs r
       LEFT JOIN users us ON us.id = r.started_by
       LEFT JOIN users ud ON ud.id = r.done_by
      WHERE r.article_id = ? ORDER BY r.id DESC LIMIT 1`, articleId);
  return { article, inspections, open_defects: openDefects, rework };
}

/* ------------------------------------------------------------------ */
/* Retrofitting                                                        */
/* ------------------------------------------------------------------ */

/** Operator scans a garment at the retrofit bench: everything they need pops up. */
export function reworkScan(epc) {
  const art = articleByEpc(epc);
  const file = articleQcFile(art.id);
  if (file.rework && file.rework.status === 'OPEN') {
    run(`UPDATE rework_jobs SET status = 'IN_PROGRESS', started_at = datetime('now','localtime') WHERE id = ?`, file.rework.id);
    file.rework.status = 'IN_PROGRESS';
  }
  return file;
}

export function startRework({ articleId, userId }) {
  const job = get(`SELECT * FROM rework_jobs WHERE article_id = ? AND status IN ('OPEN','IN_PROGRESS') ORDER BY id DESC LIMIT 1`, articleId);
  if (!job) throw notFound('No open retrofit job for this article');
  run(`UPDATE rework_jobs SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, datetime('now','localtime')), started_by = COALESCE(started_by, ?)
        WHERE id = ?`, userId, job.id);
  logEvent(articleId, 'REWORK_START', { from: 'RETROFIT', to: 'RETROFIT', userId });
  return get('SELECT * FROM rework_jobs WHERE id = ?', job.id);
}

/** Mark corrections complete; the article becomes eligible to go back to QC. */
export function completeRework({ articleId, userId, actionTaken, resolvedDefectIds = null, remarks = null }) {
  return tx(() => {
    const art = articleById(articleId);
    if (art.stage !== 'RETROFIT') {
      throw conflict(`${art.serial_no} is in ${art.stage}, not Retrofitting`);
    }
    const job = get(`SELECT * FROM rework_jobs WHERE article_id = ? AND status IN ('OPEN','IN_PROGRESS') ORDER BY id DESC LIMIT 1`, articleId);
    if (!job) throw notFound('No open retrofit job for this article');
    if (!actionTaken || !actionTaken.trim()) throw badRequest('Describe the correction that was carried out');

    if (Array.isArray(resolvedDefectIds) && resolvedDefectIds.length) {
      for (const id of resolvedDefectIds) {
        run(`UPDATE qc_defects SET resolved = 1, resolved_at = datetime('now','localtime'), resolved_by = ? WHERE id = ?`, userId, id);
      }
    } else {
      run(`UPDATE qc_defects SET resolved = 1, resolved_at = datetime('now','localtime'), resolved_by = ?
            WHERE inspection_id IN (SELECT id FROM qc_inspections WHERE article_id = ?) AND resolved = 0`, userId, articleId);
    }

    run(`UPDATE rework_jobs SET status = 'DONE', done_at = datetime('now','localtime'), done_by = ?, action_taken = ?, remarks = ?
          WHERE id = ?`, userId, actionTaken.trim(), remarks, job.id);
    run(`UPDATE articles SET qc_state = 'REWORKED', status = 'IN_STAGE' WHERE id = ?`, articleId);
    logEvent(articleId, 'REWORK_DONE', { from: 'RETROFIT', to: 'RETROFIT', userId, detail: { action: actionTaken, remarks } });

    return articleQcFile(articleId);
  });
}

export function scrapArticle({ articleId, userId, reason }) {
  if (!reason || reason.trim().length < 5) throw badRequest('A scrap reason is required');
  return tx(() => {
    const art = articleById(articleId);
    run(`UPDATE articles SET status = 'SCRAP', stage_since = datetime('now','localtime') WHERE id = ?`, articleId);
    run(`UPDATE rework_jobs SET status = 'SCRAPPED', done_at = datetime('now','localtime'), done_by = ?, remarks = ?
          WHERE article_id = ? AND status IN ('OPEN','IN_PROGRESS')`, userId, reason, articleId);
    logEvent(articleId, 'SCRAP', { from: art.stage, to: art.stage, userId, detail: { reason } });
    return articleById(articleId);
  });
}

/* ------------------------------------------------------------------ */
/* Queues & analytics                                                  */
/* ------------------------------------------------------------------ */
export function qcQueue({ limit = 200, offset = 0, qcState = null } = {}) {
  const where = ["a.stage = 'QC'", "a.status IN ('IN_STAGE','REWORK','READY')"];
  const params = [];
  if (qcState) { where.push('a.qc_state = ?'); params.push(qcState); }
  return all(`${ARTICLE_SELECT} WHERE ${where.join(' AND ')}
              ORDER BY a.stage_since ASC LIMIT ? OFFSET ?`, ...params, Math.min(limit, 1000), offset);
}

export function reworkQueue({ limit = 200, offset = 0, status = null } = {}) {
  const where = ["a.stage = 'RETROFIT'"];
  const params = [];
  if (status) { where.push('r.status = ?'); params.push(status); }
  return all(
    `SELECT a.id, a.epc, a.serial_no, a.stage, a.status, a.qc_state, a.qc_fail_count, a.stage_since,
            st.code AS style_code, st.name AS style_name, cl.code AS color_code, sz.code AS size_code,
            o.order_no, cu.name AS customer_name,
            r.id AS job_id, r.status AS job_status, r.opened_at, r.started_at,
            (SELECT COUNT(*) FROM qc_defects d
               JOIN qc_inspections q ON q.id = d.inspection_id
              WHERE q.article_id = a.id AND d.resolved = 0) AS open_defects
       FROM articles a
       JOIN styles st ON st.id = a.style_id
       JOIN colors cl ON cl.id = a.color_id
       JOIN sizes  sz ON sz.id = a.size_id
       LEFT JOIN orders o     ON o.id = a.order_id
       LEFT JOIN customers cu ON cu.id = a.customer_id
       LEFT JOIN rework_jobs r ON r.id = (
          SELECT id FROM rework_jobs WHERE article_id = a.id ORDER BY id DESC LIMIT 1)
      WHERE ${where.join(' AND ')}
      ORDER BY a.stage_since ASC LIMIT ? OFFSET ?`, ...params, Math.min(limit, 1000), offset);
}

export function defectPareto({ from = null, to = null, styleId = null, limit = 25 } = {}) {
  const where = ["q.result = 'FAIL'"];
  const params = [];
  if (from) { where.push('q.inspected_at >= ?'); params.push(from); }
  if (to)   { where.push('q.inspected_at <= ?'); params.push(to + ' 23:59:59'); }
  if (styleId) { where.push('a.style_id = ?'); params.push(styleId); }
  return all(
    `SELECT dc.code, dc.name, dc.category, d.severity, COUNT(*) AS qty
       FROM qc_defects d
       JOIN qc_inspections q ON q.id = d.inspection_id
       JOIN articles a ON a.id = q.article_id
       JOIN defect_codes dc ON dc.id = d.defect_code_id
      WHERE ${where.join(' AND ')}
      GROUP BY dc.code, dc.name, dc.category, d.severity
      ORDER BY qty DESC LIMIT ?`, ...params, limit);
}

/** Defect coordinates for the heat map overlay on a style image. */
export function defectMap({ styleId, view = 'FRONT', from = null, to = null }) {
  const where = ['a.style_id = ?', 'd.view = ?', 'd.pos_x IS NOT NULL'];
  const params = [styleId, view];
  if (from) { where.push('q.inspected_at >= ?'); params.push(from); }
  if (to)   { where.push('q.inspected_at <= ?'); params.push(to + ' 23:59:59'); }
  return all(
    `SELECT d.pos_x, d.pos_y, d.severity, dc.code, dc.name
       FROM qc_defects d
       JOIN qc_inspections q ON q.id = d.inspection_id
       JOIN articles a ON a.id = q.article_id
       JOIN defect_codes dc ON dc.id = d.defect_code_id
      WHERE ${where.join(' AND ')} LIMIT 5000`, ...params);
}
