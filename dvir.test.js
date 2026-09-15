/**
 * Checks for dvir-notify.gs. No dependencies; run with `node dvir.test.js`.
 *
 * The script itself only ever runs inside Apps Script, so this loads it into a
 * VM sandbox with just enough of SpreadsheetApp, DriveApp, MailApp and friends
 * to exercise the logic that decides things: what a submission is allowed to
 * contain, which defects still count as open against a truck, and what closing
 * one out requires.
 *
 * The Google services are stubbed, not emulated. A passing run says the rules
 * are right; it does not say the deployment works — `healthCheck()` from the
 * spreadsheet menu is what says that.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- A fake spreadsheet ----------------------------------------------------
// Backed by a plain array of rows, addressed the way Apps Script addresses a
// sheet: 1-based, with row 1 the header.
function makeSheet(headers, data) {
  return {
    _h: headers, _d: data,
    getSheetId: () => 1,
    getName: () => 'Inspections',
    getLastRow: () => data.length + 1,
    getLastColumn: () => headers.length,
    getMaxRows: () => data.length + 10,
    setFrozenRows: () => {}, setColumnWidth: () => {},
    getConditionalFormatRules: () => [], setConditionalFormatRules: () => {},
    appendRow: (r) => { data.push(r); },
    getRange: (r, c, nr, nc) => ({
      getValue: () => (r === 1 ? headers[c - 1] : (data[r - 2] || [])[c - 1]),
      setValue: function (v) {
        if (r > 1) { data[r - 2] = data[r - 2] || []; data[r - 2][c - 1] = v; }
        return this;
      },
      getValues: () => {
        const out = [];
        for (let i = 0; i < (nr || 1); i++) {
          const src = (r + i === 1) ? headers : (data[r + i - 2] || []);
          out.push(src.slice(c - 1, c - 1 + (nc || 1)));
        }
        return out;
      },
      setValues: function () { return this; },
      setFontWeight: function () { return this; }, setBackground: function () { return this; },
      setFontColor: function () { return this; }, setFontSize: function () { return this; },
      setWrap: function () { return this; }, setDataValidation: function () { return this; },
      getSheet: () => ({ getName: () => 'Inspections' })
    })
  };
}

/** Load dvir-notify.gs into a sandbox and hand back its globals. */
function loadSandbox(opts) {
  opts = opts || {};
  const src = fs.readFileSync(path.join(__dirname, 'dvir-notify.gs'), 'utf8');
  const sandbox = { console, JSON, Math, Date, String, Number, Object, Array, isFinite, RegExp, Error, Set };

  let logSheet = null;
  const mails = [];
  const trucksTab = makeSheet(['Truck', 'Retired?'], opts.trucks ||
    [['Brutus', ''], ['Buckeye', ''], ['Benz', ''], ['Old Blue', 'yes']]);
  const folder = {
    getId: () => 'f1', getName: () => 'DVIR signatures',
    createFile: (b) => ({ getUrl: () => 'https://drive.google.com/file/' + b.n })
  };

  sandbox.SpreadsheetApp = {
    getActive: () => ({
      getSheetByName: (n) => (n === 'Inspections' ? logSheet : (n === 'Trucks' ? trucksTab : null)),
      getSheets: () => [logSheet],
      insertSheet: () => logSheet,
      getUrl: () => 'https://docs.google.com/spreadsheets/d/test',
      toast: () => {}
    }),
    flush: () => {},
    newDataValidation: () => ({
      requireValueInList: function () { return this; },
      setAllowInvalid: function () { return this; }, build: () => ({})
    }),
    newConditionalFormatRule: () => ({
      whenFormulaSatisfied: function () { return this; },
      setBackground: function () { return this; }, setFontColor: function () { return this; },
      setRanges: function () { return this; }, build: () => ({})
    }),
    getUi: () => ({ createMenu: () => ({ addItem: function () { return this; }, addToUi: () => {} }) })
  };
  sandbox.Session = {
    getScriptTimeZone: () => 'America/New_York',
    getActiveUser: () => ({ getEmail: () => opts.viewer || '' })
  };
  sandbox.Utilities = {
    formatDate: (d, tz, fmt) => {
      const iso = new Date(d).toISOString();
      if (fmt === 'yyyy-MM-dd') return iso.slice(0, 10);
      if (fmt === 'M/d/yyyy') { const p = iso.slice(0, 10).split('-'); return `${+p[1]}/${+p[2]}/${p[0]}`; }
      if (fmt === 'h:mm a') return iso.slice(11, 16);
      return iso.replace(/[-:T]/g, '').slice(0, 13);
    },
    base64Decode: (s) => Buffer.from(s, 'base64'),
    newBlob: (b, m, n) => ({ b, m, n })
  };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} })
  };
  // Always a miss, so every call re-reads the fake sheet and the tests see the
  // state they just wrote rather than a cached copy of an earlier one.
  sandbox.CacheService = { getScriptCache: () => ({ get: () => null, put: () => {} }) };
  sandbox.DriveApp = {
    getFolderById: () => { throw new Error('not reachable in tests'); },
    getFoldersByName: () => ({ hasNext: () => true, next: () => folder }),
    createFolder: () => folder
  };
  sandbox.MailApp = { sendEmail: (m) => mails.push(m), getRemainingDailyQuota: () => 100 };
  sandbox.ScriptApp = {
    getProjectTriggers: () => [{ getHandlerFunction: () => 'onInspectionEdit' }],
    newTrigger: () => ({
      forSpreadsheet: function () { return this; },
      onEdit: function () { return this; }, create: () => {}
    })
  };

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'dvir-notify.gs' });
  logSheet = makeSheet(sandbox.HEADERS.slice(), opts.rows || []);
  sandbox.__mails = mails;
  sandbox.__rows = () => logSheet._d;
  return sandbox;
}

// --- Harness ---------------------------------------------------------------
let pass = 0;
const failures = [];

function check(name, fn) {
  try { fn(); pass++; } catch (e) { failures.push(name + ' — ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function rejects(fn, fragment) {
  try { fn(); } catch (e) {
    assert(e.message.indexOf(fragment) !== -1,
      `expected a message containing "${fragment}", got "${e.message}"`);
    return;
  }
  throw new Error('expected it to be refused, but it went through');
}

const s = loadSandbox({});
const sig = { data: Buffer.from('a fake png').toString('base64') };
const COLS = {};
s.HEADERS.forEach((h, i) => { COLS[h] = i; });
const lastRow = () => s.__rows()[s.__rows().length - 1];

check('satisfactory report files', () => {
  const r = s.submitInspection({truck:'Brutus',type:'Pre-trip',driver:'R. Alvarez',odometer:'148320',satisfactory:true,signature:sig});
  assert(r.condition === 'Satisfactory' && r.defectCount === 0);
});
check('defect report files and emails the shop', () => {
  const before = s.__mails.length;
  const r = s.submitInspection({truck:'Brutus',type:'Post-trip',driver:'R. Alvarez',odometer:'148512',
    defects:[{key:'headlights',side:'R'}],remarks:'Right low beam out.',signature:sig});
  assert(r.defectCount === 1, 'count');
  assert(s.__mails.length === before + 1, 'no email sent');
});
check('a brake defect is flagged high importance', () => {
  s.submitInspection({truck:'Buckeye',type:'Pre-trip',driver:'J. Kim',odometer:'92010',
    defects:[{key:'parking-brake'}],remarks:'Will not hold on the ramp.',signature:sig});
  assert(s.__mails[s.__mails.length-1].importance === 'high');
});
check('the next driver is shown the open defect', () => {
  assert(s.getContext('Brutus').truckState.openDefects.length === 1);
});
check('a blank report is refused', () => rejects(() => s.submitInspection({truck:'Benz',type:'Pre-trip',driver:'A',signature:sig}), 'Either tap'));
check('defects plus satisfactory is refused', () => rejects(() => s.submitInspection({truck:'Benz',type:'Pre-trip',driver:'A',satisfactory:true,defects:[{key:'horn'}],remarks:'x',signature:sig}), 'cannot also be'));
check('a defect with no remarks is refused', () => rejects(() => s.submitInspection({truck:'Benz',type:'Pre-trip',driver:'A',defects:[{key:'horn'}],signature:sig}), 'Describe the defect'));
check('an unsigned report is refused', () => rejects(() => s.submitInspection({truck:'Benz',type:'Pre-trip',driver:'A',satisfactory:true}), 'Sign the report'));
check('an unknown truck is refused', () => rejects(() => s.submitInspection({truck:'Ghost',type:'Pre-trip',driver:'A',satisfactory:true,signature:sig}), 'not on the Trucks tab'));
check('a retired truck is refused', () => rejects(() => s.submitInspection({truck:'Old Blue',type:'Pre-trip',driver:'A',satisfactory:true,signature:sig}), 'not on the Trucks tab'));
check('a made-up item key is refused', () => rejects(() => s.submitInspection({truck:'Benz',type:'Pre-trip',driver:'A',defects:[{key:'evil'}],remarks:'x',signature:sig}), 'out of date'));
['__proto__','constructor','toString','hasOwnProperty'].forEach(key => {
  check('the prototype key "' + key + '" is refused', () =>
    rejects(() => s.submitInspection({truck:'Benz',type:'Pre-trip',driver:'A',defects:[{key:key}],remarks:'x',signature:sig}), 'out of date'));
});
check('an L/R item needs a side', () => rejects(() => s.submitInspection({truck:'Benz',type:'Pre-trip',driver:'A',defects:[{key:'mirrors'}],remarks:'x',signature:sig}), 'left or right'));
check('a non-numeric odometer is refused', () => rejects(() => s.submitInspection({truck:'Benz',type:'Pre-trip',driver:'A',odometer:'lots',satisfactory:true,signature:sig}), 'should be a number'));
check('double taps collapse to one defect', () => {
  const r = s.submitInspection({truck:'Benz',type:'Post-trip',driver:'T. Okafor',odometer:'61204',
    defects:[{key:'horn'},{key:'horn'},{key:'mirrors',side:'L'}],remarks:'Horn dead, left mirror loose.',signature:sig});
  assert(r.defectCount === 2, 'got ' + r.defectCount);
});
check('oversized text is capped, not fatal', () => {
  s.submitInspection({truck:'Benz',type:'Pre-trip',driver:'B'.repeat(500),odometer:'61250',
    defects:[{key:'windshield'}],remarks:'x'.repeat(20000),signature:sig});
  const row = lastRow();
  assert(row[COLS[s.COL.driver]].length === 100, 'driver not capped: ' + row[COLS[s.COL.driver]].length);
  assert(row[COLS[s.COL.remarks]].length === 5000, 'remarks not capped: ' + row[COLS[s.COL.remarks]].length);
});
check('a formula in a text field is neutralised', () => {
  s.submitInspection({truck:'Benz',type:'Post-trip',driver:'=IMPORTDATA("http://x")',odometer:'61300',
    defects:[{key:'windshield'}],remarks:'=1+1',signature:sig});
  const row = lastRow();
  assert(row[COLS[s.COL.driver]][0] === "'" && row[COLS[s.COL.remarks]][0] === "'");
});
check('report IDs increment and do not repeat', () => {
  const ids = s.__rows().map(r => r[COLS[s.COL.report]]);
  assert(new Set(ids).size === ids.length, 'duplicate report id');
  assert(ids[0] === 'DVIR-0001', 'first id ' + ids[0]);
});
check('certifying a repair clears the truck', () => {
  const open = s.getContext('Buckeye').truckState.openDefects;
  assert(open.length === 1, 'setup');
  s.certifyRepair({report: open[0].report, row: open[0].row, status:'Repaired', notes:'Adjusted the cable.', certifiedBy:'M. Toth'});
  assert(s.getContext('Buckeye').truckState.openDefects.length === 0, 'still open');
});
check('"no repair needed" needs a reason', () => rejects(() => s.certifyRepair({report:'DVIR-0001',status:'Repair not needed',certifiedBy:'M'}), 'Say why'));
check('an invented repair status is refused', () => rejects(() => s.certifyRepair({report:'DVIR-0001',status:'Probably fine',certifiedBy:'M'}), 'Certify it as either'));
check('certifying a vanished report is refused', () => rejects(() => s.certifyRepair({report:'DVIR-9999',status:'Repaired',certifiedBy:'M'}), 'not in the log'));
check('the certifier list is enforced when set', () => {
  const t = loadSandbox({});
  t.CONFIG.certifiers = ['shop@millcreek.example'];
  assert(t.canCertify_('') === false, 'anonymous');
  assert(t.canCertify_('nobody@millcreek.example') === false, 'stranger');
  assert(t.canCertify_('SHOP@millcreek.example') === true, 'case-insensitive match');
});
check('the fleet screen counts what is outstanding', () => {
  const f = s.getFleet();
  assert(f.fleet.length === 3, 'fleet size ' + f.fleet.length);
  assert(f.fleet.filter(x => x.truck === 'Brutus')[0].openDefects.length === 1, 'Brutus');
  assert(f.fleet.filter(x => x.truck === 'Buckeye')[0].openDefects.length === 0, 'Buckeye');
});
check('history searches and filters', () => {
  assert(s.getHistory({search:'low beam'}).total === 1, 'search');
  assert(s.getHistory({truck:'Brutus'}).total === 2, 'by truck');
  assert(s.getHistory({}).total === s.__rows().length, 'total');
});
check('the checklist matches the paper form', () => {
  const sec = s.sectionsForClient_();
  assert(sec.length === 4, 'sections');
  assert(sec.reduce((n,x) => n + x.items.length, 0) === 25, 'items');
  const sided = sec.reduce((a,x) => a.concat(x.items.filter(i => i.sides)), []);
  assert(sided.length === 7, 'L/R items: ' + sided.length);
});


check('health check reports only the placeholder addresses', () => {
  const out = s.healthCheck();
  assert(out.split('FIX').length - 1 === 1, 'unexpected failures:\n' + out);
  assert(out.indexOf('example.com') !== -1, 'expected the placeholder warning');
});

// --- Result ----------------------------------------------------------------
console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n' + failures.join('\n'));
  process.exit(1);
}
