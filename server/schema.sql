-- ===========================================================================
--  DENIM RFID MES - SCHEMA
--  Target load: 125,000 articles/day, 2 shifts x 8h
-- ===========================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Security / people
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  emp_code      TEXT,
  pass_hash     TEXT NOT NULL,
  pass_salt     TEXT NOT NULL,
  role          TEXT NOT NULL,           -- ADMIN, MANAGER, SUPERVISOR, OPERATOR, QC, VIEWER
  section       TEXT,                    -- home section (see stages)
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at  TEXT NOT NULL,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS shifts (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,      -- A / B
  name        TEXT NOT NULL,
  start_time  TEXT NOT NULL,             -- HH:MM
  end_time    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id     INTEGER REFERENCES users(id),
  username    TEXT,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  detail      TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_ts     ON audit_log(ts);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log(entity, entity_id);

-- ---------------------------------------------------------------------------
-- Master data
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  country   TEXT,
  tag_spec  TEXT,                        -- final customer tag encoding spec (SGTIN-96 / custom)
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fabric_types (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  composition  TEXT,
  weight_oz    REAL,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS colors (
  id      INTEGER PRIMARY KEY,
  code    TEXT NOT NULL UNIQUE,
  name    TEXT NOT NULL,
  hex     TEXT,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sizes (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  sort_ord  INTEGER NOT NULL DEFAULT 0,
  active    INTEGER NOT NULL DEFAULT 1
);

-- Style = design. Carries the reference image used for the QC defect map.
CREATE TABLE IF NOT EXISTS styles (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT,
  fabric_type_id INTEGER REFERENCES fabric_types(id),
  image_front    TEXT,                   -- relative path under /uploads or /img
  image_back     TEXT,
  wash_recipe    TEXT,
  smv            REAL,                   -- standard minute value
  active         INTEGER NOT NULL DEFAULT 1
);

-- Defect catalogue used by QC
CREATE TABLE IF NOT EXISTS defect_codes (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  category  TEXT,                        -- STITCHING, FABRIC, WASH, FINISHING, MEASUREMENT
  severity  TEXT NOT NULL DEFAULT 'MAJOR', -- CRITICAL, MAJOR, MINOR
  active    INTEGER NOT NULL DEFAULT 1
);

-- RFID readers / stations
CREATE TABLE IF NOT EXISTS readers (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  section      TEXT NOT NULL,            -- stage code this reader belongs to
  mode         TEXT NOT NULL DEFAULT 'HANDHELD', -- TUNNEL, PORTAL, HANDHELD, TABLETOP, ENCODER
  host         TEXT,
  api_key      TEXT,
  last_seen_at TEXT,
  active       INTEGER NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
-- Sales orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY,
  order_no     TEXT NOT NULL UNIQUE,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  po_ref       TEXT,
  order_date   TEXT NOT NULL DEFAULT (date('now','localtime')),
  ship_date    TEXT,
  status       TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, IN_PRODUCTION, CLOSED, CANCELLED
  remarks      TEXT
);
CREATE INDEX IF NOT EXISTS ix_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS order_lines (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  style_id   INTEGER NOT NULL REFERENCES styles(id),
  color_id   INTEGER NOT NULL REFERENCES colors(id),
  size_id    INTEGER NOT NULL REFERENCES sizes(id),
  qty        INTEGER NOT NULL,
  unit_price REAL
);
CREATE INDEX IF NOT EXISTS ix_ol_order ON order_lines(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ol ON order_lines(order_id, style_id, color_id, size_id);

-- ---------------------------------------------------------------------------
-- Fabric warehouse
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grn (
  id            INTEGER PRIMARY KEY,
  grn_no        TEXT NOT NULL UNIQUE,
  supplier      TEXT,
  invoice_ref   TEXT,
  received_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  received_by   INTEGER REFERENCES users(id),
  remarks       TEXT,
  status        TEXT NOT NULL DEFAULT 'OPEN'
);

CREATE TABLE IF NOT EXISTS fabric_rolls (
  id             INTEGER PRIMARY KEY,
  roll_no        TEXT NOT NULL UNIQUE,
  epc            TEXT UNIQUE,            -- UHF tag on the roll (optional)
  grn_id         INTEGER REFERENCES grn(id),
  fabric_type_id INTEGER NOT NULL REFERENCES fabric_types(id),
  color_id       INTEGER NOT NULL REFERENCES colors(id),
  shade_batch    TEXT,
  width_in       REAL,
  length_m       REAL NOT NULL DEFAULT 0,
  remaining_m    REAL NOT NULL DEFAULT 0,
  weight_kg      REAL,
  location       TEXT,                   -- rack / bay
  status         TEXT NOT NULL DEFAULT 'IN_STOCK', -- IN_STOCK, ISSUED, PARTIAL, CONSUMED, QUARANTINE
  received_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by     INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_roll_status ON fabric_rolls(status);
CREATE INDEX IF NOT EXISTS ix_roll_type   ON fabric_rolls(fabric_type_id, color_id);

-- ---------------------------------------------------------------------------
-- Cutting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cut_orders (
  id          INTEGER PRIMARY KEY,
  cut_no      TEXT NOT NULL UNIQUE,
  order_id    INTEGER REFERENCES orders(id),
  style_id    INTEGER NOT NULL REFERENCES styles(id),
  color_id    INTEGER NOT NULL REFERENCES colors(id),
  planned_qty INTEGER NOT NULL DEFAULT 0,
  cut_qty     INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'PLANNED', -- PLANNED, ISSUED, CUTTING, CUT, CLOSED
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by  INTEGER REFERENCES users(id),
  remarks     TEXT
);
CREATE INDEX IF NOT EXISTS ix_cut_status ON cut_orders(status);

-- Roll issue from warehouse to cutting
CREATE TABLE IF NOT EXISTS fabric_issues (
  id           INTEGER PRIMARY KEY,
  issue_no     TEXT NOT NULL,
  cut_order_id INTEGER NOT NULL REFERENCES cut_orders(id),
  roll_id      INTEGER NOT NULL REFERENCES fabric_rolls(id),
  issued_m     REAL NOT NULL,
  issued_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  issued_by    INTEGER REFERENCES users(id),
  scanned      INTEGER NOT NULL DEFAULT 0   -- 1 = confirmed by RFID read of the roll tag
);
CREATE INDEX IF NOT EXISTS ix_fi_cut ON fabric_issues(cut_order_id);

-- Bundles produced by cutting; move to stitching on manual count
CREATE TABLE IF NOT EXISTS bundles (
  id            INTEGER PRIMARY KEY,
  bundle_no     TEXT NOT NULL UNIQUE,
  cut_order_id  INTEGER NOT NULL REFERENCES cut_orders(id),
  size_id       INTEGER NOT NULL REFERENCES sizes(id),
  qty           INTEGER NOT NULL,
  tagged_qty    INTEGER NOT NULL DEFAULT 0,  -- articles commissioned from this bundle
  status        TEXT NOT NULL DEFAULT 'CUT', -- CUT, ISSUED_TO_STITCH, IN_STITCHING, CLOSED
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  issued_at     TEXT,
  issued_by     INTEGER REFERENCES users(id),
  received_qty  INTEGER,                     -- manual count acknowledged by stitching
  received_at   TEXT,
  received_by   INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_bundle_cut    ON bundles(cut_order_id);
CREATE INDEX IF NOT EXISTS ix_bundle_status ON bundles(status);

-- ---------------------------------------------------------------------------
-- Articles - one row per physical garment, keyed by its UHF EPC
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS articles (
  id             INTEGER PRIMARY KEY,
  epc            TEXT NOT NULL UNIQUE,   -- active tracking tag (NULL-able after retire -> moved to epc_history)
  serial_no      TEXT NOT NULL UNIQUE,   -- human readable
  tid            TEXT,                   -- chip TID, anti-clone
  style_id       INTEGER NOT NULL REFERENCES styles(id),
  color_id       INTEGER NOT NULL REFERENCES colors(id),
  size_id        INTEGER NOT NULL REFERENCES sizes(id),
  order_id       INTEGER REFERENCES orders(id),
  customer_id    INTEGER REFERENCES customers(id),
  bundle_id      INTEGER REFERENCES bundles(id),
  cut_order_id   INTEGER REFERENCES cut_orders(id),

  stage          TEXT NOT NULL,          -- current section (stage code)
  status         TEXT NOT NULL DEFAULT 'IN_STAGE', -- IN_STAGE, IN_TRANSIT, REWORK, READY, SHIPPED, SCRAP, HOLD
  stage_since    TEXT NOT NULL DEFAULT (datetime('now','localtime')),  -- drives WIP ageing
  in_transit_doc INTEGER,                -- movement_docs.id while IN_TRANSIT
  arrived_doc    INTEGER,                -- movement_docs.id this article arrived on (bulk receipt)

  qc_state       TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, PASS, FAIL, REWORKED
  qc_fail_count  INTEGER NOT NULL DEFAULT 0,

  final_tag_epc  TEXT,                   -- customer tag applied at dispatch
  tracking_tag_removed_at TEXT,

  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by     INTEGER REFERENCES users(id),
  created_shift  TEXT,
  shipped_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_art_stage      ON articles(stage, status);
CREATE INDEX IF NOT EXISTS ix_art_stage_since ON articles(stage, stage_since);
CREATE INDEX IF NOT EXISTS ix_art_order      ON articles(order_id);
CREATE INDEX IF NOT EXISTS ix_art_cust       ON articles(customer_id);
CREATE INDEX IF NOT EXISTS ix_art_scs        ON articles(style_id, color_id, size_id);
CREATE INDEX IF NOT EXISTS ix_art_bundle     ON articles(bundle_id);
CREATE INDEX IF NOT EXISTS ix_art_final_tag  ON articles(final_tag_epc);
CREATE INDEX IF NOT EXISTS ix_art_created    ON articles(created_at);
CREATE INDEX IF NOT EXISTS ix_art_arrived    ON articles(arrived_doc);
-- Covering index for the WIP/ageing scans: everything the dashboard needs is in
-- the index, so a full pass never touches the (much wider) table rows.
CREATE INDEX IF NOT EXISTS ix_art_wip        ON articles(stage, status, stage_since);

-- Every EPC ever bound to an article (tracking tag, replacement, customer tag)
CREATE TABLE IF NOT EXISTS epc_history (
  id          INTEGER PRIMARY KEY,
  article_id  INTEGER NOT NULL REFERENCES articles(id),
  epc         TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- TRACKING, REPLACEMENT, CUSTOMER
  bound_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  unbound_at  TEXT,
  user_id     INTEGER REFERENCES users(id),
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS ix_epch_article ON epc_history(article_id);
CREATE INDEX IF NOT EXISTS ix_epch_epc     ON epc_history(epc);

-- Full traceability trail
CREATE TABLE IF NOT EXISTS article_events (
  id          INTEGER PRIMARY KEY,
  article_id  INTEGER NOT NULL REFERENCES articles(id),
  ts          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  event_type  TEXT NOT NULL,             -- COMMISSION, SORT, DISPATCH, RECEIVE, QC_PASS, QC_FAIL,
                                         -- REWORK_START, REWORK_DONE, TAG_SWAP, RETIRE, SHIP, ADJUST
  stage_from  TEXT,
  stage_to    TEXT,
  doc_id      INTEGER,
  reader_id   INTEGER REFERENCES readers(id),
  user_id     INTEGER REFERENCES users(id),
  shift_code  TEXT,
  detail      TEXT
);
-- article_events is by far the largest table (~1.1M rows a day at full rate), so
-- its indexes are chosen to cover the queries that actually run rather than to
-- be exhaustive. The two narrow indexes these replace are dropped on upgrade.
DROP INDEX IF EXISTS ix_ev_ts;
DROP INDEX IF EXISTS ix_ev_type;
CREATE INDEX IF NOT EXISTS ix_ev_article ON article_events(article_id, ts);
CREATE INDEX IF NOT EXISTS ix_ev_doc     ON article_events(doc_id);
-- Activity over a time range (throughput, shift output). Covering: the stage
-- columns are carried in the index so grouping never falls back to row lookups.
DROP INDEX IF EXISTS ix_ev_ts_type;
CREATE INDEX IF NOT EXISTS ix_ev_window ON article_events(ts, event_type, stage_to, stage_from);
-- "What moved in and out of each section today" - covering, so a full day's
-- scan never touches the table rows.
CREATE INDEX IF NOT EXISTS ix_ev_daily   ON article_events(event_type, ts, stage_to, stage_from);

-- ---------------------------------------------------------------------------
-- Inter-section movement (dispatch note + bulk RFID receiving/tally)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS movement_docs (
  id              INTEGER PRIMARY KEY,
  doc_no          TEXT NOT NULL UNIQUE,
  doc_type        TEXT NOT NULL DEFAULT 'TRANSFER',
  from_stage      TEXT NOT NULL,
  to_stage        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'DISPATCHED', -- DRAFT, DISPATCHED, RECEIVED, VARIANCE, CANCELLED
  expected_count  INTEGER NOT NULL DEFAULT 0,
  received_count  INTEGER NOT NULL DEFAULT 0,
  missing_count   INTEGER NOT NULL DEFAULT 0,
  extra_count     INTEGER NOT NULL DEFAULT 0,
  batch_ref       TEXT,                  -- wash batch / lot reference
  wash_recipe     TEXT,
  group_key       TEXT,                  -- what the batch was sorted by
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by      INTEGER REFERENCES users(id),
  dispatch_reader INTEGER REFERENCES readers(id),
  received_at     TEXT,
  received_by     INTEGER REFERENCES users(id),
  receive_reader  INTEGER REFERENCES readers(id),
  closed_at       TEXT,
  closed_by       INTEGER REFERENCES users(id),
  variance_note   TEXT,
  remarks         TEXT
);
CREATE INDEX IF NOT EXISTS ix_doc_status ON movement_docs(status);
CREATE INDEX IF NOT EXISTS ix_doc_route  ON movement_docs(from_stage, to_stage, created_at);

CREATE TABLE IF NOT EXISTS doc_lines (
  id          INTEGER PRIMARY KEY,
  doc_id      INTEGER NOT NULL REFERENCES movement_docs(id) ON DELETE CASCADE,
  article_id  INTEGER REFERENCES articles(id),
  epc         TEXT NOT NULL,
  line_state  TEXT NOT NULL DEFAULT 'EXPECTED', -- EXPECTED, RECEIVED, MISSING, EXTRA, UNKNOWN
  received_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_dl_doc     ON doc_lines(doc_id, line_state);
CREATE UNIQUE INDEX IF NOT EXISTS ux_dl  ON doc_lines(doc_id, epc);
CREATE INDEX IF NOT EXISTS ix_dl_article ON doc_lines(article_id);

-- ---------------------------------------------------------------------------
-- Sorting sessions (bulk read -> grouped buckets -> dispatch docs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sort_sessions (
  id          INTEGER PRIMARY KEY,
  session_no  TEXT NOT NULL UNIQUE,
  stage       TEXT NOT NULL,             -- SORTING or WASH_SORTING
  group_by    TEXT NOT NULL,             -- csv of dimensions: style,color,size,order,customer
  status      TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, CLOSED
  scanned     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by  INTEGER REFERENCES users(id),
  reader_id   INTEGER REFERENCES readers(id),
  closed_at   TEXT
);

CREATE TABLE IF NOT EXISTS sort_reads (
  id          INTEGER PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES sort_sessions(id) ON DELETE CASCADE,
  article_id  INTEGER REFERENCES articles(id),
  epc         TEXT NOT NULL,
  bucket_key  TEXT,
  state       TEXT NOT NULL DEFAULT 'OK', -- OK, UNKNOWN, WRONG_STAGE, DUPLICATE
  ts          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_sr_session ON sort_reads(session_id, bucket_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sr  ON sort_reads(session_id, epc);

-- ---------------------------------------------------------------------------
-- QC
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qc_inspections (
  id            INTEGER PRIMARY KEY,
  article_id    INTEGER NOT NULL REFERENCES articles(id),
  attempt       INTEGER NOT NULL DEFAULT 1,
  result        TEXT NOT NULL,           -- PASS, FAIL
  inspector_id  INTEGER NOT NULL REFERENCES users(id),
  reader_id     INTEGER REFERENCES readers(id),
  stage         TEXT NOT NULL DEFAULT 'QC',
  shift_code    TEXT,
  inspected_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  remarks       TEXT
);
CREATE INDEX IF NOT EXISTS ix_qc_article ON qc_inspections(article_id);
CREATE INDEX IF NOT EXISTS ix_qc_ts      ON qc_inspections(inspected_at);
CREATE INDEX IF NOT EXISTS ix_qc_result  ON qc_inspections(result, inspected_at);

-- Defect markers, positioned on the style image (x/y are 0..1 fractions)
CREATE TABLE IF NOT EXISTS qc_defects (
  id             INTEGER PRIMARY KEY,
  inspection_id  INTEGER NOT NULL REFERENCES qc_inspections(id) ON DELETE CASCADE,
  defect_code_id INTEGER NOT NULL REFERENCES defect_codes(id),
  severity       TEXT NOT NULL DEFAULT 'MAJOR',
  view           TEXT NOT NULL DEFAULT 'FRONT',   -- FRONT / BACK
  pos_x          REAL,
  pos_y          REAL,
  note           TEXT,
  resolved       INTEGER NOT NULL DEFAULT 0,
  resolved_at    TEXT,
  resolved_by    INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_qcd_insp ON qc_defects(inspection_id);
CREATE INDEX IF NOT EXISTS ix_qcd_code ON qc_defects(defect_code_id);

-- ---------------------------------------------------------------------------
-- Retrofitting / rework
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rework_jobs (
  id            INTEGER PRIMARY KEY,
  article_id    INTEGER NOT NULL REFERENCES articles(id),
  inspection_id INTEGER REFERENCES qc_inspections(id),
  status        TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, IN_PROGRESS, DONE, SCRAPPED
  opened_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  started_at    TEXT,
  started_by    INTEGER REFERENCES users(id),
  done_at       TEXT,
  done_by       INTEGER REFERENCES users(id),
  action_taken  TEXT,
  remarks       TEXT
);
CREATE INDEX IF NOT EXISTS ix_rw_status  ON rework_jobs(status);
CREATE INDEX IF NOT EXISTS ix_rw_article ON rework_jobs(article_id);

-- ---------------------------------------------------------------------------
-- Dispatch / packing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipments (
  id           INTEGER PRIMARY KEY,
  shipment_no  TEXT NOT NULL UNIQUE,
  order_id     INTEGER REFERENCES orders(id),
  customer_id  INTEGER REFERENCES customers(id),
  status       TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, PACKED, SHIPPED
  qty          INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by   INTEGER REFERENCES users(id),
  shipped_at   TEXT,
  carrier      TEXT,
  remarks      TEXT
);

CREATE TABLE IF NOT EXISTS shipment_lines (
  id            INTEGER PRIMARY KEY,
  shipment_id   INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  article_id    INTEGER NOT NULL REFERENCES articles(id),
  old_epc       TEXT,
  customer_epc  TEXT,
  carton_no     TEXT,
  swapped_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  swapped_by    INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_sl_ship ON shipment_lines(shipment_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sl_article ON shipment_lines(shipment_id, article_id);

-- ---------------------------------------------------------------------------
-- Modular report builder
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_defs (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  dataset     TEXT NOT NULL,             -- key into REPORT_DATASETS registry
  definition  TEXT NOT NULL,             -- JSON: columns, filters, group_by, aggregates, sort, chart
  shared      INTEGER NOT NULL DEFAULT 1,
  owner_id    INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_rd_owner ON report_defs(owner_id);

-- ---------------------------------------------------------------------------
-- Hourly event rollup
--
-- article_events grows by roughly 1.1M rows a day at full rate, so throughput
-- and shift-output charts are served from this pre-aggregated table instead of
-- re-scanning the raw events. Events are append-only, so the rollup is refreshed
-- incrementally from a watermark (see services/kpi.js refreshRollup).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_rollup (
  period      TEXT NOT NULL,             -- 'YYYY-MM-DD HH:00'
  day         TEXT NOT NULL,             -- 'YYYY-MM-DD'
  shift_code  TEXT NOT NULL DEFAULT '-',
  event_type  TEXT NOT NULL,
  stage_from  TEXT NOT NULL DEFAULT '-',
  stage_to    TEXT NOT NULL DEFAULT '-',
  qty         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (period, shift_code, event_type, stage_from, stage_to)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_roll_day    ON event_rollup(day);
CREATE INDEX IF NOT EXISTS ix_roll_period ON event_rollup(period);

-- Sequence counters for document numbering
CREATE TABLE IF NOT EXISTS counters (
  name    TEXT PRIMARY KEY,
  period  TEXT NOT NULL,
  value   INTEGER NOT NULL DEFAULT 0
);
