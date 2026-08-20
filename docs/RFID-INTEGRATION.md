# Connecting RFID hardware

The system is deliberately reader-agnostic. Readers do not need to understand the
process — they only report which tags they saw, and the server works out what
those tags mean. Three integration styles are supported, and a plant will
normally use all three.

---

## 1. Handheld readers in keyboard-wedge mode (no integration work)

Most UHF handhelds and Bluetooth sleds can be configured to type the tags they
read as if they were a keyboard, one per line. Every screen that collects a bulk
read has a large scan box that accepts exactly that.

**Setup:** put the reader in keyboard-wedge / HID mode, set the suffix to
carriage return, sign in on the tablet or PC, open the screen, click the scan box
and pull the trigger. Nothing else is required.

This is the right choice for the fabric store, the sorting stations, retrofit
benches and anywhere the operator moves around.

---

## 2. Fixed readers posting to the gateway

Portals, tunnels and tabletop encoders post the tags they read to a single
endpoint and get back a plain-language answer about what they just saw.

Register the reader under **Users & Readers → RFID readers**, then click
**Issue key**. The key is shown once.

```
POST /api/gateway/reads
X-Reader-Key: <the issued key>
Content-Type: application/json

{ "epcs": ["E28011606000020000000001", "E28011606000020000000002"] }
```

```json
{
  "reader": "RDR-WSH-IN",
  "section": "WASHING",
  "read_count": 2,
  "resolved": 2,
  "unknown": [],
  "in_this_section": 1,
  "elsewhere": [
    { "epc": "E280...02", "serial_no": "ART-260816-000042",
      "stage": "SORTING", "status": "IN_STAGE" }
  ],
  "summary": [
    { "style_code": "SLM-501", "color_code": "IND", "size_code": "32", "qty": 2 }
  ]
}
```

`elsewhere` is the useful part for a portal: it tells you immediately that a
garment went through a door it should not have. Drive a light stack or a buzzer
from it.

A health check is available at `GET /api/gateway/ping` with the same header.

### Which readers a plant typically needs

| Section | Type | What it does |
|---|---|---|
| Fabric warehouse | Handheld | Roll receipt and issue by scanning roll tags |
| Cutting | Tabletop | Confirms which rolls were consumed by a cut order |
| Stitching | Encoder (one per line) | Writes and verifies each new garment tag |
| Sorting station | Tunnel or overhead portal | Reads the whole pile in one pass |
| Wash inbound | Portal | Tallies the arriving batch against its transfer note |
| Wash outbound | Tunnel | Reads the washed batch for post-wash sorting |
| Finishing inbound | Portal | Tallies the batch from wash |
| QC benches | Tabletop | Identifies the garment in front of the inspector |
| Retrofit bench | Tabletop | Pops up the defect file when a garment is picked up |
| Dispatch | Encoder + outbound portal | Writes customer tags, confirms what left the building |

---

## 3. Driving the station APIs directly

If you want a reader or a PLC to complete a whole step without an operator, call
the same API the browser uses. Authenticate as a service user with a bearer
token, or send the reader key and the call is attributed to that reader.

Bulk receive at a wash inbound portal, for example:

```
POST /api/movements/324/receive
Authorization: Bearer <token>
Content-Type: application/json

{ "epcs": ["E280...01", "E280...02", ...], "accept_extras": false }
```

```json
{
  "tally": { "expected": 240, "received": 238, "missing": 2,
             "extra": 0, "matched": false },
  "missing_articles": [ { "serial_no": "ART-...", "epc": "E280...", "style_code": "SLM-501" } ]
}
```

The endpoint is safe to call repeatedly: a second pass over the same batch picks
up stragglers and clears the variance rather than double-counting.

Useful endpoints for automation:

| Endpoint | Purpose |
|---|---|
| `POST /api/articles/resolve` | What are these tags? Returns each garment and a summary |
| `POST /api/movements/dispatch` | Generate a transfer note from a bulk read |
| `POST /api/movements/{id}/receive` | Bulk receive and tally |
| `GET /api/movements/pending/{stage}` | What is inbound to this section |
| `POST /api/sorting/sessions/{id}/read` | Add a read to a sorting session |
| `POST /api/qc/batch-pass` | Pass a clean batch |
| `POST /api/stitching/commission` | Register newly tagged garments |

---

## Tag and encoding recommendations

**Tracking tags (in-house, reusable).** A laundry-grade or heat-sealable inlay
that survives stone washing, bleaching and pressing. These tags go through the
wash with the garment, so ordinary paper labels will not do. Any EPC scheme works
— the system treats the EPC as an opaque 8–96 character hex identifier — but
using a private prefix (for example `E2801160…`) makes in-house tags instantly
distinguishable from customer tags in the logs.

**Customer tags (applied at dispatch).** Encoded to whatever the customer
specifies. Record that specification against the customer in **Master Data →
Customers**; it is shown to the dispatch operator at the moment they apply the
tag.

**Anti-cloning.** If your readers report the chip TID, pass it as `tids` when
commissioning; it is stored against the article and can be used to detect a
cloned EPC later.

### Reading a dense pile

A sorting station reading several hundred garments at once needs attention to
physics, not software:

- Circularly polarised antennas, at least two, at different angles.
- Move the pile through the field rather than reading it stationary — a tunnel
  with a conveyor reads far more reliably than a static portal.
- Use session S2 with a suitable persistence so tags do not keep replying.
- Read for a fixed dwell (typically 2–4 seconds) and send the accumulated unique
  EPC set in one request rather than streaming individual reads.

The system is built to expect imperfect reads. That is what the tally is for: a
short read shows up immediately as a variance with a named list of exactly which
garments were not seen, and re-scanning clears it.

---

## Deployment sketch

```
   Plant network (isolated VLAN)
   ┌──────────────────────────────────────────────┐
   │                                              │
   │  Fixed readers ──── HTTP ────┐               │
   │  (portals, tunnels,          │               │
   │   encoders)                  ▼               │
   │                        ┌───────────┐         │
   │  Tablets / station ────▶  Server   │         │
   │  PCs (browser)         │  :8080    │         │
   │                        └─────┬─────┘         │
   │  Handhelds (wedge) ──────────┘               │
   │                              │               │
   │                        data/denim_rfid.db    │
   └──────────────────────────────────────────────┘
                 │
          reverse proxy (TLS)
                 │
          office network / VPN
```

Put a reverse proxy in front for HTTPS and set the `Secure` cookie flag there.
The server itself needs no external services — no separate database, no message
broker, no cloud dependency — so it keeps running through an internet outage,
which matters on a factory floor.
