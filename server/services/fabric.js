import { db, all, get, run, tx, nextNumber, chunked, holders } from '../lib/db.js';
import { badRequest, notFound, conflict } from '../lib/http.js';

/**
 * Fabric warehouse -> cutting.
 * Rolls may carry their own UHF tag: receiving and issuing can then be done by
 * bulk read instead of keying roll numbers.
 */

/* ------------------------------- Receiving ------------------------------- */
export function receiveGrn({ supplier, invoiceRef, remarks, rolls, userId }) {
  if (!Array.isArray(rolls) || !rolls.length) throw badRequest('At least one roll is required');

  return tx(() => {
    const grnNo = nextNumber('GRN');
    const res = run(
      `INSERT INTO grn(grn_no, supplier, invoice_ref, received_by, remarks) VALUES(?,?,?,?,?)`,
      grnNo, supplier || null, invoiceRef || null, userId ?? null, remarks || null);
    const grnId = Number(res.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO fabric_rolls(roll_no, epc, grn_id, fabric_type_id, color_id, shade_batch,
                                width_in, length_m, remaining_m, weight_kg, location, created_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);

    const created = [];
    for (const r of rolls) {
      const fabricType = get('SELECT id FROM fabric_types WHERE id = ? AND active = 1', r.fabric_type_id);
      if (!fabricType) throw badRequest(`Unknown fabric type ${r.fabric_type_id}`);
      const color = get('SELECT id FROM colors WHERE id = ? AND active = 1', r.color_id);
      if (!color) throw badRequest(`Unknown colour ${r.color_id}`);

      const rollNo = (r.roll_no || '').trim() || nextNumber('ROLL', { daily: false, width: 6 });
      if (get('SELECT id FROM fabric_rolls WHERE roll_no = ?', rollNo)) {
        throw conflict(`Roll number ${rollNo} already exists`);
      }
      const epc = r.epc ? String(r.epc).trim().toUpperCase() : null;
      if (epc && get('SELECT id FROM fabric_rolls WHERE epc = ?', epc)) {
        throw conflict(`Roll tag ${epc} is already assigned to another roll`);
      }
      const lengthM = Number(r.length_m || 0);
      if (!(lengthM > 0)) throw badRequest(`Roll ${rollNo}: length must be greater than zero`);

      const out = ins.run(rollNo, epc, grnId, r.fabric_type_id, r.color_id, r.shade_batch || null,
        r.width_in ?? null, lengthM, lengthM, r.weight_kg ?? null, r.location || null, userId ?? null);
      created.push({ id: Number(out.lastInsertRowid), roll_no: rollNo, epc, length_m: lengthM });
    }
    return { grn: grnById(grnId), rolls: created, count: created.length };
  });
}

export function grnById(id) {
  const g = get(`SELECT g.*, u.full_name AS received_by_name FROM grn g
                 LEFT JOIN users u ON u.id = g.received_by WHERE g.id = ?`, id);
  if (!g) throw notFound('GRN not found');
  g.rolls = all(
    `SELECT r.*, ft.code AS fabric_code, ft.name AS fabric_name, cl.code AS color_code, cl.name AS color_name
       FROM fabric_rolls r
       JOIN fabric_types ft ON ft.id = r.fabric_type_id
       JOIN colors cl ON cl.id = r.color_id
      WHERE r.grn_id = ? ORDER BY r.roll_no`, id);
  g.total_length_m = g.rolls.reduce((s, r) => s + (r.length_m || 0), 0);
  return g;
}

export function listGrn({ limit = 100, offset = 0, q = null } = {}) {
  const where = [];
  const params = [];
  if (q) { where.push('(g.grn_no LIKE ? OR g.supplier LIKE ? OR g.invoice_ref LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  return all(
    `SELECT g.*, u.full_name AS received_by_name,
            (SELECT COUNT(*) FROM fabric_rolls r WHERE r.grn_id = g.id) AS roll_count,
            (SELECT COALESCE(SUM(length_m),0) FROM fabric_rolls r WHERE r.grn_id = g.id) AS total_m
       FROM grn g LEFT JOIN users u ON u.id = g.received_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY g.received_at DESC LIMIT ? OFFSET ?`, ...params, Math.min(limit, 500), offset);
}

/* --------------------------------- Rolls --------------------------------- */
export function listRolls({ status = null, fabricTypeId = null, colorId = null, q = null,
  limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (status)       { where.push('r.status = ?'); params.push(status); }
  if (fabricTypeId) { where.push('r.fabric_type_id = ?'); params.push(fabricTypeId); }
  if (colorId)      { where.push('r.color_id = ?'); params.push(colorId); }
  if (q)            { where.push('(r.roll_no LIKE ? OR r.epc LIKE ? OR r.shade_batch LIKE ? OR r.location LIKE ?)');
                      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = all(
    `SELECT r.*, ft.code AS fabric_code, ft.name AS fabric_name,
            cl.code AS color_code, cl.name AS color_name, cl.hex AS color_hex, g.grn_no
       FROM fabric_rolls r
       JOIN fabric_types ft ON ft.id = r.fabric_type_id
       JOIN colors cl ON cl.id = r.color_id
       LEFT JOIN grn g ON g.id = r.grn_id
      ${w} ORDER BY r.received_at DESC, r.roll_no LIMIT ? OFFSET ?`, ...params, Math.min(limit, 1000), offset);
  const total = get(`SELECT COUNT(*) AS c FROM fabric_rolls r ${w}`, ...params).c;
  return { rows, total };
}

export function rollsByEpcs(epcs) {
  const found = [];
  for (const part of chunked(epcs)) {
    found.push(...all(
      `SELECT r.*, ft.code AS fabric_code, ft.name AS fabric_name, cl.code AS color_code, cl.name AS color_name
         FROM fabric_rolls r
         JOIN fabric_types ft ON ft.id = r.fabric_type_id
         JOIN colors cl ON cl.id = r.color_id
        WHERE r.epc IN (${holders(part.length)})`, ...part));
  }
  const foundEpcs = new Set(found.map((r) => r.epc));
  return { rolls: found, unknown: epcs.filter((e) => !foundEpcs.has(e)) };
}

export function stockSummary() {
  return all(
    `SELECT ft.code AS fabric_code, ft.name AS fabric_name, cl.code AS color_code, cl.name AS color_name,
            cl.hex AS color_hex, r.status,
            COUNT(*) AS rolls, ROUND(SUM(r.remaining_m), 1) AS remaining_m, ROUND(SUM(r.length_m), 1) AS total_m
       FROM fabric_rolls r
       JOIN fabric_types ft ON ft.id = r.fabric_type_id
       JOIN colors cl ON cl.id = r.color_id
      GROUP BY ft.code, ft.name, cl.code, cl.name, cl.hex, r.status
      ORDER BY ft.code, cl.code, r.status`);
}

/* ------------------------------ Cut orders ------------------------------- */
export function createCutOrder({ orderId, styleId, colorId, plannedQty, remarks, userId }) {
  const style = get('SELECT * FROM styles WHERE id = ? AND active = 1', styleId);
  if (!style) throw badRequest('Unknown style');
  if (!get('SELECT id FROM colors WHERE id = ?', colorId)) throw badRequest('Unknown colour');
  const cutNo = nextNumber('CUT');
  const res = run(
    `INSERT INTO cut_orders(cut_no, order_id, style_id, color_id, planned_qty, created_by, remarks)
     VALUES(?,?,?,?,?,?,?)`,
    cutNo, orderId || null, styleId, colorId, plannedQty || 0, userId ?? null, remarks || null);
  return cutOrderById(Number(res.lastInsertRowid));
}

export function cutOrderById(id) {
  const c = get(
    `SELECT c.*, st.code AS style_code, st.name AS style_name, cl.code AS color_code, cl.name AS color_name,
            cl.hex AS color_hex, o.order_no, cu.name AS customer_name, u.full_name AS created_by_name,
            ft.code AS fabric_code, ft.name AS fabric_name
       FROM cut_orders c
       JOIN styles st ON st.id = c.style_id
       JOIN colors cl ON cl.id = c.color_id
       LEFT JOIN fabric_types ft ON ft.id = st.fabric_type_id
       LEFT JOIN orders o ON o.id = c.order_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
       LEFT JOIN users u ON u.id = c.created_by
      WHERE c.id = ?`, id);
  if (!c) throw notFound('Cut order not found');
  c.issues = all(
    `SELECT fi.*, r.roll_no, r.epc, r.shade_batch, ft.code AS fabric_code, cl.code AS color_code,
            u.full_name AS issued_by_name
       FROM fabric_issues fi
       JOIN fabric_rolls r ON r.id = fi.roll_id
       JOIN fabric_types ft ON ft.id = r.fabric_type_id
       JOIN colors cl ON cl.id = r.color_id
       LEFT JOIN users u ON u.id = fi.issued_by
      WHERE fi.cut_order_id = ? ORDER BY fi.issued_at`, id);
  c.bundles = all(
    `SELECT b.*, sz.code AS size_code, sz.name AS size_name, sz.sort_ord,
            ui.full_name AS issued_by_name, ur.full_name AS received_by_name
       FROM bundles b
       JOIN sizes sz ON sz.id = b.size_id
       LEFT JOIN users ui ON ui.id = b.issued_by
       LEFT JOIN users ur ON ur.id = b.received_by
      WHERE b.cut_order_id = ? ORDER BY sz.sort_ord, b.bundle_no`, id);
  c.issued_m = c.issues.reduce((s, i) => s + i.issued_m, 0);
  c.bundle_qty = c.bundles.reduce((s, b) => s + b.qty, 0);
  c.tagged_qty = c.bundles.reduce((s, b) => s + b.tagged_qty, 0);
  return c;
}

export function listCutOrders({ status = null, q = null, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (q) { where.push('(c.cut_no LIKE ? OR st.code LIKE ? OR o.order_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  return all(
    `SELECT c.*, st.code AS style_code, st.name AS style_name, cl.code AS color_code, cl.hex AS color_hex,
            o.order_no, cu.name AS customer_name,
            (SELECT COALESCE(SUM(qty),0) FROM bundles b WHERE b.cut_order_id = c.id) AS bundle_qty,
            (SELECT COALESCE(SUM(tagged_qty),0) FROM bundles b WHERE b.cut_order_id = c.id) AS tagged_qty,
            (SELECT COUNT(*) FROM bundles b WHERE b.cut_order_id = c.id) AS bundle_count
       FROM cut_orders c
       JOIN styles st ON st.id = c.style_id
       JOIN colors cl ON cl.id = c.color_id
       LEFT JOIN orders o ON o.id = c.order_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, ...params, Math.min(limit, 500), offset);
}

/** Issue rolls to a cut order, by roll id or by bulk-read roll tags. */
export function issueRolls({ cutOrderId, rolls = [], epcs = [], userId }) {
  return tx(() => {
    const cut = get('SELECT * FROM cut_orders WHERE id = ?', cutOrderId);
    if (!cut) throw notFound('Cut order not found');
    if (['CUT', 'CLOSED'].includes(cut.status)) throw conflict(`Cut order ${cut.cut_no} is ${cut.status}`);

    const items = [...rolls];
    if (epcs.length) {
      const { rolls: byTag, unknown } = rollsByEpcs(epcs);
      if (unknown.length) throw badRequest(`${unknown.length} roll tag(s) are not registered`, { epcs: unknown.slice(0, 20) });
      for (const r of byTag) if (!items.some((i) => Number(i.roll_id) === r.id)) items.push({ roll_id: r.id, issued_m: null, scanned: true });
    }
    if (!items.length) throw badRequest('No rolls selected');

    const issueNo = nextNumber('ISS');
    const ins = db.prepare(
      `INSERT INTO fabric_issues(issue_no, cut_order_id, roll_id, issued_m, issued_by, scanned) VALUES(?,?,?,?,?,?)`);

    const issued = [];
    for (const item of items) {
      const roll = get('SELECT * FROM fabric_rolls WHERE id = ?', item.roll_id);
      if (!roll) throw badRequest(`Roll ${item.roll_id} not found`);
      if (roll.status === 'CONSUMED') throw conflict(`Roll ${roll.roll_no} is fully consumed`);
      if (roll.status === 'QUARANTINE') throw conflict(`Roll ${roll.roll_no} is quarantined`);
      if (roll.color_id !== cut.color_id) {
        throw conflict(`Roll ${roll.roll_no} colour does not match cut order ${cut.cut_no}`);
      }
      const qty = item.issued_m == null ? roll.remaining_m : Number(item.issued_m);
      if (!(qty > 0)) throw badRequest(`Roll ${roll.roll_no}: issue quantity must be greater than zero`);
      if (qty > roll.remaining_m + 1e-6) {
        throw conflict(`Roll ${roll.roll_no} has only ${roll.remaining_m} m remaining`);
      }
      ins.run(issueNo, cutOrderId, roll.id, qty, userId ?? null, item.scanned ? 1 : 0);
      const remaining = Number((roll.remaining_m - qty).toFixed(3));
      run(`UPDATE fabric_rolls SET remaining_m = ?, status = ? WHERE id = ?`,
        remaining, remaining <= 0.001 ? 'CONSUMED' : 'PARTIAL', roll.id);
      issued.push({ roll_no: roll.roll_no, issued_m: qty, remaining_m: remaining });
    }

    if (cut.status === 'PLANNED') run("UPDATE cut_orders SET status = 'ISSUED' WHERE id = ?", cutOrderId);
    return { issue_no: issueNo, cut_order: cutOrderById(cutOrderId), issued };
  });
}

/* -------------------------------- Bundles -------------------------------- */
export function createBundles({ cutOrderId, lines, userId }) {
  if (!Array.isArray(lines) || !lines.length) throw badRequest('At least one size line is required');
  return tx(() => {
    const cut = get('SELECT * FROM cut_orders WHERE id = ?', cutOrderId);
    if (!cut) throw notFound('Cut order not found');
    if (cut.status === 'CLOSED') throw conflict('Cut order is closed');

    const ins = db.prepare(
      `INSERT INTO bundles(bundle_no, cut_order_id, size_id, qty) VALUES(?,?,?,?)`);
    const created = [];
    let total = 0;
    for (const line of lines) {
      const size = get('SELECT * FROM sizes WHERE id = ?', line.size_id);
      if (!size) throw badRequest(`Unknown size ${line.size_id}`);
      const bundleCount = Math.max(1, Number(line.bundles || 1));
      const qtyEach = Number(line.qty_per_bundle || line.qty || 0);
      if (!(qtyEach > 0)) throw badRequest(`Size ${size.code}: quantity must be greater than zero`);
      for (let i = 0; i < bundleCount; i++) {
        const no = nextNumber('BDL', { daily: true, width: 5 });
        const out = ins.run(no, cutOrderId, size.id, qtyEach);
        created.push({ id: Number(out.lastInsertRowid), bundle_no: no, size_code: size.code, qty: qtyEach });
        total += qtyEach;
      }
    }
    run(`UPDATE cut_orders SET cut_qty = cut_qty + ?, status = CASE WHEN status IN ('PLANNED','ISSUED') THEN 'CUTTING' ELSE status END
          WHERE id = ?`, total, cutOrderId);
    return { bundles: created, total_qty: total, cut_order: cutOrderById(cutOrderId) };
  });
}

/** Cutting hands bundles to stitching on a manual count (no tags exist yet). */
export function issueBundlesToStitching({ bundleIds, userId }) {
  return tx(() => {
    const updated = [];
    for (const id of bundleIds) {
      const b = get('SELECT * FROM bundles WHERE id = ?', id);
      if (!b) throw notFound(`Bundle ${id} not found`);
      if (b.status !== 'CUT') throw conflict(`Bundle ${b.bundle_no} is already ${b.status}`);
      run(`UPDATE bundles SET status = 'ISSUED_TO_STITCH', issued_at = datetime('now','localtime'), issued_by = ? WHERE id = ?`, userId ?? null, id);
      updated.push(b.bundle_no);
    }
    return { issued: updated.length, bundles: updated };
  });
}

/** Stitching acknowledges the manual count; a mismatch is recorded, not hidden. */
export function receiveBundle({ bundleId, countedQty, userId }) {
  return tx(() => {
    const b = get('SELECT * FROM bundles WHERE id = ?', bundleId);
    if (!b) throw notFound('Bundle not found');
    if (b.status === 'CUT') throw conflict(`Bundle ${b.bundle_no} has not been issued by cutting yet`);
    if (b.received_at) throw conflict(`Bundle ${b.bundle_no} was already received`);
    const counted = Number(countedQty);
    if (!Number.isInteger(counted) || counted < 0) throw badRequest('Counted quantity must be a whole number');

    run(`UPDATE bundles SET received_qty = ?, received_at = datetime('now','localtime'), received_by = ?,
                            qty = ?, status = 'IN_STITCHING' WHERE id = ?`,
      counted, userId ?? null, counted, bundleId);
    return {
      bundle: get('SELECT * FROM bundles WHERE id = ?', bundleId),
      variance: counted - b.qty,
      matched: counted === b.qty,
    };
  });
}

export function openBundles({ status = null, q = null, limit = 200 } = {}) {
  const where = ["b.status <> 'CLOSED'"];
  const params = [];
  if (status) { where.push('b.status = ?'); params.push(status); }
  if (q) { where.push('(b.bundle_no LIKE ? OR c.cut_no LIKE ? OR st.code LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  return all(
    `SELECT b.*, c.cut_no, st.code AS style_code, st.name AS style_name, cl.code AS color_code, cl.hex AS color_hex,
            sz.code AS size_code, o.order_no, cu.name AS customer_name,
            (b.qty - b.tagged_qty) AS remaining_to_tag
       FROM bundles b
       JOIN cut_orders c ON c.id = b.cut_order_id
       JOIN styles st ON st.id = c.style_id
       JOIN colors cl ON cl.id = c.color_id
       JOIN sizes sz  ON sz.id = b.size_id
       LEFT JOIN orders o ON o.id = c.order_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.created_at DESC LIMIT ?`, ...params, Math.min(limit, 1000));
}
