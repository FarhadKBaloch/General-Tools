/**
 * Checks for the SBI export adapter that lives inline in
 * millcreek-production-propagation-dashboard.html (between the sbi-adapter markers).
 * No dependencies; run with `node sbi-adapter.test.js` from this folder.
 *
 * The fixtures in samples/ are synthetic but carry the exact column layouts the STP
 * exporters produce (FarhadKBaloch/STP → tools/), so a change to either side that
 * breaks the contract shows up here rather than on the page.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const here = __dirname;
const html = fs.readFileSync(path.join(here, 'millcreek-production-propagation-dashboard.html'), 'utf8');
const m = html.match(/<!-- sbi-adapter:start -->\s*<script id="sbi-adapter">([\s\S]*?)<\/script>/);
if (!m) { console.error('adapter block not found in the dashboard HTML'); process.exit(1); }
const sandbox = { module: { exports: {} } };
vm.runInNewContext(m[1], sandbox, { filename: 'sbi-adapter(inline).js' });
const SBI = sandbox.module.exports;

const read = n => ({ name: n, text: fs.readFileSync(path.join(here, 'samples', n), 'utf8') });
const all = fs.readdirSync(path.join(here, 'samples')).filter(f => f.endsWith('.csv'));
const daily = all.filter(f => !/aggregated/.test(f));

let pass = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) pass++;
  else failures.push(name + (detail !== undefined ? ' — got ' + JSON.stringify(detail) : ''));
}

// --- CSV ---------------------------------------------------------------------
{
  const rows = SBI.parseCsv('﻿"a","b, c","d ""q"""\r\n1,"multi\nline",3\r\n\r\n');
  check('csv: BOM stripped, quotes and embedded comma/newline handled', JSON.stringify(rows) === JSON.stringify([['a', 'b, c', 'd "q"'], ['1', 'multi\nline', '3']]), rows);
  check('csv: number cleanup', SBI.num('1,234') === 1234 && SBI.num('"$6.25"'.replace(/"/g, '')) === 6.25 && SBI.num('') === 0);
  check('csv: US and ISO dates', SBI.dayOf('9/8/2026 12:00:00 AM') === '2026-09-08' && SBI.dayOf('2026-09-08 00:00:00') === '2026-09-08');
  check('iso week', SBI.isoWeek('2027-04-06') === 14 && SBI.isoWeek('2026-01-01') === 1 && SBI.isoWeek('2026-12-31') === 53);
}

// --- classification ----------------------------------------------------------
{
  const kinds = {};
  all.forEach(n => { kinds[n] = SBI.classify(SBI.parseCsv(read(n).text)[0]); });
  check('classify: by-location PIT', kinds['Inventory_PIT_2026-09-08.csv'] === 'pit-loc', kinds);
  check('classify: aggregated PIT', kinds['Inventory_PIT_2026-09-08_aggregated.csv'] === 'pit-agg', kinds);
  check('classify: transaction log', kinds['Inventory_Transaction_Log_2026-08-31_to_2026-09-06.csv'] === 'txn', kinds);
  check('classify: order allocation', kinds['Order_Allocation_ByShipDate_2027-03-29_to_2027-04-18.csv'] === 'open', kinds);
  check('classify: unknown headers', SBI.classify(['Foo', 'Bar']) === 'unknown');
}

// --- sizes and categories ----------------------------------------------------
{
  const plug = { '72': 72, '105-O': 105, '128': 128, '50': 50, '288': 288, '38': 38 };
  const finished = ['#1', '3.5"', '1QT', 'Qt', '4.5"', 'PRO #1', 'Each', '6"', '3 INCH', '2 GAL', ''];
  check('cells per tray: plug sizes', Object.keys(plug).every(k => SBI.cellsPerTray(k) === plug[k]), Object.keys(plug).map(SBI.cellsPerTray));
  check('cells per tray: finished sizes are not trays', finished.every(s => SBI.cellsPerTray(s) === null), finished.map(SBI.cellsPerTray));
  check('category: SBI category wins', SBI.dashboardCat('Herbs', "Nepeta 'X'") === 'herb' && SBI.dashboardCat('Grasses', '') === 'grass' && SBI.dashboardCat('Annuals', '') === 'annual');
  check('category: description fallback', SBI.dashboardCat('', "Thymus 'German Winter'") === 'herb' && SBI.dashboardCat('', "Panicum virgatum 'Northwind'") === 'grass' && SBI.dashboardCat('', "Calibrachoa 'Superbells' stock") === 'annual' && SBI.dashboardCat('', "Heuchera 'Obsidian'") === 'perennial');
  check('plant categories', SBI.isPlantCategory('Perennials') && !SBI.isPlantCategory('Hard Goods') && !SBI.isPlantCategory('Discounts'));
}

// --- point-in-time parsing ---------------------------------------------------
{
  const s = SBI.parsePit(SBI.parseCsv(read('Inventory_PIT_2026-09-08.csv').text));
  check('pit: date read from the Date column', s.date === '2026-09-08', s.date);
  check('pit: by-location flag', s.byLocation === true);
  check('pit: catalog placeholder dropped', !s.rows.some(r => r.ready === 'CATALOG'));
  check('pit: 1,000,000-unit sentinel dropped', !s.rows.some(r => r.id === 'PACKBOX'));
  check('pit: row count', s.rows.length === 11, s.rows.length);
  const nep = s.rows.find(r => r.id === 'NEPCP72');
  check('pit: numbers', nep && nep.stock === 6824 && nep.cmt === 0 && nep.avl === 6824 && nep.loc === '0000' && nep.size === '72');
  const agg = SBI.parsePit(SBI.parseCsv(read('Inventory_PIT_2026-09-08_aggregated.csv').text));
  check('pit agg: off-crop columns read', agg.byLocation === false && agg.rows.find(r => r.id === 'NEPCP72').off === 6824);
}

// --- transaction log ---------------------------------------------------------
{
  const ev = SBI.parseTxn(SBI.parseCsv(read('Inventory_Transaction_Log_2026-08-31_to_2026-09-06.csv').text));
  check('txn: Update rows dropped', !ev.some(e => e.type === 'Update'));
  check('txn: sentinel recount dropped', !ev.some(e => e.id === 'PACKBOX'));
  const cnt = ev.find(e => e.type === 'COUNT');
  check('txn: COUNT is absolute, so its change is new minus old', cnt && cnt.qty === 276 - 300, cnt);
  check('txn: deltas kept as signed quantities', ev.find(e => e.id === 'NEPCP72').qty === -88 && ev.find(e => e.id === 'LAVMUN72').qty === 4320);
  check('txn: sorted by day', ev.every((e, i) => i === 0 || ev[i - 1].day <= e.day));
  check('txn: dates parsed from Export-Csv format', ev[0].day === '2026-08-31', ev[0].day);
}

// --- order book --------------------------------------------------------------
{
  const d = SBI.parseOpen(SBI.parseCsv(read('Order_Allocation_ByShipDate_2027-03-29_to_2027-04-18.csv').text));
  check('open: hard goods and completed lines excluded', !d.some(p => p.id === 'TRAY1020' || p.id === 'RUDGS1'), d.map(p => p.id));
  const nep = d.find(p => p.id === 'NEPCP1');
  check('open: lines summed per product across orders', nep && nep.ordered === 1500 && nep.alloc === 1500 && nep.orders === 2 && nep.customers === 2, nep);
  check('open: first ship date and ISO week', nep && nep.firstShip === '2027-04-06' && nep.shipWeek === 14, nep);
  const sal = d.find(p => p.id === 'SALCAR1');
  check('open: short = ordered minus allocated', sal && sal.short === 100, sal);
  check('open: category mapped', d.find(p => p.id === 'THYGW45').cat === 'herb' && d.find(p => p.id === 'PANNW1').cat === 'grass');
  check('open: sorted by ordered desc', d[0].id === 'NEPCP1');
}

// --- lots --------------------------------------------------------------------
{
  const r = SBI.ingest(daily.map(read));
  check('ingest: every file recognised', r.report.every(x => x.kind !== 'unknown' && x.kind !== 'error'), r.report);
  check('ingest: as-of is the latest snapshot', r.asOf === '2026-09-08' && r.snapshotDates.length === 3, r.snapshotDates);
  const ids = r.lots.map(l => l.id);
  check('lots: production location and plug sizes are lots', ['NEPCP72@0000', 'SALCAR72@0000', 'ECHMAG1@0000', 'LAVMUN72@0000', 'THYGW105@0000', 'HEUOBS50@B13', 'PANNW1@0000'].every(k => ids.includes(k)), ids);
  check('lots: sellable stock, LOST and sentinels are not lots', !ids.some(k => /RUDGS1|SEDAJQT|NEPCP1@|ROSARP72|PACKBOX/.test(k)), ids);
  check('lots: sorted by units', r.lots[0].id === 'NEPCP72@0000' && r.lots[0].units === 6824);
  const nep = r.lots.find(l => l.id === 'NEPCP72@0000');
  check('lots: trays from cell count', nep.cell === 72 && nep.trays === Math.ceil(6824 / 72), nep.trays);
  check('lots: on bench since the first snapshot it appears in', nep.since === '2026-09-06' && nep.daysOn === 2, [nep.since, nep.daysOn]);
  const lav = r.lots.find(l => l.id === 'LAVMUN72@0000');
  check('lots: a transfer-in in the log predates the first snapshot and becomes the stuck date', lav.since === '2026-09-03' && lav.daysOn === 5 && lav.lastRise === '2026-09-07', [lav.since, lav.daysOn, lav.lastRise]);
  check('lots: losses from LOSS + DUMP rows', nep.losses === 88 && r.lots.find(l => l.id === 'SALCAR72@0000').losses === 60);
  check('lots: last transaction carried', nep.lastTxn && nep.lastTxn.type === 'LOSS' && nep.lastTxn.reason === 'Rooting audit cull');
  check('lots: finished size in production has no trays', r.lots.find(l => l.id === 'ECHMAG1@0000').trays === 0);
  check('lots: category via description when the order book does not know the plug product', r.lots.find(l => l.id === 'THYGW105@0000').cat === 'herb' && r.lots.find(l => l.id === 'PANNW1@0000').cat === 'grass');
  check('lots: grower fields left null, never invented', r.lots.every(l => l.stage === null && l.recipe === null && l.strike === null));
  check('summary', r.summary.units === 28276 && r.summary.trays === 313 && r.summary.losses === 148 && r.summary.byLocation === true, r.summary);
  // season actuals: rises are the two lots that entered production on the 7th and 8th
  check('season: month of rises', r.season.unitsByMonth[8] === 4320 + 4200 && r.season.months[8] === 8.5, r.season);
  check('season: coverage is daily', r.season.coverage.daily === true && r.season.coverage.snapshots === 3, r.season.coverage);
}

// --- aggregated-only path ----------------------------------------------------
{
  const r = SBI.ingest([read('Inventory_PIT_2026-09-08_aggregated.csv')]);
  const ids = r.lots.map(l => l.id);
  check('agg: same seven lots from the aggregated file', ids.length === 7 && !ids.includes('ROSARP72'), ids);
  check('agg: units come from the off-crop column for production locations', r.lots.find(l => l.id === 'NEPCP72').units === 6824);
  check('agg: no rise history with one snapshot', r.season.coverage.snapshots === 1 && r.season.months.every(v => v === 0));
}

// --- edge cases --------------------------------------------------------------
{
  const r = SBI.ingest([{ name: 'random.csv', text: 'Foo,Bar\n1,2\n' }, { name: 'empty.csv', text: 'Product ID,In Stock\n' }]);
  check('edge: unknown and empty files reported, nothing built', r.lots.length === 0 && r.asOf === '' && r.report.length === 2 && r.report[0].kind === 'unknown' && r.report[1].kind === 'empty', r.report);
  const undated = SBI.ingest([{ name: 'Inventory_PIT_2026-01-01.csv', text: 'Product ID,Description,Size,Location,Ready,In Stock,Committed,Available\nX,Test,72,0000,PROD,144,0,144\n' }]);
  check('edge: date falls back to the file name', undated.asOf === '2026-01-01' && undated.lots.length === 1 && undated.lots[0].trays === 2, undated);
  const custom = SBI.buildLots([SBI.parsePit(SBI.parseCsv(read('Inventory_PIT_2026-09-08.csv').text))], [], [], { productionLocations: ['0000', 'B13'], ignoreLocations: ['LOST'] });
  check('edge: production locations are configurable', custom.lots.some(l => l.id === 'HEUOBS50@B13' && l.inProductionLocation));
}

console.log(pass + ' checks passed' + (failures.length ? ', ' + failures.length + ' failed' : ''));
failures.forEach(f => console.log('  FAIL ' + f));
process.exit(failures.length ? 1 : 0);
