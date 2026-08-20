import { db, all, get, run, tx, nextNumber, chunked, holders } from '../lib/db.js';
import { badRequest, notFound, conflict } from '../lib/http.js';
import { articleById, articleByEpc, logEvent, logEvents, ARTICLE_SELECT } from './articles.js';

/**
 * Dispatch & packing.
 *
 * A QC-passed garment arrives wearing the in-house tracking tag. Here that tag
 * is removed and the customer's own tag is applied. The tracking EPC is unbound
 * so the physical tag can be recycled onto a new garment, while the full history
 * stays attached to the article record.
 */

export function createShipment({ orderId = null, customerId = null, carrier = null, remarks = null, userId }) {
  let custId = customerId;
  if (orderId) {
    const o = get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o) throw notFound('Order not found');
    custId = o.customer_id;
  }
  if (!custId) throw badRequest('A customer or an order is required');
  const no = nextNumber('SHP');
  const res = run(
    `INSERT INTO shipments(shipment_no, order_id, customer_id, carrier, created_by, remarks) VALUES(?,?,?,?,?,?)`,
    no, orderId, custId, carrier, userId ?? null, remarks);
  return shipmentById(Number(res.lastInsertRowid));
}

export function shipmentById(id) {
  const s = get(
    `SELECT s.*, cu.code AS customer_code, cu.name AS customer_name, cu.tag_spec, o.order_no,
            u.full_name AS created_by_name
       FROM shipments s
       LEFT JOIN customers cu ON cu.id = s.customer_id
       LEFT JOIN orders o ON o.id = s.order_id
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.id = ?`, id);
  if (!s) throw notFound('Shipment not found');
  s.breakdown = all(
    `SELECT st.code AS style_code, cl.code AS color_code, sz.code AS size_code, sz.sort_ord,
            sl.carton_no, COUNT(*) AS qty
       FROM shipment_lines sl
       JOIN articles a ON a.id = sl.article_id
       JOIN styles st ON st.id = a.style_id
       JOIN colors cl ON cl.id = a.color_id
       JOIN sizes sz ON sz.id = a.size_id
      WHERE sl.shipment_id = ?
      GROUP BY st.code, cl.code, sz.code, sz.sort_ord, sl.carton_no
      ORDER BY sl.carton_no, st.code, cl.code, sz.sort_ord`, id);
  return s;
}

export function listShipments({ status = null, customerId = null, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('s.status = ?'); params.push(status); }
  if (customerId) { where.push('s.customer_id = ?'); params.push(customerId); }
  return all(
    `SELECT s.*, cu.name AS customer_name, cu.code AS customer_code, o.order_no, u.full_name AS created_by_name
       FROM shipments s
       LEFT JOIN customers cu ON cu.id = s.customer_id
       LEFT JOIN orders o ON o.id = s.order_id
       LEFT JOIN users u ON u.id = s.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, ...params, Math.min(limit, 500), offset);
}

/** Everything sitting in Dispatch that has cleared QC and still wears a tracking tag. */
export function readyForTagSwap({ customerId = null, orderId = null, limit = 500 } = {}) {
  const where = ["a.stage = 'DISPATCH'", "a.qc_state IN ('PASS','REWORKED')", 'a.final_tag_epc IS NULL'];
  const params = [];
  if (customerId) { where.push('a.customer_id = ?'); params.push(customerId); }
  if (orderId) { where.push('a.order_id = ?'); params.push(orderId); }
  return all(`${ARTICLE_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.stage_since ASC LIMIT ?`,
    ...params, Math.min(limit, 5000));
}

/** Look up a garment by its tracking tag so the operator sees what tag to apply. */
export function prepareSwap(epc) {
  const art = articleByEpc(epc);
  if (art.stage !== 'DISPATCH') {
    throw conflict(`${art.serial_no} is in ${art.stage} - only articles received into Dispatch can be re-tagged`);
  }
  if (art.final_tag_epc) throw conflict(`${art.serial_no} already carries customer tag ${art.final_tag_epc}`);
  if (!['PASS', 'REWORKED'].includes(art.qc_state)) {
    throw conflict(`${art.serial_no} has not passed QC (state: ${art.qc_state})`);
  }
  const spec = art.customer_id ? get('SELECT tag_spec, name, code FROM customers WHERE id = ?', art.customer_id) : null;
  return { article: art, customer_tag_spec: spec?.tag_spec || null, customer: spec };
}

/**
 * Swap tracking tags for customer tags. Accepts a list of pairs so a tabletop
 * encoder can push a whole tray in one call.
 */
export function swapTags({ shipmentId, pairs, cartonNo = null, userId }) {
  if (!Array.isArray(pairs) || !pairs.length) throw badRequest('No tag pairs supplied');

  return tx(() => {
    const ship = shipmentById(shipmentId);
    if (ship.status === 'SHIPPED') throw conflict(`Shipment ${ship.shipment_no} has already left`);

    const done = [];
    const failed = [];

    const insLine = db.prepare(
      `INSERT INTO shipment_lines(shipment_id, article_id, old_epc, customer_epc, carton_no, swapped_by)
       VALUES(?,?,?,?,?,?)`);

    for (const p of pairs) {
      const trackingEpc = String(p.tracking_epc || '').trim().toUpperCase();
      const customerEpc = String(p.customer_epc || '').trim().toUpperCase();
      try {
        if (!trackingEpc || !customerEpc) throw badRequest('Both the tracking tag and the customer tag are required');
        if (trackingEpc === customerEpc) throw badRequest('The customer tag must differ from the tracking tag');

        const { article: art } = prepareSwap(trackingEpc);
        if (ship.order_id && art.order_id !== ship.order_id) {
          throw conflict(`${art.serial_no} belongs to order ${art.order_no || '-'}, not ${ship.order_no}`);
        }
        if (ship.customer_id && art.customer_id && art.customer_id !== ship.customer_id) {
          throw conflict(`${art.serial_no} belongs to a different customer`);
        }
        if (get('SELECT id FROM articles WHERE epc = ?', customerEpc)) {
          throw conflict(`Customer tag ${customerEpc} is already in use`);
        }
        if (get('SELECT id FROM epc_history WHERE epc = ? AND unbound_at IS NULL', customerEpc)) {
          throw conflict(`Customer tag ${customerEpc} is already bound to another article`);
        }

        // Retire the tracking tag, bind the customer tag, keep the trail.
        run(`UPDATE epc_history SET unbound_at = datetime('now','localtime'), reason = 'Tracking tag removed at dispatch'
              WHERE article_id = ? AND epc = ? AND unbound_at IS NULL`, art.id, art.epc);
        run(`INSERT INTO epc_history(article_id, epc, kind, user_id, reason)
             VALUES(?,?, 'CUSTOMER', ?, 'Customer tag applied at dispatch')`, art.id, customerEpc, userId ?? null);
        run(`UPDATE articles
                SET epc = ?, final_tag_epc = ?, tracking_tag_removed_at = datetime('now','localtime'), status = 'READY'
              WHERE id = ?`, customerEpc, customerEpc, art.id);
        insLine.run(shipmentId, art.id, trackingEpc, customerEpc, cartonNo || p.carton_no || null, userId ?? null);

        logEvent(art.id, 'RETIRE', {
          from: 'DISPATCH', to: 'DISPATCH', userId,
          detail: { removed_tracking_epc: trackingEpc, customer_epc: customerEpc, shipment: ship.shipment_no },
        });
        done.push({ article_id: art.id, serial_no: art.serial_no, tracking_epc: trackingEpc, customer_epc: customerEpc });
      } catch (e) {
        failed.push({ tracking_epc: trackingEpc, customer_epc: customerEpc, message: e.message });
      }
    }

    run(`UPDATE shipments SET qty = (SELECT COUNT(*) FROM shipment_lines WHERE shipment_id = ?),
                              status = CASE WHEN status = 'OPEN' THEN 'PACKED' ELSE status END
          WHERE id = ?`, shipmentId, shipmentId);

    return { shipment: shipmentById(shipmentId), swapped: done.length, done, failed };
  });
}

export function shipmentLines(shipmentId, { limit = 2000, offset = 0 } = {}) {
  return all(
    `SELECT sl.*, a.serial_no, st.code AS style_code, cl.code AS color_code, sz.code AS size_code,
            u.full_name AS swapped_by_name
       FROM shipment_lines sl
       JOIN articles a ON a.id = sl.article_id
       JOIN styles st ON st.id = a.style_id
       JOIN colors cl ON cl.id = a.color_id
       JOIN sizes sz ON sz.id = a.size_id
       LEFT JOIN users u ON u.id = sl.swapped_by
      WHERE sl.shipment_id = ? ORDER BY sl.id LIMIT ? OFFSET ?`,
    shipmentId, Math.min(limit, 10000), offset);
}

export function ship({ shipmentId, carrier = null, userId }) {
  return tx(() => {
    const s = shipmentById(shipmentId);
    if (s.status === 'SHIPPED') throw conflict('Shipment has already been despatched');
    const ids = all('SELECT article_id FROM shipment_lines WHERE shipment_id = ?', shipmentId).map((r) => r.article_id);
    if (!ids.length) throw conflict('Shipment is empty');

    for (const part of chunked(ids)) {
      run(`UPDATE articles SET stage = 'SHIPPED', status = 'SHIPPED', stage_since = datetime('now','localtime'),
                               shipped_at = datetime('now','localtime')
            WHERE id IN (${holders(part.length)})`, ...part);
    }
    logEvents(ids, 'SHIP', { from: 'DISPATCH', to: 'SHIPPED', userId, detail: { shipment: s.shipment_no } });
    run(`UPDATE shipments SET status = 'SHIPPED', shipped_at = datetime('now','localtime'), carrier = COALESCE(?, carrier), qty = ?
          WHERE id = ?`, carrier, ids.length, shipmentId);
    return { shipment: shipmentById(shipmentId), shipped: ids.length };
  });
}

/** Order progress: ordered vs in production vs shipped, per size. */
export function orderProgress(orderId) {
  const order = get(
    `SELECT o.*, cu.code AS customer_code, cu.name AS customer_name
       FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE o.id = ?`, orderId);
  if (!order) throw notFound('Order not found');
  const lines = all(
    `SELECT ol.*, st.code AS style_code, st.name AS style_name, cl.code AS color_code, sz.code AS size_code, sz.sort_ord
       FROM order_lines ol
       JOIN styles st ON st.id = ol.style_id
       JOIN colors cl ON cl.id = ol.color_id
       JOIN sizes sz ON sz.id = ol.size_id
      WHERE ol.order_id = ? ORDER BY st.code, cl.code, sz.sort_ord`, orderId);
  const produced = all(
    `SELECT a.style_id, a.color_id, a.size_id, a.stage, COUNT(*) AS qty
       FROM articles a WHERE a.order_id = ? GROUP BY a.style_id, a.color_id, a.size_id, a.stage`, orderId);
  const map = new Map();
  for (const p of produced) {
    const k = `${p.style_id}|${p.color_id}|${p.size_id}`;
    const cur = map.get(k) || { total: 0, shipped: 0, by_stage: {} };
    cur.total += p.qty;
    cur.by_stage[p.stage] = p.qty;
    if (p.stage === 'SHIPPED') cur.shipped += p.qty;
    map.set(k, cur);
  }
  for (const l of lines) {
    const m = map.get(`${l.style_id}|${l.color_id}|${l.size_id}`) || { total: 0, shipped: 0, by_stage: {} };
    l.in_production = m.total;
    l.shipped = m.shipped;
    l.by_stage = m.by_stage;
    l.balance = l.qty - m.shipped;
    l.pct = l.qty ? Math.round((m.shipped / l.qty) * 100) : 0;
  }
  return { order, lines };
}
