/**
 * Process model: the sections a garment passes through, the legal moves
 * between them, and the role capabilities that guard each action.
 *
 * Everything downstream (movement engine, KPIs, UI nav) is driven from here,
 * so adding a section is a change in this file plus a nav entry.
 */

export const STAGES = {
  FABRIC_WH: { seq: 10, name: 'Fabric Warehouse', short: 'Fabric', tracks: 'ROLL',    color: '#8b6f47' },
  CUTTING:   { seq: 20, name: 'Cutting',          short: 'Cutting', tracks: 'BUNDLE', color: '#c2703d' },
  STITCHING: { seq: 30, name: 'Stitching',        short: 'Stitch',  tracks: 'ARTICLE', color: '#3d7ec2' },
  SORTING:   { seq: 40, name: 'Sorting Station',  short: 'Sorting', tracks: 'ARTICLE', color: '#5b53c9' },
  WASHING:   { seq: 50, name: 'Washing & Treatment', short: 'Wash', tracks: 'ARTICLE', color: '#2f9e8f' },
  FINISHING: { seq: 60, name: 'Finishing',        short: 'Finish',  tracks: 'ARTICLE', color: '#d29b1e' },
  QC:        { seq: 70, name: 'Quality Control',  short: 'QC',      tracks: 'ARTICLE', color: '#c0392b' },
  RETROFIT:  { seq: 80, name: 'Retrofitting',     short: 'Retrofit', tracks: 'ARTICLE', color: '#e07b39' },
  DISPATCH:  { seq: 90, name: 'Dispatch & Packing', short: 'Dispatch', tracks: 'ARTICLE', color: '#2d8a4e' },
  SHIPPED:   { seq: 99, name: 'Shipped',          short: 'Shipped', tracks: 'ARTICLE', color: '#6b7280' },
};

export const STAGE_CODES = Object.keys(STAGES);

/** Sections that hold garment WIP (used by KPI/WIP screens). */
export const WIP_STAGES = STAGE_CODES.filter(
  (s) => STAGES[s].tracks === 'ARTICLE' && s !== 'SHIPPED'
);

/**
 * Legal article transfers. Each edge declares whether the receiving side must
 * do a bulk RFID tally against the dispatch document.
 */
export const ROUTES = [
  { from: 'STITCHING', to: 'SORTING',   label: 'Stitching output to sorting',        tally: true },
  { from: 'SORTING',   to: 'WASHING',   label: 'Sorted batch to wash & treatment',   tally: true },
  { from: 'WASHING',   to: 'FINISHING', label: 'Washed & sorted batch to finishing', tally: true },
  { from: 'FINISHING', to: 'QC',        label: 'Finished goods to QC',               tally: true },
  { from: 'QC',        to: 'RETROFIT',  label: 'QC rejects to retrofitting',         tally: true },
  { from: 'RETROFIT',  to: 'QC',        label: 'Reworked articles back to QC',       tally: true },
  { from: 'QC',        to: 'DISPATCH',  label: 'QC-passed goods to dispatch',        tally: true },
];

const routeIndex = new Map(ROUTES.map((r) => [`${r.from}>${r.to}`, r]));
export const findRoute = (from, to) => routeIndex.get(`${from}>${to}`) || null;
export const routesFrom = (from) => ROUTES.filter((r) => r.from === from);

/* ------------------------------------------------------------------ */
/* Roles & capabilities                                                */
/* ------------------------------------------------------------------ */
export const CAPS = [
  'fabric.receive', 'fabric.issue',
  'cutting.manage',
  'stitching.commission',
  'sort.run',
  'movement.dispatch', 'movement.receive', 'movement.close_variance',
  'qc.inspect', 'qc.override',
  'rework.perform',
  'dispatch.tagswap', 'dispatch.ship',
  'masters.manage', 'orders.manage',
  'reports.view', 'reports.design',
  'kpi.view',
  'admin.users', 'admin.readers', 'admin.audit',
  'article.adjust',
];

export const ROLES = {
  ADMIN:      { name: 'Administrator',   caps: ['*'] },
  MANAGER:    { name: 'Plant Manager',   caps: ['kpi.view', 'reports.view', 'reports.design', 'orders.manage', 'masters.manage',
                                                'movement.close_variance', 'article.adjust', 'admin.audit', 'qc.override'] },
  SUPERVISOR: { name: 'Section Supervisor', caps: ['kpi.view', 'reports.view', 'reports.design',
                                                'fabric.receive', 'fabric.issue', 'cutting.manage', 'stitching.commission',
                                                'sort.run', 'movement.dispatch', 'movement.receive', 'movement.close_variance',
                                                'rework.perform', 'dispatch.tagswap', 'dispatch.ship'] },
  OPERATOR:   { name: 'Operator',        caps: ['fabric.receive', 'fabric.issue', 'cutting.manage', 'stitching.commission',
                                                'sort.run', 'movement.dispatch', 'movement.receive', 'rework.perform',
                                                'dispatch.tagswap', 'reports.view', 'kpi.view'] },
  QC:         { name: 'QC Inspector',    caps: ['qc.inspect', 'movement.dispatch', 'movement.receive', 'reports.view', 'kpi.view'] },
  VIEWER:     { name: 'Viewer',          caps: ['reports.view', 'kpi.view'] },
};

export function roleHas(role, cap) {
  const r = ROLES[role];
  if (!r) return false;
  return r.caps.includes('*') || r.caps.includes(cap);
}

/* ------------------------------------------------------------------ */
/* Shifts - 2 x 8h covering a 16h operating day                        */
/* ------------------------------------------------------------------ */
export const SHIFT_DEFS = [
  { code: 'A', name: 'Shift A (Morning)', start: '06:00', end: '14:00' },
  { code: 'B', name: 'Shift B (Evening)', start: '14:00', end: '22:00' },
];

/** Which shift a timestamp falls into; OFF outside the operating window. */
export function shiftFor(date = new Date()) {
  const mins = date.getHours() * 60 + date.getMinutes();
  for (const s of SHIFT_DEFS) {
    const [sh, sm] = s.start.split(':').map(Number);
    const [eh, em] = s.end.split(':').map(Number);
    if (mins >= sh * 60 + sm && mins < eh * 60 + em) return s.code;
  }
  return 'OFF';
}

/* ------------------------------------------------------------------ */
/* Article status                                                       */
/* ------------------------------------------------------------------ */
export const ARTICLE_STATUS = ['IN_STAGE', 'IN_TRANSIT', 'REWORK', 'READY', 'SHIPPED', 'HOLD', 'SCRAP'];
export const QC_STATES = ['PENDING', 'PASS', 'FAIL', 'REWORKED'];

/** Dimensions a sorting station may group a bulk read by. */
export const SORT_DIMENSIONS = {
  style:    { label: 'Design / Style',  col: 'st.code',  name: 'st.name' },
  color:    { label: 'Colour',          col: 'cl.code',  name: 'cl.name' },
  size:     { label: 'Size',            col: 'sz.code',  name: 'sz.name' },
  order:    { label: 'Customer Order',  col: 'o.order_no', name: 'o.order_no' },
  customer: { label: 'Customer',        col: 'cu.code',  name: 'cu.name' },
  fabric:   { label: 'Fabric Type',     col: 'ft.code',  name: 'ft.name' },
};
