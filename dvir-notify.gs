/**
 * dvir-notify.gs — Google Apps Script for the Millcreek Trucking driver
 * vehicle inspection report (DVIR).
 *
 * This is the paper "PRE-TRIP INSPECTION" sheet turned into something a driver
 * fills in on a phone: they scan the QR sticker on the truck they are taking
 * out, tap any item that is defective, sign, and submit. Everything lands in
 * one spreadsheet, and anything with a defect on it emails the shop.
 *
 * SETUP
 *   1. Make a new Google Sheet (this is the log — it does not need a Form).
 *   2. Extensions -> Apps Script, delete the stub, paste this file in.
 *   3. Add an HTML file named exactly "webapp" and paste dvir-webapp.html in.
 *   4. Edit CONFIG below — at minimum the email addresses.
 *   5. Run setUp() once and accept the permission prompt.
 *   6. Deploy -> New deployment -> Web app.
 *   7. Print the QR stickers with equipment-qr-labels.html (see DVIR.md).
 *
 * There is no server and no cost: it runs on Google's infrastructure, attached
 * to the spreadsheet.
 *
 * Keep this in its own Apps Script project, separate from the nursery's
 * equipment maintenance log. Two doGet() functions cannot live in one project,
 * and the two logs have different readers anyway.
 */

// ===========================================================================
// CONFIG — this is the only section you need to edit.
// ===========================================================================
var CONFIG = {

  companyName: 'Millcreek Trucking, LLC',

  // Emailed whenever a driver submits a report with a defect on it.
  shopLead: 'shop.lead@example.com',
  owner: 'owner@example.com',

  // Also emailed, but only for the items in alertItems below. Leave blank to
  // send those to the same two people as everything else.
  safetyContact: '',

  // The starting fleet. setUp copies this into a "Trucks" tab and FROM THEN ON
  // THE TAB IS THE SOURCE OF TRUTH. Adding the spring trucks is a matter of
  // typing them on that tab and printing stickers — no code edit, no redeploy.
  // This list is only the seed, and the fallback if the tab is deleted.
  trucks: ['Brutus', 'Buckeye', 'Benz'],

  // The inspection itself, exactly as it reads on the paper form. Sections are
  // shown in this order and items within them in this order.
  //
  //   sides: true  -> the item is inspected left and right separately, and the
  //                   app shows an L and an R button instead of one checkbox.
  //                   This is the "L | R" column on the paper sheet.
  //
  // Editing this list changes the form on the next page load. Renaming an item
  // does not rewrite old reports: history keeps the wording that was on screen
  // when the driver signed it, which is the point of a signed record.
  sections: [
    {
      name: 'Front / Engine Compartment',
      items: [
        { label: 'Oil level' },
        { label: 'Windshield fluid reservoir' },
        { label: 'Engine coolant reservoir' },
        { label: 'Obvious fluid leaks' },
        { label: 'Belts / hoses' },
        { label: 'Steer tires, wheels, lugs and signs of oil leakage', sides: true },
        { label: 'Headlights', sides: true },
        { label: 'Turn signals', sides: true },
        { label: 'Marker lights', sides: true }
      ]
    },
    {
      name: 'Cargo Box Side(s)',
      items: [
        { label: 'ABS light' },
        { label: 'Marker lights / reflective tape' },
        { label: 'Tires, wheels, mudflaps' }
      ]
    },
    {
      name: 'Cargo Box Rear',
      items: [
        { label: 'Reflective tape' },
        { label: 'Doors work and latch properly' },
        { label: 'Liftgate operational' },
        { label: 'Lights', sides: true }
      ]
    },
    {
      name: 'In Cab Check',
      items: [
        { label: 'Horn' },
        { label: 'Defroster / heater / AC' },
        { label: 'Steering' },
        { label: 'Parking brake' },
        { label: 'Service brakes / ABS light (ST only)' },
        { label: 'Emergency equipment' },
        { label: 'Windshield / wipers', sides: true },
        { label: 'Mirrors', sides: true },
        { label: 'Windshield' }
      ]
    }
  ],

  // Defects on these items flag the email as high importance and put a marker
  // in the subject line, so a bad brake does not arrive looking like a low
  // washer bottle. Match the labels above exactly.
  //
  // This is a "somebody look at this before it moves" prompt and nothing more.
  // It is not an out-of-service determination — that is a judgement call for a
  // person, not a list in a config file.
  alertItems: [
    'Service brakes / ABS light (ST only)',
    'Parking brake',
    'Steering',
    'Steer tires, wheels, lugs and signs of oil leakage',
    'Tires, wheels, mudflaps',
    'ABS light'
  ],

  // Who may mark a defect repaired. Empty list = anyone who can open the app,
  // which is the right setting for a small shop where everyone is trusted and
  // the record of who signed it is enough. Put addresses here to lock it down;
  // that only works if the deployment's access is restricted to your domain,
  // because Google does not tell the script who anonymous viewers are.
  certifiers: [],

  // Signatures are drawn on the phone and saved as PNGs in this Drive folder.
  // Pin a folder by ID (the last part of its URL) or leave the ID blank to
  // find-or-create one by name. The account that runs the web app must be able
  // to write to it.
  signatureFolderId: '',
  signatureFolder: 'DVIR signatures',

  // Work email domain. When a driver opens the app signed in with an address in
  // this domain their name fills itself in and the report records who they were
  // signed in as. Leave blank to accept any signed-in address.
  //
  // Google only tells the script who the viewer is when the web app's access is
  // restricted to your organisation. Deployed as "Anyone", every viewer is
  // anonymous and the driver types their name instead.
  workEmailDomain: '',

  // Prefix for generated report IDs, e.g. DVIR-0042.
  reportPrefix: 'DVIR',

  // Set false if you would rather not be emailed when a defect is certified
  // repaired.
  notifyOnRepair: true,

  // How many past reports the History tab loads at a time.
  historyPageSize: 25,

  // Federal rules require a DVIR and its certification of repairs to be kept
  // for three months. Shown in the app so nobody deletes rows early; nothing
  // is ever removed automatically.
  retentionMonths: 3,

  // A truck with no inspection in this many hours is called out on the Fleet
  // screen. Set 0 to turn that off.
  staleAfterHours: 36
};

// ===========================================================================
// Sheet layout
// ===========================================================================

var LOG_TAB = 'Inspections';
var TRUCKS_TAB = 'Trucks';

var COL = {
  timestamp: 'Timestamp',
  report: 'Report',
  truck: 'Truck',
  type: 'Type',
  date: 'Date',
  time: 'Time',
  driver: 'Driver',
  driverEmail: 'Driver email',
  odometer: 'Odometer',
  condition: 'Condition',
  defectCount: 'Defects',
  defectList: 'Defect list',
  remarks: 'Remarks',
  signature: 'Signature',
  repairStatus: 'Repair status',
  repairNotes: 'Repair notes',
  certifiedBy: 'Certified by',
  certifiedOn: 'Certified on',
  reviewed: 'Prior report reviewed',
  items: 'Items (JSON)'
};

// The header row, left to right.
var HEADERS = [
  COL.timestamp, COL.report, COL.truck, COL.type, COL.date, COL.time,
  COL.driver, COL.driverEmail, COL.odometer, COL.condition, COL.defectCount,
  COL.defectList, COL.remarks, COL.signature, COL.repairStatus,
  COL.repairNotes, COL.certifiedBy, COL.certifiedOn, COL.reviewed, COL.items
];

var TYPE_PRE = 'Pre-trip';
var TYPE_POST = 'Post-trip';
var TYPES = [TYPE_PRE, TYPE_POST];

var CONDITION_OK = 'Satisfactory';
var CONDITION_DEFECT = 'Defects noted';

// Repair status. Only NEEDS_REPAIR holds a truck's defect open; the last two
// are the two ways federal rules let a carrier close one out.
var REPAIR_NONE = 'No defects';
var REPAIR_NEEDED = 'Needs repair';
var REPAIR_DONE = 'Repaired';
var REPAIR_NOT_NEEDED = 'Repair not needed';
var REPAIR_OPTIONS = [REPAIR_NONE, REPAIR_NEEDED, REPAIR_DONE, REPAIR_NOT_NEEDED];

// ===========================================================================
// One-time setup
// ===========================================================================

/**
 * Run this once, from the Apps Script editor, after pasting the file in.
 * Safe to run again: it will not duplicate tabs, columns or triggers.
 */
function setUp() {
  buildTrucksTab_();
  var sheet = logSheet_();
  applyReadableFormatting_(sheet);
  installTriggers_();
  SpreadsheetApp.getActive().toast(
    'Inspection log is set up. Deploy the web app next, then print the stickers.'
  );
}

/**
 * The log tab, created on first use.
 *
 * Unlike the nursery's maintenance log this is not fed by a Google Form, so
 * there is no linked responses sheet to find — the web app is the form. That
 * means the script owns the header row outright and can rely on it.
 */
function logSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(LOG_TAB);

  if (!sheet) {
    // A brand new spreadsheet arrives with one empty "Sheet1". Rename it
    // rather than leaving an orphan tab next to the log.
    var sheets = ss.getSheets();
    if (sheets.length === 1 && sheets[0].getLastRow() === 0) {
      sheet = sheets[0].setName(LOG_TAB);
    } else {
      sheet = ss.insertSheet(LOG_TAB);
    }
  }

  var existing = headerRow_(sheet);
  if (!existing.length) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    forgetHeaders_();
    return sheet;
  }

  // Append anything missing rather than rewriting the row, so a log that was
  // set up under an older version of this file keeps its data in place.
  var added = false;
  HEADERS.forEach(function (name) {
    if (existing.indexOf(name) !== -1) return;
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue(name).setFontWeight('bold');
    existing.push(name);
    added = true;
  });
  if (added) forgetHeaders_();
  return sheet;
}

/** Create the Trucks tab on first run, seeded from CONFIG. Never overwrites. */
function buildTrucksTab_() {
  var ss = SpreadsheetApp.getActive();
  var tab = ss.getSheetByName(TRUCKS_TAB);
  if (tab) return;   // already yours to edit — leave it alone

  tab = ss.insertSheet(TRUCKS_TAB);
  tab.getRange('A1').setValue('Truck').setFontWeight('bold').setBackground('#e8efe9');
  tab.getRange('B1').setValue('Retired?').setFontWeight('bold').setBackground('#e8efe9');
  tab.getRange('C1').setValue(
    'One truck per row, named exactly as it is on the QR sticker. The app reads ' +
    'this list every time it loads, so adding the spring trucks here needs no ' +
    'redeploy. Put any word in "Retired?" to take a truck out of the list ' +
    'without losing its history.'
  ).setFontColor('#6b7472').setFontSize(9);

  var seed = (CONFIG.trucks || []).map(function (name) { return [name, '']; });
  if (seed.length) tab.getRange(2, 1, seed.length, 2).setValues(seed);
  tab.setColumnWidth(1, 180);
  tab.setColumnWidth(2, 90);
  tab.setFrozenRows(1);
}

var TRUCK_CACHE = null;

/**
 * The trucks the app offers, read from the Trucks tab.
 *
 * Kept in the spreadsheet rather than in this file on purpose: the fleet grows
 * every spring, and needing a code edit and a redeploy for that is how an app
 * ends up offering last year's trucks. Editing the tab takes effect on the
 * next page load.
 *
 * Falls back to CONFIG.trucks if the tab is missing or empty, so nothing
 * breaks if someone deletes it.
 */
function truckList_() {
  if (TRUCK_CACHE) return TRUCK_CACHE;

  var names = [];
  var tab = SpreadsheetApp.getActive().getSheetByName(TRUCKS_TAB);
  var lastRow = tab ? tab.getLastRow() : 0;
  if (lastRow > 1) {
    tab.getRange(2, 1, lastRow - 1, 2).getValues().forEach(function (row) {
      var name = String(row[0] == null ? '' : row[0]).trim();
      var retired = String(row[1] == null ? '' : row[1]).trim();
      if (name && !retired && names.indexOf(name) === -1) names.push(name);
    });
  }
  if (!names.length) names = (CONFIG.trucks || []).slice();

  TRUCK_CACHE = names;
  return names;
}

/**
 * Widths, wrapping and colour, so the log can be skimmed in the spreadsheet
 * without reading any of it. A row with a defect on it should be visible from
 * across the room; a satisfactory row should be quiet.
 */
function applyReadableFormatting_(sheet) {
  var headers = headerRow_(sheet);
  var lastRow = Math.max(sheet.getMaxRows(), 2);

  var widths = {};
  widths[COL.timestamp] = 140;
  widths[COL.report] = 90;
  widths[COL.truck] = 100;
  widths[COL.type] = 90;
  widths[COL.date] = 90;
  widths[COL.time] = 80;
  widths[COL.driver] = 140;
  widths[COL.driverEmail] = 60;
  widths[COL.odometer] = 90;
  widths[COL.condition] = 110;
  widths[COL.defectCount] = 70;
  widths[COL.defectList] = 320;
  widths[COL.remarks] = 280;
  widths[COL.signature] = 90;
  widths[COL.repairStatus] = 120;
  widths[COL.repairNotes] = 220;
  widths[COL.certifiedBy] = 140;
  widths[COL.certifiedOn] = 120;
  widths[COL.reviewed] = 90;
  widths[COL.items] = 60;   // machine-readable backup, not for reading

  headers.forEach(function (name, i) {
    if (widths[name]) sheet.setColumnWidth(i + 1, widths[name]);
  });

  [COL.defectList, COL.remarks, COL.repairNotes].forEach(function (name) {
    var i = headers.indexOf(name);
    if (i !== -1) sheet.getRange(2, i + 1, lastRow - 1, 1).setWrap(true);
  });

  var repairCol = headers.indexOf(COL.repairStatus);
  if (repairCol !== -1) {
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(REPAIR_OPTIONS, true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, repairCol + 1, lastRow - 1, 1).setDataValidation(rule);
  }

  applyRowColours_(sheet, headers, lastRow);
  sheet.setFrozenRows(1);
}

/**
 * Colour whole rows by repair status rather than colouring one cell, because
 * the column that matters is off the right-hand edge of the screen on a
 * laptop and nobody scrolls to it.
 */
function applyRowColours_(sheet, headers, lastRow) {
  var repairCol = headers.indexOf(COL.repairStatus);
  if (repairCol === -1) return;

  var range = sheet.getRange(2, 1, lastRow - 1, headers.length);
  var ref = '$' + columnLetter_(repairCol + 1) + '2';

  var rules = sheet.getConditionalFormatRules().filter(function (rule) {
    // Drop only our own rules, so anything added by hand survives a re-run.
    var ranges = rule.getRanges();
    return !ranges.some(function (r) { return r.getSheet().getName() === LOG_TAB; });
  });

  var paint = [
    [REPAIR_NEEDED, '#fbe3df', '#8e2a1c'],
    [REPAIR_DONE, '#e6f3ec', '#1e4a33'],
    [REPAIR_NOT_NEEDED, '#eef1ee', '#3d4642']
  ];
  paint.forEach(function (spec) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=' + ref + '="' + spec[0] + '"')
      .setBackground(spec[1])
      .setFontColor(spec[2])
      .setRanges([range])
      .build());
  });
  sheet.setConditionalFormatRules(rules);
}

/** A1-style column letter for a 1-based index. */
function columnLetter_(index) {
  var letter = '';
  while (index > 0) {
    var rem = (index - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    index = Math.floor((index - rem) / 26);
  }
  return letter;
}

/** Watch for repair statuses changed by hand in the sheet rather than the app. */
function installTriggers_() {
  var ss = SpreadsheetApp.getActive();
  var wanted = 'onInspectionEdit';
  var already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === wanted;
  });
  if (already) return;
  ScriptApp.newTrigger(wanted).forSpreadsheet(ss).onEdit().create();
}

// ===========================================================================
// Small sheet helpers
// ===========================================================================

var HEADER_CACHE = {};

function headerRow_(sheet) {
  var key = sheet.getSheetId();
  if (HEADER_CACHE[key]) return HEADER_CACHE[key];
  var width = sheet.getLastColumn();
  if (!width) return [];
  var row = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (v) {
    return String(v == null ? '' : v).trim();
  });
  HEADER_CACHE[key] = row;
  return row;
}

function forgetHeaders_() { HEADER_CACHE = {}; }

/**
 * Run `fn` with the script lock held, so two drivers submitting in the same
 * second cannot read the same last report ID and both use it.
 *
 * If the lock cannot be taken in time the work still runs. Two reports sharing
 * an ID is untidy; refusing a driver's inspection because a lock was busy —
 * at 5am, in a yard, on one bar of signal — would be worse.
 */
function withLock_(fn) {
  var lock = null;
  var held = false;
  try {
    lock = LockService.getScriptLock();
    held = lock.tryLock(30000);
  } catch (err) {
    held = false;
  }
  try {
    return fn();
  } finally {
    if (held) {
      SpreadsheetApp.flush();   // commit before anyone else can read
      lock.releaseLock();
    }
  }
}

/**
 * Keep a typed-in value from acting as a spreadsheet formula.
 *
 * Remarks of "=IMPORTDATA(...)" would run as a live formula the moment someone
 * opened the sheet — a way to pull other cells out to an outside URL. Leading
 * a suspect value with an apostrophe forces the cell to stay text. The app
 * shows every value as escaped text already, so this is only for the sheet.
 */
function plainText_(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

/**
 * Trim a typed-in value to something a spreadsheet cell can hold.
 *
 * Nobody types five thousand characters of remarks on a phone. A payload that
 * does is either a paste accident or somebody poking at the endpoint, and
 * either way the report should still file rather than failing on the write.
 */
function capped_(value, max) {
  var s = String(value == null ? '' : value).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** Next report ID, e.g. DVIR-0042. */
function nextReportId_(sheet) {
  var prefix = CONFIG.reportPrefix || 'DVIR';
  var headers = headerRow_(sheet);
  var col = headers.indexOf(COL.report) + 1;
  var lastRow = sheet.getLastRow();
  var highest = 0;

  if (col && lastRow > 1) {
    sheet.getRange(2, col, lastRow - 1, 1).getValues().forEach(function (row) {
      var match = /(\d+)\s*$/.exec(String(row[0] == null ? '' : row[0]));
      if (match) highest = Math.max(highest, parseInt(match[1], 10));
    });
  }
  var next = String(highest + 1);
  while (next.length < 4) next = '0' + next;
  return prefix + '-' + next;
}

/** The signed-in viewer, or '' when anonymous or signed in personally. */
function viewerEmail_() {
  var email = '';
  try {
    email = String(Session.getActiveUser().getEmail() || '').trim();
  } catch (err) {
    return '';
  }
  if (!email) return '';

  var domain = String(CONFIG.workEmailDomain || '').trim().toLowerCase();
  if (domain && email.toLowerCase().slice(-(domain.length + 1)) !== '@' + domain) {
    return '';   // signed in, but with a personal account
  }
  return email;
}

function tz_() { return Session.getScriptTimeZone(); }

function formatDate_(value) {
  if (!(value instanceof Date)) return String(value == null ? '' : value);
  return Utilities.formatDate(value, tz_(), 'M/d/yyyy');
}

function formatTime_(value) {
  if (!(value instanceof Date)) return String(value == null ? '' : value);
  return Utilities.formatDate(value, tz_(), 'h:mm a');
}

function asTime_(value) {
  if (value instanceof Date) return value.getTime();
  var parsed = new Date(value);
  return isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

var HOUR_MS = 60 * 60 * 1000;

// ===========================================================================
// Reading the log
// ===========================================================================

/**
 * Every row of the log, parsed once, newest first.
 *
 * The fleet screen, the history screen and the carry-forward check all need
 * the whole log, and reading the sheet cell by cell is the usual reason an
 * Apps Script web app feels slow. One getValues() call, one pass, shared by
 * everything below, cached between requests.
 */
function snapshot_() {
  var cached = cacheGet_('snapshot');
  if (cached) return cached;

  var sheet = logSheet_();
  var headers = headerRow_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2 || !headers.length) return { reports: [] };

  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var at = {};
  headers.forEach(function (h, i) { at[h] = i; });

  var get = function (row, name) {
    return has_(at, name) ? row[at[name]] : '';
  };

  var reports = [];
  values.forEach(function (row, i) {
    var report = String(get(row, COL.report) || '').trim();
    var truck = String(get(row, COL.truck) || '').trim();
    if (!report && !truck) return;   // blank spacer row, ignore

    var defectList = String(get(row, COL.defectList) || '').trim();
    reports.push({
      row: i + 2,
      report: report,
      truck: truck,
      type: String(get(row, COL.type) || '').trim(),
      when: asTime_(get(row, COL.timestamp)),
      date: formatDate_(get(row, COL.date)),
      time: String(get(row, COL.time) || '').trim(),
      driver: String(get(row, COL.driver) || '').trim(),
      odometer: String(get(row, COL.odometer) == null ? '' : get(row, COL.odometer)).trim(),
      condition: String(get(row, COL.condition) || '').trim(),
      defectCount: Number(get(row, COL.defectCount)) || 0,
      defects: defectList ? defectList.split('\n').filter(Boolean) : [],
      remarks: String(get(row, COL.remarks) || '').trim(),
      signature: String(get(row, COL.signature) || '').trim(),
      repairStatus: String(get(row, COL.repairStatus) || '').trim(),
      repairNotes: String(get(row, COL.repairNotes) || '').trim(),
      certifiedBy: String(get(row, COL.certifiedBy) || '').trim(),
      certifiedOn: formatDate_(get(row, COL.certifiedOn))
    });
  });

  reports.sort(function (a, b) { return b.when - a.when; });

  var result = { reports: reports };
  cachePut_('snapshot', result, 300);
  return result;
}

/**
 * Cache keys carry a generation number that every write bumps, so a stale
 * snapshot can never outlive the submission that invalidated it. Without this
 * a driver would submit, and the next screen would still show the old state
 * for up to five minutes — which looks exactly like a lost report.
 */
var GENERATION = null;

function cacheGeneration_() {
  if (GENERATION !== null) return GENERATION;
  try {
    var props = PropertiesService.getScriptProperties();
    GENERATION = Number(props.getProperty('generation')) || 1;
  } catch (err) {
    GENERATION = 1;
  }
  return GENERATION;
}

function bumpGeneration_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var next = (Number(props.getProperty('generation')) || 1) + 1;
    props.setProperty('generation', String(next));
    GENERATION = next;
  } catch (err) {
    GENERATION = null;   // unknown now, so the next read re-derives it
  }
}

function cacheGet_(name) {
  try {
    var raw = CacheService.getScriptCache().get(name + ':' + cacheGeneration_());
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function cachePut_(name, value, seconds) {
  try {
    CacheService.getScriptCache()
      .put(name + ':' + cacheGeneration_(), JSON.stringify(value), seconds);
  } catch (err) {
    // A payload over the cache's size limit is not worth failing a page load
    // for; it just means the next request reads the sheet again.
  }
}

/**
 * Reports that still hold a defect open against a truck.
 *
 * "Open" means a driver wrote a defect down and nobody has yet certified that
 * it was fixed or that it did not need fixing. Those are the ones the next
 * driver has to be shown before they take the truck out.
 */
function openDefectsFor_(truck, reports) {
  return reports.filter(function (r) {
    return r.truck === truck &&
      r.condition === CONDITION_DEFECT &&
      r.repairStatus !== REPAIR_DONE &&
      r.repairStatus !== REPAIR_NOT_NEEDED;
  });
}

// ===========================================================================
// Web app
//
// Deploy -> New deployment -> Web app. Google hosts it for free. The URL it
// gives you is what the QR stickers point at.
// ===========================================================================

/**
 * Serves the driver page. Requires an HTML file named "webapp" in this project.
 *
 * The sticker on each truck carries ?truck=<name>. The page runs in a sandboxed
 * iframe and cannot see the address bar, so the value is read here and baked
 * into the markup for the app to pick up.
 */
function doGet(e) {
  var template = HtmlService.createTemplateFromFile('webapp');
  var asked = (e && e.parameter && e.parameter.truck) || '';

  // Only accept a truck we actually know about, so a doctored link cannot put
  // arbitrary text on the screen. An unknown name falls through to the picker.
  template.scannedTruck = truckList_().indexOf(asked) === -1 ? '' : asked;
  template.companyName = CONFIG.companyName || 'Driver vehicle inspection';

  return template.evaluate()
    .setTitle((CONFIG.companyName || 'Fleet') + ' — Vehicle Inspection')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Everything the app needs on load: the checklist, the fleet, and — for the
 * truck that was scanned — what the last driver left behind.
 *
 * Sent in one call rather than three. On a phone in a yard the round trip is
 * the expensive part, not the work at either end.
 */
function getContext(truck) {
  var trucks = truckList_();
  truck = String(truck || '').trim();
  if (trucks.indexOf(truck) === -1) truck = '';

  var data = snapshot_();
  var viewer = viewerEmail_();

  return {
    companyName: CONFIG.companyName || '',
    trucks: trucks,
    sections: sectionsForClient_(),
    types: TYPES,
    truck: truck,
    viewerEmail: viewer,
    canCertify: canCertify_(viewer),
    retentionMonths: CONFIG.retentionMonths || 0,
    truckState: truck ? truckState_(truck, data.reports) : null
  };
}

/**
 * The checklist, flattened for the client with a stable key per item.
 *
 * The key is what a submission sends back and what history is matched on, so
 * it is derived from the label and never from the item's position: inserting a
 * new item in the middle of a section must not silently re-point every defect
 * recorded after it.
 */
function sectionsForClient_() {
  return (CONFIG.sections || []).map(function (section) {
    return {
      name: String(section.name || ''),
      items: (section.items || []).map(function (item) {
        return {
          key: itemKey_(item.label),
          label: String(item.label || ''),
          sides: item.sides === true,
          alert: isAlertItem_(item.label)
        };
      })
    };
  });
}

function itemKey_(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isAlertItem_(label) {
  var wanted = String(label || '').trim().toLowerCase();
  return (CONFIG.alertItems || []).some(function (name) {
    return String(name).trim().toLowerCase() === wanted;
  });
}

/**
 * Is `key` genuinely a key of this object, rather than something inherited?
 *
 * A submitted item key of "__proto__" or "toString" finds a live value on
 * Object.prototype, which reads as "yes, that is a known checklist item" and
 * writes a defect with an undefined label into the log. Ask for own properties
 * only, so the answer is about the checklist and not about JavaScript.
 */
function has_(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Every known item, keyed, so a submitted defect can be checked against it. */
function itemIndex_() {
  var index = {};
  (CONFIG.sections || []).forEach(function (section) {
    (section.items || []).forEach(function (item) {
      index[itemKey_(item.label)] = {
        section: String(section.name || ''),
        label: String(item.label || ''),
        sides: item.sides === true,
        alert: isAlertItem_(item.label)
      };
    });
  });
  return index;
}

function canCertify_(email) {
  var allowed = CONFIG.certifiers || [];
  if (!allowed.length) return true;    // small shop, everyone trusted
  if (!email) return false;
  var lower = String(email).toLowerCase();
  return allowed.some(function (a) { return String(a).toLowerCase() === lower; });
}

/** What a driver needs to know about one truck before they take it out. */
function truckState_(truck, reports) {
  var mine = reports.filter(function (r) { return r.truck === truck; });
  var open = openDefectsFor_(truck, reports);
  var last = mine[0] || null;

  // The odometer to pre-fill from, and to compare against. A post-trip reading
  // is the freshest number for the truck even when a pre-trip is newer on the
  // clock, so take whichever report is most recent and has a number on it.
  var lastOdometer = '';
  for (var i = 0; i < mine.length; i++) {
    if (mine[i].odometer !== '') { lastOdometer = mine[i].odometer; break; }
  }

  return {
    truck: truck,
    lastReport: last,
    lastOdometer: lastOdometer,
    openDefects: open.map(function (r) {
      return {
        report: r.report, date: r.date, time: r.time, driver: r.driver,
        type: r.type, defects: r.defects, remarks: r.remarks,
        repairStatus: r.repairStatus || REPAIR_NEEDED, row: r.row
      };
    }),
    today: mine.filter(function (r) { return sameDay_(r.when, Date.now()); })
      .map(function (r) {
        return { report: r.report, type: r.type, time: r.time, driver: r.driver,
                 condition: r.condition };
      })
  };
}

function sameDay_(a, b) {
  if (!a || !b) return false;
  var fmt = function (t) { return Utilities.formatDate(new Date(t), tz_(), 'yyyy-MM-dd'); };
  return fmt(a) === fmt(b);
}

// ===========================================================================
// Submitting an inspection
// ===========================================================================

/**
 * File one inspection.
 *
 * Everything the driver saw is validated against the checklist in CONFIG
 * before it is written: the payload arrives from a phone and is not trusted to
 * name its own items. An unknown key is a checklist that changed under the
 * driver mid-form, so it is refused rather than written as free text.
 */
function submitInspection(payload) {
  payload = payload || {};

  var truck = String(payload.truck || '').trim();
  var type = String(payload.type || '').trim();
  var driver = capped_(payload.driver, 100);
  var odometer = String(payload.odometer == null ? '' : payload.odometer).trim();
  var remarks = capped_(payload.remarks, 5000);
  var satisfactory = payload.satisfactory === true;

  var trucks = truckList_();
  if (!trucks.length) {
    throw new Error('No trucks are set up yet. Add them to the "' + TRUCKS_TAB +
      '" tab of the log, one per row.');
  }
  if (!truck) throw new Error('Pick which truck this is.');
  if (trucks.indexOf(truck) === -1) {
    throw new Error('"' + truck + '" is not on the ' + TRUCKS_TAB + ' tab. Add it ' +
      'there, or pick one of: ' + trucks.join(', '));
  }
  if (TYPES.indexOf(type) === -1) {
    throw new Error('Say whether this is a ' + TYPE_PRE + ' or a ' + TYPE_POST + '.');
  }
  if (!driver) throw new Error('Add your name — the report has to be signed by somebody.');

  if (odometer !== '') {
    var miles = Number(odometer.replace(/[, ]/g, ''));
    if (!isFinite(miles) || miles < 0) {
      throw new Error('The odometer reading should be a number, e.g. 148320.');
    }
    odometer = Math.round(miles);
  }

  // --- the defects themselves -------------------------------------------
  var index = itemIndex_();
  var seen = {};
  var defects = [];
  (payload.defects || []).forEach(function (raw) {
    var key = String((raw && raw.key) || '').trim();
    var side = String((raw && raw.side) || '').trim().toUpperCase();
    var known = has_(index, key) ? index[key] : null;
    if (!known) {
      throw new Error('This form is out of date — "' + key + '" is no longer on the ' +
        'checklist. Reload the page and fill it in again.');
    }
    if (known.sides) {
      if (side !== 'L' && side !== 'R') {
        throw new Error('Say whether it is the left or right ' + known.label.toLowerCase() + '.');
      }
    } else {
      side = '';
    }
    var id = key + (side ? ':' + side : '');
    if (has_(seen, id)) return;   // double-tap on a phone, not a second defect
    seen[id] = true;
    defects.push({ key: key, side: side, section: known.section,
                   label: known.label, alert: known.alert });
  });

  // The paper form makes the driver do one of two things: tick items, or tick
  // "truck is in satisfactory condition". Doing neither is an unsigned sheet,
  // and doing both is a contradiction. Refuse both, rather than guessing.
  if (!defects.length && !satisfactory) {
    throw new Error('Either tap the items that are defective, or confirm the truck is ' +
      'in satisfactory condition.');
  }
  if (defects.length && satisfactory) {
    throw new Error('You have marked ' + defects.length + ' item' +
      (defects.length === 1 ? '' : 's') + ' defective, so the truck cannot also be ' +
      'recorded as satisfactory. Clear one or the other.');
  }
  // "Check any defective item and provide details under Remarks" — the detail
  // is the part the shop actually works from, so it is required, not optional.
  if (defects.length && !remarks) {
    throw new Error('Describe the defect in the remarks box so the shop knows what ' +
      'they are looking at.');
  }

  var signature = payload.signature;
  if (!signature || !signature.data) {
    throw new Error('Sign the report before submitting it.');
  }

  // --- write it ---------------------------------------------------------
  var now = new Date();
  var condition = defects.length ? CONDITION_DEFECT : CONDITION_OK;
  var signatureUrl = saveSignature_(signature, truck, now);

  var result = withLock_(function () {
    var sheet = logSheet_();
    var headers = headerRow_(sheet);
    var report = nextReportId_(sheet);

    var values = {};
    values[COL.timestamp] = now;
    values[COL.report] = report;
    values[COL.truck] = truck;
    values[COL.type] = type;
    values[COL.date] = formatDate_(now);
    values[COL.time] = formatTime_(now);
    values[COL.driver] = plainText_(driver);
    values[COL.driverEmail] = viewerEmail_();
    values[COL.odometer] = odometer;
    values[COL.condition] = condition;
    values[COL.defectCount] = defects.length;
    values[COL.defectList] = defects.map(describeDefect_).join('\n');
    values[COL.remarks] = plainText_(remarks);
    values[COL.signature] = signatureUrl;
    values[COL.repairStatus] = defects.length ? REPAIR_NEEDED : REPAIR_NONE;
    // A list of report IDs, but it arrives from the phone like everything else,
    // so it is trimmed to a sane length and kept from acting as a formula.
    values[COL.reviewed] = plainText_(capped_(payload.reviewedReport, 200));
    values[COL.items] = JSON.stringify(defects.map(function (d) {
      return { key: d.key, side: d.side, label: d.label, section: d.section };
    }));

    var row = headers.map(function (name) {
      return values[name] === undefined ? '' : values[name];
    });
    sheet.appendRow(row);
    return { report: report, row: sheet.getLastRow() };
  });

  bumpGeneration_();

  // Email after the row exists, so a mail failure can never lose the report.
  // A driver who signed something and got an error would fill it in twice.
  try {
    if (defects.length) {
      notifyDefects_({
        report: result.report, truck: truck, type: type, driver: driver,
        odometer: odometer, remarks: remarks, defects: defects,
        when: now, row: result.row
      });
    }
  } catch (err) {
    console.error('Inspection ' + result.report + ' saved, but the email failed: ' + err);
  }

  return {
    report: result.report,
    truck: truck,
    type: type,
    condition: condition,
    defectCount: defects.length,
    signatureUrl: signatureUrl
  };
}

/** "Headlights (L)" — how a defect reads in the sheet and in the email. */
function describeDefect_(d) {
  return d.label + (d.side ? ' (' + d.side + ')' : '');
}

/**
 * Save the drawn signature as a PNG in Drive and return its link.
 *
 * Kept as a file rather than pasted into the sheet as an image: a signature is
 * the part of this record that has to survive somebody tidying up a
 * spreadsheet, and a Drive file has its own version history and permissions.
 *
 * Deliberately not shared by link. A signature is not a photo of a broken
 * mudflap — the people who need to see it are the people the folder is shared
 * with, and nobody else.
 */
function saveSignature_(signature, truck, when) {
  var data = String(signature.data || '');
  var comma = data.indexOf(',');
  if (comma !== -1) data = data.slice(comma + 1);   // strip the data: URL prefix
  if (!data) throw new Error('The signature did not come through. Sign again.');

  var folder = signatureFolder_();
  var stamp = Utilities.formatDate(when, tz_(), 'yyyy-MM-dd HHmm');
  var name = truck + ' ' + stamp + '.png';
  var blob = Utilities.newBlob(Utilities.base64Decode(data), 'image/png', name);
  return folder.createFile(blob).getUrl();
}

/**
 * The folder signatures go into: pinned by ID if one is set, otherwise
 * found-or-created by name.
 *
 * A bad or inaccessible ID throws from getFolderById, which would lose the
 * signature; catch it and fall back, so a mistyped ID is a
 * folder-in-the-wrong-place problem rather than an unsigned report.
 */
function signatureFolder_() {
  var id = String(CONFIG.signatureFolderId || '').trim();
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (err) {
      // fall through to the named folder below
    }
  }
  var folderName = CONFIG.signatureFolder || 'DVIR signatures';
  var folders = DriveApp.getFoldersByName(folderName);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
}

// ===========================================================================
// Closing a defect out
//
// Federal rules do not let a defect be closed by the driver noticing it looks
// fine the next morning. Somebody has to certify either that it was repaired
// or that no repair was needed, and that certification is what the next
// driver's pre-trip review is against.
// ===========================================================================

function certifyRepair(payload) {
  payload = payload || {};

  var report = String(payload.report || '').trim();
  var status = String(payload.status || '').trim();
  var notes = capped_(payload.notes, 5000);
  var by = capped_(payload.certifiedBy, 100);

  var viewer = viewerEmail_();
  if (!canCertify_(viewer)) {
    throw new Error('Your account is not on the list of people who can certify repairs. ' +
      'Ask whoever looks after the log to add you.');
  }
  if (!report) throw new Error('Which report is this about?');
  if (status !== REPAIR_DONE && status !== REPAIR_NOT_NEEDED) {
    throw new Error('Certify it as either "' + REPAIR_DONE + '" or "' +
      REPAIR_NOT_NEEDED + '".');
  }
  if (!by && !viewer) {
    throw new Error('Add your name — a certification has to say who made it.');
  }
  if (status === REPAIR_NOT_NEEDED && !notes) {
    throw new Error('Say why no repair was needed. "' + REPAIR_NOT_NEEDED +
      '" with nothing next to it is not a record of anything.');
  }

  var now = new Date();
  var updated = withLock_(function () {
    var sheet = logSheet_();
    var headers = headerRow_(sheet);
    var row = rowForReport_(sheet, headers, report, payload.row);
    if (!row) throw new Error('Report ' + report + ' is not in the log any more.');

    var write = function (name, value) {
      var i = headers.indexOf(name);
      if (i !== -1) sheet.getRange(row, i + 1).setValue(value);
    };
    write(COL.repairStatus, status);
    write(COL.repairNotes, plainText_(notes));
    write(COL.certifiedBy, plainText_(by || viewer));
    write(COL.certifiedOn, now);

    var truckCol = headers.indexOf(COL.truck);
    return {
      row: row,
      truck: truckCol === -1 ? '' : String(sheet.getRange(row, truckCol + 1).getValue() || '')
    };
  });

  bumpGeneration_();

  try {
    if (CONFIG.notifyOnRepair !== false) {
      notifyRepair_({
        report: report, truck: updated.truck, status: status, notes: notes,
        by: by || viewer, when: now, row: updated.row
      });
    }
  } catch (err) {
    console.error('Certification for ' + report + ' saved, but the email failed: ' + err);
  }

  return { report: report, status: status };
}

/**
 * The row a report is on right now.
 *
 * The log is append-only, so rows do not move on their own — but somebody can
 * always delete one by hand. The report ID is the stable handle: trust the row
 * the phone loaded with when it still holds that report, otherwise go looking.
 */
function rowForReport_(sheet, headers, report, hintRow) {
  var col = headers.indexOf(COL.report) + 1;
  if (!col) return 0;
  var last = sheet.getLastRow();

  hintRow = Number(hintRow) || 0;
  if (hintRow >= 2 && hintRow <= last) {
    if (String(sheet.getRange(hintRow, col).getValue() || '').trim() === report) return hintRow;
  }
  if (last < 2) return 0;

  var values = sheet.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === report) return i + 2;
  }
  return 0;
}

/** Someone changed Repair status in the sheet by hand: stamp who and when. */
function onInspectionEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== LOG_TAB) return;
  if (e.range.getRow() < 2 || e.range.getNumRows() !== 1) return;

  var headers = headerRow_(sheet);
  if (e.range.getColumn() !== headers.indexOf(COL.repairStatus) + 1) return;

  var value = String(e.value || '').trim();
  bumpGeneration_();
  if (value !== REPAIR_DONE && value !== REPAIR_NOT_NEEDED) return;

  var row = e.range.getRow();
  var stamp = function (name, value) {
    var i = headers.indexOf(name);
    if (i === -1) return;
    var cell = sheet.getRange(row, i + 1);
    if (!String(cell.getValue() || '').trim()) cell.setValue(value);
  };
  stamp(COL.certifiedBy, Session.getActiveUser().getEmail() || 'edited in the sheet');
  stamp(COL.certifiedOn, new Date());
}

// ===========================================================================
// Fleet and history, for the shop
// ===========================================================================

/** One line per truck: when it was last inspected, and what is outstanding. */
function getFleet() {
  var data = snapshot_();
  var now = Date.now();
  var staleMs = (CONFIG.staleAfterHours || 0) * HOUR_MS;

  var fleet = truckList_().map(function (truck) {
    var mine = data.reports.filter(function (r) { return r.truck === truck; });
    var last = mine[0] || null;
    var open = openDefectsFor_(truck, data.reports);

    return {
      truck: truck,
      lastReport: last ? {
        report: last.report, type: last.type, date: last.date, time: last.time,
        driver: last.driver, condition: last.condition, odometer: last.odometer
      } : null,
      lastWhen: last ? last.when : 0,
      stale: staleMs > 0 && (!last || now - last.when > staleMs),
      openDefects: open.map(function (r) {
        return {
          report: r.report, row: r.row, date: r.date, time: r.time,
          driver: r.driver, type: r.type, defects: r.defects,
          remarks: r.remarks, repairStatus: r.repairStatus || REPAIR_NEEDED
        };
      })
    };
  });

  // Trucks that have been inspected but are no longer on the Trucks tab still
  // have history worth seeing, so count them rather than hiding them entirely.
  var known = {};
  truckList_().forEach(function (t) { known[t] = true; });
  var retired = {};
  data.reports.forEach(function (r) {
    if (r.truck && !known[r.truck]) retired[r.truck] = true;
  });

  return {
    fleet: fleet,
    retired: Object.keys(retired),
    canCertify: canCertify_(viewerEmail_()),
    repairOptions: [REPAIR_DONE, REPAIR_NOT_NEEDED]
  };
}

/**
 * Past reports, newest first, a page at a time.
 *
 * Paged rather than sent whole because this log grows by about thirty rows a
 * week per truck and never shrinks: a fleet of fifteen would be shipping a
 * year of paperwork to a phone on every open by next summer.
 */
function getHistory(options) {
  options = options || {};
  var truck = String(options.truck || '').trim();
  var search = String(options.search || '').trim().toLowerCase();
  var offset = Math.max(0, Number(options.offset) || 0);
  var size = CONFIG.historyPageSize || 25;

  var reports = snapshot_().reports;
  if (truck) reports = reports.filter(function (r) { return r.truck === truck; });
  if (search) {
    reports = reports.filter(function (r) {
      return [r.report, r.truck, r.driver, r.type, r.condition,
              r.defects.join(' '), r.remarks, r.repairNotes, r.certifiedBy]
        .join(' ').toLowerCase().indexOf(search) !== -1;
    });
  }

  return {
    total: reports.length,
    offset: offset,
    reports: reports.slice(offset, offset + size),
    more: offset + size < reports.length,
    canCertify: canCertify_(viewerEmail_())
  };
}

// ===========================================================================
// Email
// ===========================================================================

function recipients_(urgent) {
  var to = [CONFIG.shopLead, CONFIG.owner];
  if (urgent && CONFIG.safetyContact) to.push(CONFIG.safetyContact);
  return to
    .map(function (a) { return String(a || '').trim(); })
    .filter(function (a, i, all) { return a && all.indexOf(a) === i; })
    .join(',');
}

function rowUrl_(row) {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(LOG_TAB);
  var gid = sheet ? sheet.getSheetId() : 0;
  return ss.getUrl() + '#gid=' + gid + '&range=A' + row;
}

/** Email the shop about a report that has defects on it. */
function notifyDefects_(r) {
  var urgent = r.defects.some(function (d) { return d.alert; });
  var to = recipients_(urgent);
  if (!to) return;

  var lines = r.defects.map(describeDefect_);
  var subject = (urgent ? '⚠ ' : '') + r.truck + ' — ' +
    lines.length + ' defect' + (lines.length === 1 ? '' : 's') +
    ' on ' + r.type.toLowerCase() + ' (' + r.report + ')';

  var link = rowUrl_(r.row);
  var plain = [
    r.truck + ' — ' + r.type,
    'Reported by ' + r.driver + ' on ' + formatDate_(r.when) + ' at ' + formatTime_(r.when),
    r.odometer !== '' ? 'Odometer: ' + r.odometer : '',
    '',
    'Defects:',
    lines.map(function (l) { return '  • ' + l; }).join('\n'),
    '',
    'Driver remarks:',
    r.remarks,
    '',
    'This truck stays flagged until someone certifies the repair, or certifies',
    'that no repair was needed. Until then every driver who scans it is shown',
    'this report and has to confirm they have read it.',
    '',
    link
  ].filter(function (l) { return l !== ''; }).join('\n');

  var html =
    '<div style="font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;color:#1a1f1c;max-width:560px">' +
      (urgent
        ? '<div style="background:#fbe3df;color:#8e2a1c;font-weight:700;padding:10px 12px;border-radius:4px;margin-bottom:14px">' +
          'Includes a brake, steering or tire item.</div>'
        : '') +
      '<div style="font-size:11px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:#6b7570">' +
        escapeHtml_(r.type) + ' inspection — ' + escapeHtml_(r.report) +
      '</div>' +
      '<h2 style="margin:4px 0 2px;font-size:22px">' + escapeHtml_(r.truck) + '</h2>' +
      '<div style="color:#6b7570;font-size:13px;margin-bottom:16px">' +
        escapeHtml_(r.driver) + ' · ' + escapeHtml_(formatDate_(r.when)) + ' at ' +
        escapeHtml_(formatTime_(r.when)) +
        (r.odometer !== '' ? ' · ' + escapeHtml_(String(r.odometer)) + ' mi' : '') +
      '</div>' +
      '<table style="border-collapse:collapse;width:100%;margin-bottom:16px">' +
        r.defects.map(function (d) {
          return '<tr><td style="padding:7px 0;border-bottom:1px solid #eef1ee">' +
            '<span style="color:' + (d.alert ? '#8e2a1c' : '#3d4642') + ';font-weight:600">' +
            escapeHtml_(describeDefect_(d)) + '</span>' +
            '<div style="color:#6b7570;font-size:12px">' + escapeHtml_(d.section) + '</div>' +
            '</td></tr>';
        }).join('') +
      '</table>' +
      '<div style="font-size:11px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:#6b7570">Driver remarks</div>' +
      '<div style="background:#f4f6f3;border-left:3px solid #2d6a4a;padding:10px 12px;margin:6px 0 16px;white-space:pre-wrap">' +
        escapeHtml_(r.remarks) +
      '</div>' +
      '<p style="color:#6b7570;font-size:13px">This truck stays flagged until someone ' +
        'certifies the repair, or certifies that no repair was needed. Until then every ' +
        'driver who scans it is shown this report and has to confirm they have read it.</p>' +
      '<p><a href="' + link + '" style="display:inline-block;background:#2d6a4a;color:#fff;' +
        'text-decoration:none;font-weight:600;padding:10px 16px;border-radius:4px">Open the log</a></p>' +
    '</div>';

  MailApp.sendEmail({
    to: to,
    subject: subject,
    body: plain,
    htmlBody: html,
    name: CONFIG.companyName || 'Vehicle inspections',
    importance: urgent ? 'high' : 'normal'
  });
}

/** Email the shop when a defect is certified closed. */
function notifyRepair_(r) {
  var to = recipients_(false);
  if (!to) return;

  var subject = r.truck + ' — ' + r.status.toLowerCase() + ' (' + r.report + ')';
  var link = rowUrl_(r.row);
  var plain = [
    r.report + ' on ' + r.truck + ' is now "' + r.status + '".',
    'Certified by ' + r.by + ' on ' + formatDate_(r.when) + '.',
    r.notes ? '\nNotes:\n' + r.notes : '',
    '',
    link
  ].filter(function (l) { return l !== ''; }).join('\n');

  MailApp.sendEmail({
    to: to,
    subject: subject,
    body: plain,
    name: CONFIG.companyName || 'Vehicle inspections'
  });
}

function escapeHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

// ===========================================================================
// Checking it works
// ===========================================================================

/**
 * Run this from the editor when something looks wrong. It reports on every
 * moving part rather than stopping at the first problem, because the answer to
 * "why did nobody get the email" is usually two things at once.
 */
function healthCheck() {
  var lines = [];
  var problems = 0;
  var ok = function (msg) { lines.push('  OK    ' + msg); };
  var bad = function (msg) { problems++; lines.push('  FIX   ' + msg); };

  lines.push('=== ' + (CONFIG.companyName || 'Fleet') + ' inspection log ===');
  lines.push('');

  // --- the log ----------------------------------------------------------
  var sheet = null;
  try {
    sheet = logSheet_();
    var headers = headerRow_(sheet);
    var missing = HEADERS.filter(function (h) { return headers.indexOf(h) === -1; });
    if (missing.length) bad('The log is missing columns: ' + missing.join(', ') +
      '. Run setUp() again.');
    else ok('Log tab "' + LOG_TAB + '" has all ' + HEADERS.length + ' columns.');
    ok('Reports on file: ' + Math.max(sheet.getLastRow() - 1, 0) + '.');
  } catch (err) {
    bad('Cannot read the log: ' + err.message);
  }

  // --- the fleet --------------------------------------------------------
  var trucks = truckList_();
  if (!trucks.length) bad('No trucks. Add them to the "' + TRUCKS_TAB + '" tab.');
  else if (!SpreadsheetApp.getActive().getSheetByName(TRUCKS_TAB)) {
    bad('No "' + TRUCKS_TAB + '" tab, so the app is falling back to the list in ' +
      'CONFIG (' + trucks.join(', ') + '). Run setUp() to create it.');
  } else ok(trucks.length + ' truck' + (trucks.length === 1 ? '' : 's') + ': ' +
    trucks.join(', ') + '.');

  // --- the checklist ----------------------------------------------------
  var index = itemIndex_();
  var keys = Object.keys(index);
  var itemCount = (CONFIG.sections || []).reduce(function (n, s) {
    return n + (s.items || []).length;
  }, 0);
  if (!keys.length) bad('The checklist in CONFIG.sections is empty.');
  else if (keys.length !== itemCount) {
    bad('Two checklist items share a name, so one would overwrite the other. ' +
      itemCount + ' items but only ' + keys.length + ' distinct ones.');
  } else ok(itemCount + ' checklist items across ' + CONFIG.sections.length + ' sections.');

  (CONFIG.alertItems || []).forEach(function (label) {
    if (!index[itemKey_(label)]) {
      bad('CONFIG.alertItems lists "' + label + '", which is not on the checklist. ' +
        'It will never flag anything.');
    }
  });

  // --- email ------------------------------------------------------------
  var to = recipients_(true);
  if (!to) bad('No email addresses set, so defects will be recorded and nobody told.');
  else if (/@example\.com/.test(to)) {
    bad('CONFIG still has the example.com placeholder addresses: ' + to);
  } else ok('Defects email ' + to + '.');

  try {
    ok('Email quota left today: ' + MailApp.getRemainingDailyQuota() + '.');
  } catch (err) {
    bad('Cannot read the email quota: ' + err.message);
  }

  // --- signatures -------------------------------------------------------
  try {
    var folder = signatureFolder_();
    var pinned = String(CONFIG.signatureFolderId || '').trim();
    if (pinned && folder.getId() !== pinned) {
      bad('CONFIG.signatureFolderId is set but unreadable, so signatures are going ' +
        'to "' + folder.getName() + '" instead. Check the ID and who it is shared with.');
    } else ok('Signatures save to "' + folder.getName() + '".');
  } catch (err) {
    bad('Cannot reach the signature folder: ' + err.message);
  }

  // --- who can close a defect ------------------------------------------
  if (!(CONFIG.certifiers || []).length) {
    ok('Anyone who can open the app can certify a repair (CONFIG.certifiers is empty).');
  } else if (!String(CONFIG.workEmailDomain || '').trim()) {
    bad('CONFIG.certifiers is set but workEmailDomain is blank. If the deployment is ' +
      'open to "Anyone", every viewer is anonymous and nobody will be able to certify.');
  } else ok('Repairs can be certified by: ' + CONFIG.certifiers.join(', ') + '.');

  // --- triggers ---------------------------------------------------------
  var hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'onInspectionEdit';
  });
  if (hasTrigger) ok('Edit trigger installed.');
  else bad('No edit trigger, so a repair status changed by hand in the sheet will ' +
    'not be stamped with who did it. Run setUp().');

  // --- what is outstanding ---------------------------------------------
  try {
    var data = snapshot_();
    var open = data.reports.filter(function (r) {
      return r.condition === CONDITION_DEFECT &&
        r.repairStatus !== REPAIR_DONE && r.repairStatus !== REPAIR_NOT_NEEDED;
    });
    lines.push('');
    lines.push('Outstanding defects: ' + open.length + '.');
    open.slice(0, 10).forEach(function (r) {
      lines.push('  ' + r.report + '  ' + r.truck + '  ' + r.date + '  ' +
        r.defects.join('; '));
    });
  } catch (err) {
    bad('Cannot summarise outstanding defects: ' + err.message);
  }

  lines.push('');
  lines.push(problems ? problems + ' thing(s) to fix.' : 'Everything checks out.');

  var report = lines.join('\n');
  console.log(report);
  try {
    SpreadsheetApp.getActive().toast(
      problems ? problems + ' thing(s) to fix — see the execution log.' : 'All good.',
      'Health check'
    );
  } catch (err) { /* run from the editor with no sheet in front of you */ }
  return report;
}

/** Send yourself one defect email, to prove the addresses work. */
function sendTestEmail() {
  notifyDefects_({
    report: (CONFIG.reportPrefix || 'DVIR') + '-TEST',
    truck: (truckList_()[0] || 'Truck'),
    type: TYPE_PRE,
    driver: 'Health check',
    odometer: 148320,
    remarks: 'This is a test. Nothing is actually wrong with the truck.',
    defects: [
      { key: 'x', side: 'L', section: 'Front / Engine Compartment',
        label: 'Headlights', alert: false },
      { key: 'y', side: '', section: 'In Cab Check',
        label: 'Service brakes / ABS light (ST only)', alert: true }
    ],
    when: new Date(),
    row: 2
  });
  console.log('Sent to ' + recipients_(true));
}

/** A menu in the spreadsheet, so none of the above needs the script editor. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Inspections')
    .addItem('Set up / repair', 'setUp')
    .addItem('Health check', 'healthCheck')
    .addItem('Send a test email', 'sendTestEmail')
    .addToUi();
}
