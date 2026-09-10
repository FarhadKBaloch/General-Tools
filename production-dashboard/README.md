# Production & propagation dashboard

One self-contained HTML file for the propagation house: lots on the bench, the task
board, the recipe library, the Google Keep mirror and the season planner. It opens
from a double-click, needs no server, and runs on a phone.

It has two data modes, switched from the chip in the top bar:

| Mode | Where the numbers come from |
| --- | --- |
| **Mock data** | Fabricated, for design review. Every number is invented. |
| **SBI** | The CSV files the STP exporters publish to Google Drive, read in the browser. |

## Feeding it real data

SBI has no API on our plan, and none is needed: SBI's data sits in an on-premises SQL
Server, and the read-only PowerShell exporters in
[FarhadKBaloch/STP → `tools/`](https://github.com/FarhadKBaloch/STP/tree/main/tools)
already pull it to Drive on a schedule. This dashboard reads those files. Nothing
here writes back to SBI.

1. Export point-in-time inventory **by location**, one file per day, as CSV. This is
   the file that decides what a lot is:
   ```powershell
   .\Export-SBI-InventoryPIT.ps1 -ByLocation -AsCsv -Daily -Start 2026-06-01 -OutDir 'X:\STP\pit-loc'
   ```
   The default aggregated export also works, but it cannot separate `LOST` stock from
   `0000` production stock, and the page says so when it sees one.
2. Optionally add the weekly transaction log and the forward order book:
   ```powershell
   .\Export-SBI-TransactionLogs.ps1 -AsCsv -LastWeek
   .\Export-SBI-OrderAllocation.ps1 -AsCsv -NextWeeks 30
   ```
3. Open the dashboard, click the data chip, drop the files in. Files are recognised by
   their column headers, not their names, so a misfiled export is reported rather than
   mis-read. The parsed result is remembered in the browser; the raw files are not.

Load several days of inventory and the page measures **days on bench** from the first
snapshot each lot appears in and **units entering production** month by month from
day-over-day stock rises, which is the same rise ledger the STP crop model uses. One
day of snapshots gives you the lot list only.

## What SBI knows and what it does not

| From SBI (via the exports) | From the grower log (kept in this browser) |
| --- | --- |
| Which products are in production and where: stock in location `0000`, or in any plug/liner size (72, 105-O, 128, 50 …) | Stage (Stick → Ship-ready) |
| Units, committed, trays (units ÷ cells per tray) | Recipe |
| Days on bench, last rise, losses (`LOSS` + `DUMP` rows), last movement | Strike % from the last rooting audit |
| Demand: booked units, size and first ship week per product | Vernalization, finish, needs-attention flag, tasks |

The page never fills a grower field from SBI. A lot with no stage shows "stage not
logged" and the environment strip counts how many are missing, so the gap is visible
rather than papered over. The grower log is the first, smallest version of the store
the handoff calls for; moving it out of `localStorage` and into something shared
(a Sheet, an Apps Script store) is the obvious next step once the crew is using it.

Production location codes and the sizes that count as trays are data-driven, and the
defaults (`0000` for production, `LOST` ignored) match what the STP crop model excludes.
Both are options on `SBI.buildLots` if the real codes differ.

## Files

| File | What it is |
| --- | --- |
| `millcreek-production-propagation-dashboard.html` | The whole thing. The SBI adapter sits in its own `<script id="sbi-adapter">` block near the bottom, between `sbi-adapter:start` and `sbi-adapter:end` markers. |
| `sbi-adapter.test.js` | Checks for the adapter. Extracts the block from the HTML and runs it against the fixtures. `node sbi-adapter.test.js`, no dependencies. |
| `samples/` | Synthetic CSVs in the exact column layouts the STP exporters produce. **Every product, count and customer in them is invented.** They exist so the adapter can be tested without SBI access; drop them into the page to see the SBI mode. |

## Known limits

- Google Keep has no public API; the Keep panel is a faithful mirror with a fake sync.
  See the handoff in the repo root `CLAUDE.md` for the three real options.
- The environment strip shows sensor readings only in mock mode. No sensor feed exists.
- The month-by-month "planned" figures in the season chart are a draft plan, not from
  SBI; SBI holds no propagation plan. Booked demand from the order book fills the
  crop plan table's targets, but strike, shrink, cell count and prop/grow-on weeks
  start from default assumptions until the grower log says otherwise.
- Category (perennial / herb / grass / annual) comes from the SBI Category when an
  order-book file names the product, and from keywords in the description otherwise.
  Plug-size products rarely appear on orders, so most lots use the keyword route.
