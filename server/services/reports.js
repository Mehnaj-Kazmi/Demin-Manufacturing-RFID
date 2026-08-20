import { all, get, run, buildFrom, nowJulian } from '../lib/db.js';
import { badRequest, notFound } from '../lib/http.js';

/**
 * Modular report builder.
 *
 * Users pick a dataset, then choose columns, filters, groupings and aggregates.
 * Nothing from the request is ever interpolated into SQL: every field maps to a
 * pre-declared expression in the registry below, and all values go through bound
 * parameters. Adding a new reportable area means adding a dataset here.
 */

const F = (key, label, expr, type = 'text', opts = {}) => ({
  key, label, expr, type,
  groupable: opts.groupable !== false,
  filterable: opts.filterable !== false,
  aggregatable: opts.aggregatable ?? (type === 'number'),
});

export const DATASETS = {
  articles: {
    label: 'Articles / WIP',
    description: 'One row per garment with its current section, age and order details.',
    base: 'FROM articles a',
    joins: [
      { alias: 'st', sql: 'JOIN styles st ON st.id = a.style_id' },
      { alias: 'cl', sql: 'JOIN colors cl ON cl.id = a.color_id' },
      { alias: 'sz', sql: 'JOIN sizes  sz ON sz.id = a.size_id' },
      { alias: 'ft', sql: 'LEFT JOIN fabric_types ft ON ft.id = st.fabric_type_id', needs: ['st'] },
      { alias: 'o',  sql: 'LEFT JOIN orders o        ON o.id  = a.order_id' },
      { alias: 'cu', sql: 'LEFT JOIN customers cu    ON cu.id = a.customer_id' },
      { alias: 'b',  sql: 'LEFT JOIN bundles b       ON b.id  = a.bundle_id' },
      { alias: 'co', sql: 'LEFT JOIN cut_orders co   ON co.id = a.cut_order_id' },
      { alias: 'md', sql: 'LEFT JOIN movement_docs md ON md.id = a.arrived_doc' },
      { alias: 'ub', sql: 'LEFT JOIN users ub        ON ub.id = a.created_by' },
    ],
    fields: [
      F('article_id', 'Article ID', 'a.id', 'number', { aggregatable: false }),
      F('serial_no', 'Serial No', 'a.serial_no'),
      F('epc', 'Current EPC', 'a.epc'),
      F('stage', 'Section', 'a.stage'),
      F('status', 'Status', 'a.status'),
      F('qc_state', 'QC State', 'a.qc_state'),
      F('qc_fail_count', 'QC Fails', 'a.qc_fail_count', 'number'),
      F('style_code', 'Style Code', 'st.code'),
      F('style_name', 'Style Name', 'st.name'),
      F('color_code', 'Colour Code', 'cl.code'),
      F('color_name', 'Colour', 'cl.name'),
      F('size_code', 'Size', 'sz.code'),
      F('size_ord', 'Size Order', 'sz.sort_ord', 'number', { aggregatable: false }),
      F('fabric_code', 'Fabric Code', 'ft.code'),
      F('fabric_name', 'Fabric', 'ft.name'),
      F('order_no', 'Order No', 'o.order_no'),
      F('ship_date', 'Order Ship Date', 'o.ship_date', 'date'),
      F('customer_code', 'Customer Code', 'cu.code'),
      F('customer_name', 'Customer', 'cu.name'),
      F('cut_no', 'Cut Order', 'co.cut_no'),
      F('bundle_no', 'Bundle', 'b.bundle_no'),
      F('arrival_doc', 'Received On Batch', 'md.doc_no'),
      F('arrival_batch_ref', 'Batch Reference', 'md.batch_ref'),
      F('stage_since', 'In Section Since', 'a.stage_since', 'date'),
      // __NOW_JD__ is substituted with the current local julian day when the query
      // is built; julianday('now') inline would be re-evaluated for every row.
      F('age_hours', 'Age In Section (h)', `ROUND((__NOW_JD__ - julianday(a.stage_since)) * 24.0, 1)`, 'number'),
      F('created_at', 'Tagged At', 'a.created_at', 'date'),
      F('created_shift', 'Tagged On Shift', 'a.created_shift'),
      F('created_by_name', 'Tagged By', 'ub.full_name'),
      F('final_tag_epc', 'Customer Tag', 'a.final_tag_epc'),
      F('shipped_at', 'Shipped At', 'a.shipped_at', 'date'),
      F('qty', 'Quantity', '1', 'number', { groupable: false, filterable: false }),
    ],
    defaultColumns: ['stage', 'style_code', 'color_code', 'size_code', 'order_no', 'customer_name', 'status'],
  },

  events: {
    label: 'Tracking Events',
    description: 'Every scan and status change, with operator, shift and document.',
    base: 'FROM article_events e',
    joins: [
      { alias: 'a',  sql: 'JOIN articles a ON a.id = e.article_id' },
      { alias: 'st', sql: 'JOIN styles st ON st.id = a.style_id', needs: ['a'] },
      { alias: 'cl', sql: 'JOIN colors cl ON cl.id = a.color_id', needs: ['a'] },
      { alias: 'sz', sql: 'JOIN sizes  sz ON sz.id = a.size_id', needs: ['a'] },
      { alias: 'o',  sql: 'LEFT JOIN orders o     ON o.id = a.order_id', needs: ['a'] },
      { alias: 'cu', sql: 'LEFT JOIN customers cu ON cu.id = a.customer_id', needs: ['a'] },
      { alias: 'u',  sql: 'LEFT JOIN users u      ON u.id = e.user_id' },
      { alias: 'r',  sql: 'LEFT JOIN readers r    ON r.id = e.reader_id' },
      { alias: 'd',  sql: 'LEFT JOIN movement_docs d ON d.id = e.doc_id' },
    ],
    fields: [
      F('ts', 'Timestamp', 'e.ts', 'date'),
      F('day', 'Day', 'substr(e.ts, 1, 10)', 'date'),
      F('hour', 'Hour', "(substr(e.ts, 1, 13) || ':00')"),
      F('event_type', 'Event', 'e.event_type'),
      F('stage_from', 'From Section', 'e.stage_from'),
      F('stage_to', 'To Section', 'e.stage_to'),
      F('shift_code', 'Shift', 'e.shift_code'),
      F('serial_no', 'Serial No', 'a.serial_no'),
      F('epc', 'EPC', 'a.epc'),
      F('style_code', 'Style', 'st.code'),
      F('color_code', 'Colour', 'cl.code'),
      F('size_code', 'Size', 'sz.code'),
      F('order_no', 'Order No', 'o.order_no'),
      F('customer_name', 'Customer', 'cu.name'),
      F('user_name', 'Operator', 'u.full_name'),
      F('username', 'User ID', 'u.username'),
      F('user_role', 'Role', 'u.role'),
      F('reader_code', 'Reader', 'r.code'),
      F('reader_section', 'Reader Section', 'r.section'),
      F('doc_no', 'Document', 'd.doc_no'),
      F('detail', 'Detail', 'e.detail', 'text', { groupable: false }),
      F('qty', 'Count', '1', 'number', { groupable: false, filterable: false }),
    ],
    defaultColumns: ['ts', 'event_type', 'serial_no', 'stage_from', 'stage_to', 'user_name', 'doc_no'],
  },

  movements: {
    label: 'Dispatch & Receipt Documents',
    description: 'Section-to-section transfers with expected/received tally and variance.',
    base: 'FROM movement_docs d',
    joins: [
      { alias: 'uc', sql: 'LEFT JOIN users uc ON uc.id = d.created_by' },
      { alias: 'ur', sql: 'LEFT JOIN users ur ON ur.id = d.received_by' },
    ],
    fields: [
      F('doc_no', 'Document No', 'd.doc_no'),
      F('from_stage', 'From', 'd.from_stage'),
      F('to_stage', 'To', 'd.to_stage'),
      F('status', 'Status', 'd.status'),
      F('batch_ref', 'Batch Ref', 'd.batch_ref'),
      F('wash_recipe', 'Wash Recipe', 'd.wash_recipe'),
      F('group_key', 'Sorted By', 'd.group_key'),
      F('expected_count', 'Expected', 'd.expected_count', 'number'),
      F('received_count', 'Received', 'd.received_count', 'number'),
      F('missing_count', 'Missing', 'd.missing_count', 'number'),
      F('extra_count', 'Extra', 'd.extra_count', 'number'),
      F('variance', 'Variance', '(d.received_count - d.expected_count)', 'number'),
      F('created_at', 'Dispatched At', 'd.created_at', 'date'),
      F('day', 'Day', 'substr(d.created_at, 1, 10)', 'date'),
      F('received_at', 'Received At', 'd.received_at', 'date'),
      F('turnaround_h', 'Turnaround (h)', `ROUND((julianday(d.received_at) - julianday(d.created_at)) * 24.0, 2)`, 'number'),
      F('created_by_name', 'Dispatched By', 'uc.full_name'),
      F('received_by_name', 'Received By', 'ur.full_name'),
      F('variance_note', 'Variance Note', 'd.variance_note', 'text', { groupable: false }),
      F('docs', 'Documents', '1', 'number', { groupable: false, filterable: false }),
    ],
    defaultColumns: ['doc_no', 'from_stage', 'to_stage', 'status', 'expected_count', 'received_count', 'missing_count', 'created_at'],
  },

  qc: {
    label: 'QC Inspections & Defects',
    description: 'Inspection results with their defect codes and position on the design. '
      + 'Note: as soon as a defect field is used, an inspection contributes one row per defect '
      + 'recorded against it - so counts become defect counts rather than inspection counts.',
    base: 'FROM qc_inspections q',
    joins: [
      { alias: 'a',  sql: 'JOIN articles a ON a.id = q.article_id' },
      { alias: 'st', sql: 'JOIN styles st ON st.id = a.style_id', needs: ['a'] },
      { alias: 'cl', sql: 'JOIN colors cl ON cl.id = a.color_id', needs: ['a'] },
      { alias: 'sz', sql: 'JOIN sizes  sz ON sz.id = a.size_id', needs: ['a'] },
      { alias: 'u',  sql: 'JOIN users u ON u.id = q.inspector_id' },
      { alias: 'o',  sql: 'LEFT JOIN orders o     ON o.id = a.order_id', needs: ['a'] },
      { alias: 'cu', sql: 'LEFT JOIN customers cu ON cu.id = a.customer_id', needs: ['a'] },
      { alias: 'df', sql: 'LEFT JOIN qc_defects df ON df.inspection_id = q.id' },
      { alias: 'dc', sql: 'LEFT JOIN defect_codes dc ON dc.id = df.defect_code_id', needs: ['df'] },
    ],
    fields: [
      F('inspected_at', 'Inspected At', 'q.inspected_at', 'date'),
      F('day', 'Day', 'substr(q.inspected_at, 1, 10)', 'date'),
      F('shift_code', 'Shift', 'q.shift_code'),
      F('result', 'Result', 'q.result'),
      F('attempt', 'Attempt', 'q.attempt', 'number'),
      F('serial_no', 'Serial No', 'a.serial_no'),
      F('style_code', 'Style', 'st.code'),
      F('style_name', 'Style Name', 'st.name'),
      F('color_code', 'Colour', 'cl.code'),
      F('size_code', 'Size', 'sz.code'),
      F('order_no', 'Order No', 'o.order_no'),
      F('customer_name', 'Customer', 'cu.name'),
      F('inspector_name', 'Inspector', 'u.full_name'),
      F('defect_code', 'Defect Code', 'dc.code'),
      F('defect_name', 'Defect', 'dc.name'),
      F('defect_category', 'Defect Category', 'dc.category'),
      F('severity', 'Severity', 'df.severity'),
      F('view', 'View', 'df.view'),
      F('resolved', 'Defect Resolved', 'df.resolved', 'number'),
      F('remarks', 'Remarks', 'q.remarks', 'text', { groupable: false }),
      F('inspections', 'Rows', '1', 'number', { groupable: false, filterable: false }),
      F('fails', 'Fails', "CASE WHEN q.result = 'FAIL' THEN 1 ELSE 0 END", 'number', { groupable: false, filterable: false }),
    ],
    defaultColumns: ['inspected_at', 'serial_no', 'style_code', 'result', 'defect_name', 'severity', 'inspector_name'],
  },

  rolls: {
    label: 'Fabric Rolls',
    description: 'Denim roll stock, consumption and location.',
    base: 'FROM fabric_rolls r',
    joins: [
      { alias: 'ft', sql: 'JOIN fabric_types ft ON ft.id = r.fabric_type_id' },
      { alias: 'cl', sql: 'JOIN colors cl ON cl.id = r.color_id' },
      { alias: 'g',  sql: 'LEFT JOIN grn g ON g.id = r.grn_id' },
    ],
    fields: [
      F('roll_no', 'Roll No', 'r.roll_no'),
      F('epc', 'Roll Tag', 'r.epc'),
      F('grn_no', 'GRN No', 'g.grn_no'),
      F('supplier', 'Supplier', 'g.supplier'),
      F('fabric_code', 'Fabric Code', 'ft.code'),
      F('fabric_name', 'Fabric', 'ft.name'),
      F('composition', 'Composition', 'ft.composition'),
      F('color_code', 'Colour Code', 'cl.code'),
      F('color_name', 'Colour', 'cl.name'),
      F('shade_batch', 'Shade / Batch', 'r.shade_batch'),
      F('status', 'Status', 'r.status'),
      F('location', 'Location', 'r.location'),
      F('length_m', 'Length (m)', 'r.length_m', 'number'),
      F('remaining_m', 'Remaining (m)', 'r.remaining_m', 'number'),
      F('consumed_m', 'Consumed (m)', '(r.length_m - r.remaining_m)', 'number'),
      F('weight_kg', 'Weight (kg)', 'r.weight_kg', 'number'),
      F('received_at', 'Received At', 'r.received_at', 'date'),
      F('age_days', 'Days In Store', `ROUND(julianday('now','localtime') - julianday(r.received_at), 1)`, 'number'),
      F('rolls', 'Rolls', '1', 'number', { groupable: false, filterable: false }),
    ],
    defaultColumns: ['roll_no', 'fabric_name', 'color_name', 'status', 'length_m', 'remaining_m', 'location'],
  },

  production: {
    label: 'Cutting & Bundles',
    description: 'Cut orders, bundle quantities and how many have been tagged.',
    base: 'FROM bundles b',
    joins: [
      { alias: 'c',  sql: 'JOIN cut_orders c ON c.id = b.cut_order_id' },
      { alias: 'st', sql: 'JOIN styles st ON st.id = c.style_id', needs: ['c'] },
      { alias: 'cl', sql: 'JOIN colors cl ON cl.id = c.color_id', needs: ['c'] },
      { alias: 'sz', sql: 'JOIN sizes  sz ON sz.id = b.size_id' },
      { alias: 'o',  sql: 'LEFT JOIN orders o     ON o.id = c.order_id', needs: ['c'] },
      { alias: 'cu', sql: 'LEFT JOIN customers cu ON cu.id = o.customer_id', needs: ['o'] },
    ],
    fields: [
      F('bundle_no', 'Bundle No', 'b.bundle_no'),
      F('cut_no', 'Cut Order', 'c.cut_no'),
      F('cut_status', 'Cut Status', 'c.status'),
      F('bundle_status', 'Bundle Status', 'b.status'),
      F('style_code', 'Style', 'st.code'),
      F('style_name', 'Style Name', 'st.name'),
      F('color_code', 'Colour', 'cl.code'),
      F('size_code', 'Size', 'sz.code'),
      F('order_no', 'Order No', 'o.order_no'),
      F('customer_name', 'Customer', 'cu.name'),
      F('qty', 'Bundle Qty', 'b.qty', 'number'),
      F('tagged_qty', 'Tagged Qty', 'b.tagged_qty', 'number'),
      F('pending_tag', 'Pending Tagging', '(b.qty - b.tagged_qty)', 'number'),
      F('received_qty', 'Counted At Stitching', 'b.received_qty', 'number'),
      F('count_variance', 'Count Variance', '(COALESCE(b.received_qty, b.qty) - b.qty)', 'number'),
      F('created_at', 'Cut At', 'b.created_at', 'date'),
      F('issued_at', 'Issued At', 'b.issued_at', 'date'),
      F('received_at', 'Received At Stitching', 'b.received_at', 'date'),
      F('bundles', 'Bundles', '1', 'number', { groupable: false, filterable: false }),
    ],
    defaultColumns: ['bundle_no', 'cut_no', 'style_code', 'color_code', 'size_code', 'qty', 'tagged_qty', 'bundle_status'],
  },

  shipments: {
    label: 'Shipments',
    description: 'Packed and despatched cartons with the customer tag applied to each garment.',
    base: 'FROM shipment_lines sl',
    joins: [
      { alias: 's',  sql: 'JOIN shipments s ON s.id = sl.shipment_id' },
      { alias: 'a',  sql: 'JOIN articles a ON a.id = sl.article_id' },
      { alias: 'st', sql: 'JOIN styles st ON st.id = a.style_id', needs: ['a'] },
      { alias: 'cl', sql: 'JOIN colors cl ON cl.id = a.color_id', needs: ['a'] },
      { alias: 'sz', sql: 'JOIN sizes  sz ON sz.id = a.size_id', needs: ['a'] },
      { alias: 'cu', sql: 'LEFT JOIN customers cu ON cu.id = s.customer_id', needs: ['s'] },
      { alias: 'o',  sql: 'LEFT JOIN orders o ON o.id = s.order_id', needs: ['s'] },
      { alias: 'u',  sql: 'LEFT JOIN users u ON u.id = sl.swapped_by' },
    ],
    fields: [
      F('shipment_no', 'Shipment No', 's.shipment_no'),
      F('status', 'Status', 's.status'),
      F('carton_no', 'Carton', 'sl.carton_no'),
      F('customer_name', 'Customer', 'cu.name'),
      F('order_no', 'Order No', 'o.order_no'),
      F('serial_no', 'Serial No', 'a.serial_no'),
      F('style_code', 'Style', 'st.code'),
      F('color_code', 'Colour', 'cl.code'),
      F('size_code', 'Size', 'sz.code'),
      F('old_epc', 'Tracking Tag Removed', 'sl.old_epc'),
      F('customer_epc', 'Customer Tag', 'sl.customer_epc'),
      F('swapped_at', 'Re-tagged At', 'sl.swapped_at', 'date'),
      F('swapped_by_name', 'Re-tagged By', 'u.full_name'),
      F('shipped_at', 'Shipped At', 's.shipped_at', 'date'),
      F('carrier', 'Carrier', 's.carrier'),
      F('units', 'Units', '1', 'number', { groupable: false, filterable: false }),
    ],
    defaultColumns: ['shipment_no', 'customer_name', 'order_no', 'style_code', 'size_code', 'customer_epc', 'shipped_at'],
  },
};

export const AGGREGATES = {
  COUNT:          { label: 'Count',          sql: (e) => `COUNT(${e})` },
  COUNT_DISTINCT: { label: 'Distinct count', sql: (e) => `COUNT(DISTINCT ${e})` },
  SUM:            { label: 'Sum',            sql: (e) => `SUM(${e})`,   numeric: true },
  AVG:            { label: 'Average',        sql: (e) => `ROUND(AVG(${e}), 2)`, numeric: true },
  MIN:            { label: 'Minimum',        sql: (e) => `MIN(${e})` },
  MAX:            { label: 'Maximum',        sql: (e) => `MAX(${e})` },
};

export const OPERATORS = {
  eq:        { label: 'is',              args: 1, sql: (e) => `${e} = ?` },
  ne:        { label: 'is not',          args: 1, sql: (e) => `${e} <> ?` },
  gt:        { label: 'greater than',    args: 1, sql: (e) => `${e} > ?` },
  gte:       { label: 'at least',        args: 1, sql: (e) => `${e} >= ?` },
  lt:        { label: 'less than',       args: 1, sql: (e) => `${e} < ?` },
  lte:       { label: 'at most',         args: 1, sql: (e) => `${e} <= ?` },
  contains:  { label: 'contains',        args: 1, sql: (e) => `${e} LIKE ?`, wrap: (v) => `%${v}%` },
  starts:    { label: 'starts with',     args: 1, sql: (e) => `${e} LIKE ?`, wrap: (v) => `${v}%` },
  between:   { label: 'between',         args: 2, sql: (e) => `${e} BETWEEN ? AND ?` },
  in:        { label: 'is one of',       args: 'list', sql: (e, n) => `${e} IN (${new Array(n).fill('?').join(',')})` },
  not_in:    { label: 'is not one of',   args: 'list', sql: (e, n) => `${e} NOT IN (${new Array(n).fill('?').join(',')})` },
  is_null:   { label: 'is empty',        args: 0, sql: (e) => `${e} IS NULL` },
  not_null:  { label: 'is not empty',    args: 0, sql: (e) => `${e} IS NOT NULL` },
  last_days: { label: 'in the last N days', args: 1, sql: (e) => `${e} >= datetime('now','localtime', ?)`,
               wrap: (v) => `-${Math.max(0, Math.min(3650, Number(v) || 0))} days` },
  today:     { label: 'is today',        args: 0, sql: (e) => `date(${e}) = date('now','localtime')` },
};

/** Public description of the registry, used to drive the report designer UI. */
export function catalogue() {
  return {
    datasets: Object.entries(DATASETS).map(([key, d]) => ({
      key, label: d.label, description: d.description,
      default_columns: d.defaultColumns,
      fields: d.fields.map((f) => ({
        key: f.key, label: f.label, type: f.type,
        groupable: f.groupable, filterable: f.filterable, aggregatable: f.aggregatable,
      })),
    })),
    aggregates: Object.entries(AGGREGATES).map(([key, a]) => ({ key, label: a.label, numeric: !!a.numeric })),
    operators: Object.entries(OPERATORS).map(([key, o]) => ({ key, label: o.label, args: o.args })),
  };
}

/** Strip anything that could break out of a quoted SQL alias. */
function safeAlias(label) {
  if (!label) return null;
  const cleaned = String(label).replace(/[^A-Za-z0-9 _()%.\-/]/g, '').trim().slice(0, 60);
  return cleaned || null;
}

function fieldOf(dataset, key) {
  const f = dataset.fields.find((x) => x.key === key);
  if (!f) throw badRequest(`Unknown field "${key}" for this dataset`);
  return f;
}

/**
 * Compile and run a report definition.
 * Returns { columns, rows, sql } - the SQL is echoed back so power users can see
 * exactly what ran.
 */
export function runReport(def, { limitCap = 10000 } = {}) {
  const ds = DATASETS[def.dataset];
  if (!ds) throw badRequest(`Unknown dataset "${def.dataset}"`);

  const groupBy = (def.group_by || []).filter(Boolean);
  const aggregates = (def.aggregates || []).filter(Boolean);
  const isAggregated = groupBy.length > 0 || aggregates.length > 0;

  const select = [];
  const columns = [];
  const params = [];

  if (isAggregated) {
    for (const key of groupBy) {
      const f = fieldOf(ds, key);
      if (!f.groupable) throw badRequest(`Field "${f.label}" cannot be grouped`);
      select.push(`${f.expr} AS "${f.key}"`);
      columns.push({ key: f.key, label: f.label, type: f.type, role: 'group' });
    }
    if (!aggregates.length) {
      select.push('COUNT(*) AS "count"');
      columns.push({ key: 'count', label: 'Count', type: 'number', role: 'metric' });
    }
    for (const a of aggregates) {
      const fn = AGGREGATES[a.fn];
      if (!fn) throw badRequest(`Unknown aggregate "${a.fn}"`);
      const f = fieldOf(ds, a.field);
      if (fn.numeric && f.type !== 'number') {
        throw badRequest(`${fn.label} needs a numeric field; "${f.label}" is ${f.type}`);
      }
      // The alias is echoed into SQL, so keep it to a safe character set.
      const key = safeAlias(a.label) || `${a.fn.toLowerCase()}_${f.key}`;
      select.push(`${fn.sql(f.expr)} AS "${key}"`);
      columns.push({ key, label: a.label || `${fn.label} of ${f.label}`, type: 'number', role: 'metric' });
    }
  } else {
    const cols = (def.columns && def.columns.length) ? def.columns : ds.defaultColumns;
    for (const key of cols) {
      const f = fieldOf(ds, key);
      select.push(`${f.expr} AS "${f.key}"`);
      columns.push({ key: f.key, label: f.label, type: f.type, role: 'detail' });
    }
  }

  const where = [];
  for (const flt of def.filters || []) {
    if (!flt || !flt.field) continue;
    const f = fieldOf(ds, flt.field);
    if (!f.filterable) throw badRequest(`Field "${f.label}" cannot be filtered`);
    const op = OPERATORS[flt.op];
    if (!op) throw badRequest(`Unknown operator "${flt.op}"`);

    if (op.args === 0) {
      where.push(op.sql(f.expr));
    } else if (op.args === 'list') {
      const vals = Array.isArray(flt.value) ? flt.value
        : String(flt.value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!vals.length) throw badRequest(`"${f.label}" needs at least one value`);
      if (vals.length > 500) throw badRequest(`"${f.label}" accepts at most 500 values`);
      where.push(op.sql(f.expr, vals.length));
      params.push(...vals);
    } else if (op.args === 2) {
      if (flt.value == null || flt.value2 == null) throw badRequest(`"${f.label}" needs two values`);
      where.push(op.sql(f.expr));
      params.push(flt.value, flt.value2);
    } else {
      if (flt.value == null || flt.value === '') throw badRequest(`"${f.label}" needs a value`);
      where.push(op.sql(f.expr));
      params.push(op.wrap ? op.wrap(flt.value) : flt.value);
    }
  }

  const orderParts = [];
  for (const s of def.sort || []) {
    if (!s || !s.field) continue;
    const dir = String(s.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const col = columns.find((c) => c.key === s.field);
    if (col) { orderParts.push(`"${col.key}" ${dir}`); continue; }
    const f = fieldOf(ds, s.field);
    if (isAggregated) throw badRequest(`Cannot sort a grouped report by "${f.label}" - add it as a column first`);
    orderParts.push(`${f.expr} ${dir}`);
  }
  if (!orderParts.length && isAggregated) {
    const metric = columns.find((c) => c.role === 'metric');
    if (metric) orderParts.push(`"${metric.key}" DESC`);
  }

  const limit = Math.min(Math.max(Number(def.limit) || 1000, 1), limitCap);
  // Only join what this report references - a two-column report should not pay
  // for eight joins across a million-row event table.
  const from = buildFrom(ds.base, ds.joins, [...select, ...where, ...orderParts,
    ...groupBy.map((k) => fieldOf(ds, k).expr)]);
  const sql = [
    `SELECT ${select.join(', ')}`,
    from,
    where.length ? `WHERE ${where.join(' AND ')}` : '',
    isAggregated && groupBy.length ? `GROUP BY ${groupBy.map((k) => fieldOf(ds, k).expr).join(', ')}` : '',
    orderParts.length ? `ORDER BY ${orderParts.join(', ')}` : '',
    `LIMIT ${limit}`,
  ].filter(Boolean).join('\n').replaceAll('__NOW_JD__', String(nowJulian()));

  const rows = all(sql, ...params);
  return { columns, rows, sql, row_count: rows.length, truncated: rows.length >= limit };
}

/* ------------------------------------------------------------------ */
/* Saved definitions                                                    */
/* ------------------------------------------------------------------ */
export function saveReport({ id = null, name, dataset, definition, shared = true, userId }) {
  if (!name || !name.trim()) throw badRequest('Give the report a name');
  if (!DATASETS[dataset]) throw badRequest(`Unknown dataset "${dataset}"`);
  runReport({ ...definition, dataset, limit: 1 });   // validate before storing

  const json = JSON.stringify({ ...definition, dataset });
  if (id) {
    const existing = get('SELECT * FROM report_defs WHERE id = ?', id);
    if (!existing) throw notFound('Report not found');
    run(`UPDATE report_defs SET name = ?, dataset = ?, definition = ?, shared = ?, updated_at = datetime('now','localtime')
          WHERE id = ?`, name.trim(), dataset, json, shared ? 1 : 0, id);
    return reportById(id);
  }
  const res = run(
    `INSERT INTO report_defs(name, dataset, definition, shared, owner_id) VALUES(?,?,?,?,?)`,
    name.trim(), dataset, json, shared ? 1 : 0, userId ?? null);
  return reportById(Number(res.lastInsertRowid));
}

export function reportById(id) {
  const r = get(`SELECT rd.*, u.full_name AS owner_name FROM report_defs rd
                 LEFT JOIN users u ON u.id = rd.owner_id WHERE rd.id = ?`, id);
  if (!r) throw notFound('Report not found');
  r.definition = JSON.parse(r.definition);
  return r;
}

export function listReports(userId) {
  return all(
    `SELECT rd.id, rd.name, rd.dataset, rd.shared, rd.owner_id, rd.created_at, rd.updated_at,
            u.full_name AS owner_name
       FROM report_defs rd LEFT JOIN users u ON u.id = rd.owner_id
      WHERE rd.shared = 1 OR rd.owner_id = ?
      ORDER BY rd.name`, userId ?? -1);
}

export function deleteReport(id) {
  const r = reportById(id);
  run('DELETE FROM report_defs WHERE id = ?', id);
  return { deleted: r.name };
}
