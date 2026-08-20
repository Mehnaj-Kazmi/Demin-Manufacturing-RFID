# Denim RFID Track & Trace

A manufacturing execution system for a high-volume denim garment factory, built
around item-level UHF RFID. Every garment carries a tracking tag from the moment
it is stitched until it is packed, so the plant always knows what it is holding,
where it is, how long it has been there, and who last touched it.

Sized for **125,000 garments a day across two 8-hour shifts**.

---

## Quick start

Requires Node.js 22.5 or newer. There are no npm dependencies to install — the
database is Node's built-in SQLite and the browser client is plain ES modules.

```bash
node server/seed.js --reset
```

```bash
npm start
```

Then open <http://localhost:8080> and sign in as `admin` / `admin123`.

`--reset` deletes any existing database and builds a demo plant: master data,
five customer orders, a batch walked end-to-end through every section, and a
second wave deliberately left mid-process so every screen has live work on it.
Run `node server/seed.js` without `--reset` for master data and users only.

Further reading:

- [docs/OPERATIONS.md](docs/OPERATIONS.md) — station-by-station guide for the people using it
- [docs/RFID-INTEGRATION.md](docs/RFID-INTEGRATION.md) — connecting real reader hardware
- [docs/manual/](docs/manual/) — the illustrated end-user manual, in LaTeX

Station logins created by the seed (all listed in `server/seed.js`):

| Username | Role | Section |
|---|---|---|
| `admin` | Administrator | — |
| `pmanager` | Plant Manager | — |
| `store.sup` | Supervisor | Fabric Warehouse |
| `cut.sup` | Supervisor | Cutting |
| `stitch.op1` | Operator | Stitching |
| `sort.op1` | Operator | Sorting |
| `wash.op1` | Operator | Washing |
| `finish.sup` | Supervisor | Finishing |
| `qc1`, `qc2` | QC Inspector | Quality Control |
| `retro.op1` | Operator | Retrofitting |
| `disp.sup` | Supervisor | Dispatch |

Operator passwords are `op123`; supervisors use `<section>123` (e.g. `cut123`).
**Change these before the system is used for real.**

---

## The process it models

```
Fabric Warehouse ──issue rolls──▶ Cutting ──manual count──▶ Stitching
                                                                │
                                                     tag attached here
                                                                ▼
                                                          Sorting Station
                                                                │  sorted by design/colour/size
                                                                ▼
                                                    Washing & Treatment
                                                                │  sorted by order/size/type
                                                                ▼
                                                            Finishing
                                                                ▼
                                                       Quality Control ──fail──▶ Retrofitting
                                                                │  pass            │
                                                                │◀─── corrected ───┘
                                                                ▼
                              Dispatch  ── tracking tag removed, customer tag applied ──▶ Shipped
```

Two things happen at every arrow:

1. **The sending section bulk-reads what is leaving.** The system generates a
   transfer note listing exactly which garments were sent.
2. **The receiving section bulk-reads what arrived** and the system tallies it
   against that note. A short or over count is recorded as a variance rather
   than quietly accepted, and the batch can be re-scanned later to pick up
   stragglers.

Fabric rolls and cut bundles are tracked too, in their own units — rolls and
metres in the warehouse, bundles and pieces in cutting — so the KPI dashboard
covers all nine departments, not just the ones handling tagged garments.

### Where the tag comes from and where it goes

A garment's identity is its EPC. Stitching attaches a tag and registers it; a tag
already in use anywhere in the system is rejected, so one tag can never mean two
garments. At dispatch the tracking tag is removed and the customer's own tag is
applied: the garment keeps its whole history, and the tracking EPC is **unbound**
so that physical tag can be recycled onto a new garment without ever resolving to
the old one. A damaged tag can be replaced mid-process the same way.

---

## What each screen does

| Screen | Purpose |
|---|---|
| **Dashboard** | Live inventory in every section with its ageing profile, transfers that have not tallied, dwell times, quality trend |
| **Section WIP** | Slice in-process inventory by any combination of design, colour, size, order, customer, fabric, age, status, or **the bulk receipt it arrived on** |
| **Fabric Store** | Goods receipt of denim rolls (with optional roll tags), roll register, stock by type and colour |
| **Cutting** | Cut orders, fabric issue against them, bundle creation, handover to stitching |
| **Stitching** | Count bundles in manually, then attach and register a tag per garment |
| **Sorting** | Bulk-read a pile, let the system group it, dispatch each group as its own batch |
| **Transfers** | Every section's inbound and outbound: dispatch, bulk receive, tally, variance handling, printable notes |
| **Quality Control** | Inspect a garment against its design image, mark defects at the exact spot they occur, pass or fail |
| **Retrofitting** | Scan a garment and its full defect file appears — including where each defect is on the design — then record the correction |
| **Dispatch** | Swap tracking tags for customer tags, pack into cartons, print the packing list, despatch |
| **Trace Article** | The complete life story of any garment, found by any tag it has carried or by serial number |
| **Orders** | Customer orders with live size-by-size production and shipping progress |
| **Reports** | Build your own reports from any dataset, save them, export to CSV |
| **Master Data** | Designs (and their QC images), customers, fabrics, colours, sizes, defect codes |
| **Users & Readers** | Station accounts, roles, and RFID reader registration |
| **Audit Trail** | Who did what, when, and from which address |

---

## The user manual

`docs/manual/` holds an illustrated manual written for people with no computer
experience. It is LaTeX source plus 47 screenshots taken from the running
system, and it builds into five PDFs — one combined book, and a separate
booklet for each portal so a department can be handed only its own:

| Document | For |
|---|---|
| `main.tex` | Everything, all four portals in one book |
| `manual-operator.tex` | Station staff — store, cutting, stitching, sorting, wash, finishing, retrofit, dispatch |
| `manual-qc.tex` | Inspectors at the QC benches |
| `manual-supervisor.tex` | Whoever runs a department |
| `manual-admin.tex` | Plant management and the system administrator |

```bash
node docs/manual/check.mjs
```

Verifies the sources without needing a compiler: balanced environments and
braces, references that resolve, screenshots that exist, and control sequences
nobody defined — the last of these catches a `\\` line break that has lost a
backslash, which is the mistake that most often breaks this manual.

### Producing the PDFs

There are three routes, because not every machine has a TeX distribution.

```bash
npm run manual:pdf
```

**No install required.** Renders the same content files to HTML and prints
them to PDF with the Chrome or Edge already on the machine. The three TikZ
diagrams have hand-written SVG counterparts in `diagrams.mjs`, so the drawings
survive the trip. Output lands in `docs/manual/pdf/` — 221 pages across the
five documents.

```bash
node docs/manual/build.mjs
```

**The reference output.** Uses whichever LaTeX engine is installed
(`latexmk`, `tectonic`, `pdflatex`, `xelatex` or `lualatex`) and runs two
passes so the contents page and cross-references settle. If no engine is
found it says so and prints the alternatives rather than failing obscurely.

```bash
node docs/manual/bundle.mjs
```

**Real LaTeX without installing it.** Writes `denim-manual-overleaf.zip` —
upload at [overleaf.com](https://overleaf.com) via **New Project → Upload
Project**, pick the main document, and compile in the browser.

Screenshots are regenerated from the live app with `node tools/screenshots.js`
(the server must be running).

---

## Running it without RFID hardware

Every screen that collects a bulk read has a **Simulate reader** button that
returns the tags actually sitting in that location, so the whole process can be
demonstrated and tested before a single reader is installed. The receiving screen
also has **Simulate short read**, which deliberately misses two tags so you can
see the variance handling work.

When real hardware arrives, nothing about the workflow changes — see
[docs/RFID-INTEGRATION.md](docs/RFID-INTEGRATION.md).

---

## Architecture

```
server/
  index.js            HTTP server, static files, error handling
  schema.sql          Database schema, indexes and the event rollup
  seed.js             Master data, demo plant, worked example
  lib/
    db.js             SQLite connection, transactions, document numbering
    http.js           Router, JSON/CSV helpers, input coercion
    auth.js           Password hashing, sessions, capabilities, audit
    process.js        Sections, legal routes, roles, shifts  ← the process model
    print.js          Printable transfer notes and packing lists
  services/
    articles.js       Tag commissioning, EPC resolution, event trail
    movement.js       Dispatch, bulk receive, tally, variance
    sorting.js        Sorting sessions and bucket dispatch
    qc.js             Inspections, positioned defects, retrofit jobs
    fabric.js         Goods receipt, rolls, cut orders, bundles
    dispatch.js       Tag swap, shipments, order progress
    kpi.js            WIP, ageing, throughput, quality, alerts
    reports.js        Dataset registry and the report compiler
  routes.js           The HTTP API
public/               Browser client (no build step, plain ES modules)
tools/
  apitest.js          End-to-end API test over HTTP
  loadtest.js         Throughput test at 125,000 garments/day
  querybench.js       Dashboard query timings against a loaded database
  syntaxcheck.js      Parses every module
```

`server/lib/process.js` is the single place the process is defined. Sections,
which transfers are legal, what each role may do, and the shift pattern all come
from that file; the movement engine, the KPI screens and the navigation are
driven by it.

### Notable design decisions

**Timestamps are plant-local, not UTC.** Shift boundaries and WIP ageing are
meaningless if they do not match the clock on the factory floor.

**Reports cannot be injected.** The report builder never interpolates user input
into SQL. Every field maps to a pre-declared expression in a server-side
registry, values are bound parameters, and unknown fields are rejected outright.

**Removed tags stop resolving.** Once a tracking tag is unbound, scanning it
returns "not registered" rather than the garment it used to be on — because that
tag may already be on a different garment.

**The largest table is queried, not scanned.** `article_events` grows by about
1.1M rows a day. Throughput and shift-output charts read a pre-aggregated hourly
rollup that is refreshed incrementally from a watermark, so they are instant
regardless of how much history has accumulated.

---

## Testing

```bash
node tools/syntaxcheck.js
```

```bash
node tools/apitest.js
```

The API test drives the full journey over HTTP as the real stations do — fabric
receipt, cutting, manual bundle count, tag commissioning, every transfer with a
deliberate short read, QC failure with a positioned defect, retrofit, re-inspection,
tag swap and shipping — then checks the KPIs, the report builder (including
rejecting an injected field name), the reader gateway and the audit trail.
66 checks; the server must be running.

### Performance

```bash
DATA_DIR=./data/loadtest node tools/loadtest.js 125000
```

Builds and processes a full day's production in a scratch database. Measured on
an ordinary Windows workstation:

| Phase | Rate |
|---|---|
| Tag commissioning (stitching) | ~5,600 garments/second |
| Dispatch | ~10,000–11,000 garments/second |
| Bulk receive with tally | ~5,800–9,500 garments/second |

The sustained rate the plant actually needs is **2.17 garments/second**. The
slowest phase runs roughly 2,500× faster than required, so the constraint is the
factory, not the software.

```bash
DATA_DIR=./data/loadtest node tools/querybench.js
```

Dashboard query times against that loaded database (125,000 articles, 1,125,000
events, 444 MB):

| Query | Median |
|---|---|
| Plant headline KPIs | 35 ms |
| Section overview with ageing | 518 ms |
| WIP by design/colour/size | 118 ms |
| WIP by receiving batch | 191 ms |
| Throughput by hour, shift performance | < 1 ms (served from the rollup) |
| Single tag lookup at a bench | < 1 ms |
| Resolving a 2,500-tag portal read | 30 ms |
| Ad-hoc 7-day report over raw events | 990 ms |

Delete `./data/loadtest` when you are finished with it.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Where the database lives |
| `SESSION_HOURS` | `12` | Session lifetime — one shift plus handover |
| `ADMIN_PASSWORD` | `admin123` | Initial administrator password on an empty database |
| `NODE_ENV` | — | Set to `production` to stop returning error details to clients |

## Before going live

- Change every seeded password, and delete the accounts you do not need.
- Put the server behind HTTPS. Session cookies are `HttpOnly` and `SameSite=Strict`,
  but they are not marked `Secure` because the app also has to work over plain
  HTTP on an isolated plant network; terminate TLS at a reverse proxy and set
  `Secure` there.
- Take regular copies of `data/denim_rfid.db`. It is in WAL mode, so use
  `sqlite3 data/denim_rfid.db ".backup data/backup.db"` rather than copying the
  file while the server is running.
- Decide how long to keep `article_events`. At full rate it grows by roughly
  1.1M rows and 400 MB a day. The hourly rollup keeps the dashboards fast, so
  raw events older than your traceability requirement can be archived out.
- Review `server/lib/process.js` against how the plant actually runs — section
  names, legal routes between them, shift times and role permissions all live
  there.
