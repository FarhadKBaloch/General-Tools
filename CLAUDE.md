# General-Tools — working notes for Claude

Millcreek Gardens, wholesale nursery in Ohio (USDA Zones 6a/6b): perennials, herbs,
annuals, sold to independent garden centers and landscape professionals. The owner of
this repo is the Special Projects Director (GitHub `FarhadKBaloch`), who writes and
maintains their own tools. ERP is SBI Software's Horizon (SBINursery). The production
crew's task manager is Google Keep.

House style for everything here: **one self-contained file where possible, no build
step, no npm, no server, no secrets in the repo.** Apps Script when something has to
run unattended inside the Workspace; GitHub Actions when it has to run on a schedule
outside it.

## What is in this repo

| Path | What it is |
| --- | --- |
| `README.md`, `sprout-scout-bot.js`, `shared-logic.js`, `build-shared.js`, `watchlist.js` | Sprout Scout: a Slack daily brief for growers (weather-driven irrigation, disease, pest, frost, light). Runs on GitHub Actions (`.github/workflows/daily.yml`), commits `watchlist.json` back. |
| `EQUIPMENT-MAINTENANCE.md`, `equipment-qr-labels.html`, `maintenance-notify.gs`, `maintenance-webapp.html`, `qr.js`, `qr.test.js` | Equipment maintenance log: QR labels on equipment open a pre-filled request; Apps Script notifies; a phone web app updates requests. |
| `Proof-Of-Concept/` | Purchase-order email reader (Apps Script, read-only Gmail scope, writes one Sheet). |
| `production-dashboard/` | **Production & propagation dashboard** — see its README and the handoff below. |

Tests are plain `node <file>.test.js`, no dependencies.

## Related repos (same owner)

- **[STP](https://github.com/FarhadKBaloch/STP)** — Stock Tracking Platform. Apps Script dashboard over SBI exports in Drive. `tools/README.md` is **the SBI README**: read-only PowerShell exporters that call SBI's own report stored procedures on the on-prem SQL Server (`Millcreek` database, Windows auth), one week at a time, and publish CSV/xlsx to Drive folders `pit`, `txn`, `sales`, `open` on a logon-triggered schedule. `tools/SBI-SQL-Assistant.md` is a paste-in prompt with the schema notes. `docs/crop-definition.md` is the canonical sell-through definition.
- **[PullTool](https://github.com/FarhadKBaloch/PullTool)** — `SBI_Pull_Tracker.html`, `RIO_Pull_Tracker.html`, `Millcreek_Hub.html`. Imports SBI pick-ticket exports (`Product ID`, `Location`, `Qty Alloc`, UPC …), tracks scanned vs ordered, prints labels. Flat-size lookup: 3″=16, 3.5″=12, 1QT=12, 4.5″=10, 6″=6, PRO #1=6.

---

# Handoff — production & propagation dashboard

Carried over from a claude.ai chat, then corrected against the repos on 2026-09-10.
Strike-throughs below are things the original handoff got wrong or left open.

## What exists

`production-dashboard/millcreek-production-propagation-dashboard.html`, one file,
inline CSS and JS, hand-written inline SVG in an `ART` object, Google Fonts `@import`
for DM Sans as the only external dependency. Responsive breakpoints at
1080 / 860 / 700 / 640 / 380 px.

**Design tokens:**
```
--paper #F4F2EE   --white #FFFFFF   --blush #EFDCD3   --blush-2 #E6C9BC
--forest #123932  --forest-2 #1D5147  --sage #DEE6DC
--ink #1D1E1B     --muted #807D75   --rust #B4522B   --amber #C08A2A
radius: 26 / 18 / 12 px, pills 999px
```
Warm off-white page, blush hero card, deep forest accent card, soft rounded white
cards, rust for the secondary value line.

**Sections, top to bottom:** header with live clock and the data-source chip → blush
hero → two side cards → 5-tile strip → lot grid with category filters, search and sort
→ task board with add-task → recipe panel with the grower log → Google Keep mirror →
season planner (back-calculator, month chart, crop plan table) → activity ticker.

**Data model** (the shapes are the contract; `MOCK_*` constants hold the fabricated
versions):

| Structure | Fields |
| --- | --- |
| `STAGES` | Stick, Callus, Rooting, Weaning, Pot-up, Grow-on, Ship-ready |
| `RECIPES` | keyed `R-05 … R-40`; `name media tray hormone stick water heat callus root wean feed pinch pgr potup note` |
| lots | `id pid crop cat size units cmt cell trays bench since daysOn losses lastTxn stage recipe strike vern flag finish source` — `cat` is `perennial\|herb\|grass\|annual`, `stage` indexes `STAGES` or is `null` when not logged |
| tasks | `id lot name status due late who keep` — `status` is `todo\|doing\|done` |
| `KEEP_LISTS` | `id title color extra[]` |
| season | 12 × `m plan act crops` (thousands), `CAPACITY = 40` |
| plan | `crop prog method target strike shrink cell prop grow ship vern pot` |

Constants: `BENCH_SQFT 36000`, `TRAY_SQFT 1.9`, `POT_SQFT 0.45`. Planner math:
```
toStick   = ceil(target / (strike/100) / (1 - shrink/100))
trays     = ceil(toStick / cell)
stickWk   = ship - grow - prop      (wrapped into 1..52)
potUpWk   = ship - grow
benchProp = trays * TRAY_SQFT
benchFin  = target * pot
```

## Decisions already made — don't undo without reason

1. Plant illustrations were removed from the lot cards in favour of a three-up stat
   block. They stay in the hero, the side cards and the category-filter thumbnails.
2. Mobile pass is done: segmented task board under 860px, stacked plan table under
   700px, 16px inputs on phones, 24–46px tap targets, safe-area insets.
3. The selected lot card is a lift plus a thin inset forest outline.
4. **`localStorage` is now allowed** (the no-storage rule only existed for the artifact
   sandbox). It holds the grower log, SBI-mode tasks and the last parsed import.
5. **The SBI side and the grower side are separate stores**, and the page never fills a
   grower field from SBI. "Not logged" is shown instead.
6. The SBI adapter lives inline in the HTML between `sbi-adapter:start/end` markers so
   the file stays self-contained; the test extracts it. Same pattern as
   `build-shared.js` / `shared-logic.js`.

## Work item 1 — SBI extraction: resolved, differently than expected

~~Extraction ladder: ask SBI for scheduled export → Playwright the export buttons →
replicate XHR calls.~~ None of that is needed. The STP repo already has:

- direct **read-only SQL** access to SBI's on-prem database over Windows auth,
  calling the same `sp_ExcelQuery_*` stored procedures SBI's own Export screen uses;
- exporters for point-in-time inventory (daily, with committed, back to 2024-09-12,
  optionally per location), the transaction log, sales detail and the forward order
  book;
- a scheduler that publishes CSVs to Drive on logon and reconnect, atomically, with a
  `_last-run.txt` staleness stamp.

So the raw-snapshot store the handoff wanted **already exists**: the Drive folders.
The adapter in this dashboard reads those files. Schema truth for it came from the
exporter scripts and STP's `Code.gs` parsers, and `production-dashboard/samples/`
carries synthetic files in those exact layouts. **Still worth doing:** drop one real
`Inventory_PIT_<date>.csv` exported `-ByLocation` into the page and check that the
lots it finds are the lots the growers would name. Then confirm the production
location codes (`0000` assumed, `LOST` ignored) against `-ListLocations`.

The scoping caveat stands and is now built in: SBI covers lot identity, counts,
locations, availability and demand. Recipes, strike rates, stage transitions and audit
results are grower knowledge and live in the grower log.

## Work item 2 — Google Keep: still open

Keep has no public API. The panel is a mirror with a fake sync, structured so the data
source can be swapped. Options in the order to try: **Google Tasks** (full API, same
list-of-checkable-items model), **a Google Sheet as the bridge**, **the Keep API** only
if our Workspace edition is an Enterprise tier that has it.

## Things nobody has confirmed — ask, don't assume

- ~~GitHub username~~ — it is `FarhadKBaloch`.
- ~~Which SBI screens the README covers~~ — see STP above; it covers stored-procedure
  exports, not screen automation.
- Our Google Workspace edition.
- Real greenhouse acreage, bench square footage, headcount and crop volumes. Every
  number in the mock is invented, and the spacing constants (`POT_SQFT` by size) are
  placeholders.
- Whether the real production location is `0000` alone, and which plug sizes the
  growers count as trays.

## Suggested next moves

1. Export one week of daily `-ByLocation` inventory from the VDI and load it. Fix
   whatever the real file breaks.
2. Move the grower log out of `localStorage` and into something the crew shares
   (a Sheet via Apps Script would match the rest of this repo).
3. Decide on Google Tasks vs a Sheet for the Keep panel.
4. Only then think about hosting the page (Apps Script `doGet`, as STP does).
