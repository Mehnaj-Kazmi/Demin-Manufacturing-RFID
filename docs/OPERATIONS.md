# Station guide

What each section does, in the order the work flows. Written for the people
using the screens, not for developers.

---

## Fabric Warehouse

**Receiving a delivery.** *Fabric Store → Receive rolls*. Enter the supplier and
invoice, then add a line per roll: fabric type, colour, shade/batch, length,
location. If the roll carries its own tag, scan it into the *Roll tag EPC* box —
that is what later lets cutting pull rolls by scanning instead of typing roll
numbers. *Duplicate last* copies the previous roll's type, colour, shade and
location so a pallet of the same fabric goes in quickly.

The system generates the GRN number and a roll number for any roll you leave
blank.

**Issuing to cutting.** Done from the cut order — see Cutting below. The
warehouse controls it, but it is recorded against the cut order so consumption
can be traced back to the garments that came out of it.

**What the KPI shows.** Rolls in stock, metres available, and how long stock has
been sitting. Ageing matters for denim: shade lots drift.

---

## Cutting

**Create a cut order** for a design, colour and planned quantity, linked to the
customer order it is for.

**Issue fabric against it.** Only rolls of the matching colour are offered. Scan
the roll tags or tick the rolls, adjust the metres if you are not consuming the
whole roll, and issue. The system blocks issuing more than a roll has left.

**Create bundles.** Enter a line per size: how many bundles, and how many pieces
in each. The system numbers every bundle.

**Hand over to stitching.** *Issue all to stitching*. No tags exist yet at this
point, so the handover is on a manual count — which is exactly what the next
section checks.

---

## Stitching

Two jobs happen here.

**1. Count the bundle in.** *Stitching → Bundles waiting to be counted in →
Count in*. Physically count the pieces and type what you actually counted. If it
differs from what cutting recorded, the difference is stored against the bundle —
it is not hidden, and it is not treated as an error. From then on the bundle
quantity is your count.

**2. Attach and register the tags.** *Attach tags*. Fit a tag to each finished
garment, then scan them all into the box. Press *Register garments*.

Each tag is checked against every tag in the system. A tag already in use is
rejected with a list of the offending EPCs, so one tag can never identify two
garments. You also cannot register more tags than the bundle has pieces.

From this moment the garment exists in the system, and the tag is its identity.

---

## Sorting Station

**Open a session** and choose how the read should be grouped. Two presets cover
the normal cases:

- *Before wash*: design / colour / size
- *After wash*: order / size

**Read the pile.** Bulk-read everything on the table into the box and press *Add
to session*. Reading the same tag twice is harmless. The system splits the read
into groups and shows you a count per group.

Anything that cannot be sorted here — a tag from another section, an
unregistered tag — appears in the **Exceptions** list. Set those garments aside;
they are not included in any group.

**Send each group onward.** Each group gets its own *Send to…* button, its own
batch reference and its own transfer note, which prints automatically.

The same screen is used for post-wash sorting: open the session on *Washing &
Treatment*, group by order and size, and send each group to Finishing.

---

## Transfers — the screen every section uses

Pick your section at the top right.

**Receiving.** *Waiting to be received into…* lists everything other sections
have sent you, with how long it has been waiting. Press *Receive*, bulk-read what
physically arrived, and press *Receive and tally*.

The result is one of two things:

- **MATCHED** — the count agrees with the note. Done.
- **VARIANCE** — it does not. You get a named list of exactly which garments were
  not seen, by serial number and style. Re-scan to pick up stragglers; each pass
  updates the tally. If they genuinely cannot be found, a supervisor uses *Close
  variance*, which requires a written reason and puts those garments on hold in
  the sending section so they stop counting as in transit.

Anything scanned that was not on the note is reported separately. Tick *Accept
extras* only if you intend to take them in.

**Dispatching.** *Dispatch a batch*: choose the destination, bulk-read what is
leaving, optionally add a batch reference and wash recipe, and generate the note.
Use *Check what was read* first if you want to see the breakdown before
committing. Anything that cannot be dispatched — already in transit, in the wrong
section, on hold, or an unregistered tag — is listed with the reason.

A dispatch that has not yet been received can be cancelled; the garments return
to your section.

---

## Washing & Treatment

Receive the batch on the transfer note as above. The note carries the wash recipe
the sorting station specified.

When the wash is finished, open a **sorting session on Washing & Treatment**,
group by customer order and size, and dispatch each group to Finishing. That
generates the outgoing document Finishing will tally against.

---

## Finishing

Receive and tally the batch from wash. After finishing work is complete, dispatch
to QC — again as a bulk read producing a note.

---

## Quality Control

**Inspecting.** *Quality Control → Inspect*. Scan the garment's tag. The screen
shows the design image, the colour, size, order and customer, how long it has
been waiting, and any previous inspections.

**Recording a defect.** Click the design image at the exact place the problem is.
Choose the defect, its severity and an optional note. A numbered marker appears
where you clicked. Switch between *Front* and *Back* to mark either side. Click a
marker to remove it. If a defect has no meaningful position, use *Add defect
without a position*.

**Pass or fail.** *Pass* frees the garment for dispatch. *Fail* requires at least
one defect — the system will not accept a failure without a reason — and opens a
retrofit job automatically. Then dispatch the failures to Retrofitting on a
transfer note.

**Passing a clean batch.** *Pass all scanned garments* on the Inspect screen
handles a whole pile at once. Each pass is still recorded individually against
you, so use it only when every garment really has been checked.

**Defect analysis** shows where defects occur on each design — every marker ever
recorded, overlaid on the garment — plus the most common defects and inspector
activity.

---

## Retrofitting

Receive the batch from QC on its transfer note.

**Pick up a garment and scan it.** Everything QC recorded appears: the design
with numbered markers exactly where each defect is, the defect list with severity
and notes, who inspected it and when, and how many times this garment has failed
before.

**Record the correction.** Tick off the defects you have corrected (all are
ticked by default), describe what you did, and press *Mark corrected*. The
description is required — QC reads it on re-inspection.

If a garment cannot be saved, *Scrap garment* writes it off with a reason.

**Send them back.** Dispatch the corrected garments to QC on a transfer note.
QC receives and tallies them exactly as before, and re-inspects. The second
inspection is recorded as attempt 2 against the same garment.

---

## Dispatch & Packing

Receive QC-passed garments into Dispatch on a transfer note. Only garments that
have actually passed QC can be sent here.

**Open a shipment** for the customer order.

**Swap the tags.** *Re-tag garments*. Scan the tracking tag first: the garment's
details appear along with the customer's tag specification. Apply the customer's
tag, scan it, and the pair is queued. Repeat for the tray, then *Apply tag swap*.

At that point, for each garment: the tracking tag is unbound and released back to
the pool, the customer tag becomes the garment's identity, and the whole history
stays attached. Scanning the removed tracking tag afterwards correctly reports
"not registered" — it may already be on a new garment.

**Despatch.** Print the packing list, then *Despatch shipment*. The garments are
marked shipped and leave work in process.

---

## Supervisors and managers

**Dashboard** — what every section is holding right now, how long it has been
there, what has not tallied, and where work is ageing.

**Section WIP** — the same inventory sliced however you need it. Group by design,
colour, size, order, customer, fabric, age band, status, or **the bulk receipt it
arrived on**, and filter by customer, order, arrival date or minimum waiting
time. Every view exports to CSV.

**Reports** — build your own. Pick a dataset (articles, tracking events,
transfers, QC, fabric, cutting, shipments), choose columns or a grouping with
calculations, add filters and sorting, run it, save it for the team, export it.

**Audit Trail** — every state change with the user, the time and the address it
came from.

**Corrections.** If a garment is genuinely stuck in the wrong place, *Trace
Article → Correct section* moves it, and *Replace damaged tag* re-tags it without
losing its history. Both require a written reason and are recorded against you.
