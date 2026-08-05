/**
 * maintenance-notify.gs — Google Apps Script for the equipment maintenance log.
 *
 * Paste this into the response spreadsheet (Extensions -> Apps Script), edit
 * CONFIG below, then run setUp() once. After that, every form submission:
 *
 *   1. gets a ticket ID and a Status of "Open" written back to the row,
 *   2. emails the Facilities Lead, the Owner, and the chosen Leadership
 *      contact, with a reply-to of whoever filed it,
 *   3. emails those same people again when someone marks the row "Done".
 *
 * There is no server and no cost: the script runs on Google's infrastructure,
 * attached to the spreadsheet.
 */

// ===========================================================================
// CONFIG — this is the only section you need to edit.
// ===========================================================================
var CONFIG = {

  // Notified on every single request, no matter what.
  facilitiesLead: 'facilities.lead@example.com',
  owner: 'owner@example.com',

  // The Leadership Team dropdown in the form. The keys must match the answer
  // options *exactly* (copy and paste them to be sure).
  leadership: {
    'Dana Whitfield': 'dana@example.com',
    'Marcus Reed': 'marcus@example.com',
    'Priya Anand': 'priya@example.com'
  },

  // Used when the leadership answer is blank or unrecognised, so a request is
  // never silently delivered to nobody.
  leadershipFallback: 'leadership@example.com',

  // Form question titles. Change these only if you word your questions
  // differently; matching is case-insensitive and ignores trailing punctuation.
  //
  // A list means "any of these" — the first is what a new form should use, and
  // the rest are older wordings that still match. That is why 'Vehicle' is
  // still listed: a log that started out tracking only vehicles keeps working
  // without anyone having to rename a column of historical data.
  questions: {
    equipment: ['Equipment', 'Vehicle'],
    item: 'Which item, and where is it?',
    leadership: 'Leadership Team contact',
    priority: 'How urgent is it?',
    problem: 'What needs attention?',
    reportedBy: 'Your name'
  },

  // The starting equipment list. setUp copies this into an "Equipment" tab in
  // the spreadsheet, and from then on THE TAB IS THE SOURCE OF TRUTH — edit it
  // there and the app picks the change up immediately, with no redeploy. This
  // list is only the seed, and the fallback if the tab is deleted.
  equipment: ['Tractor', 'Gator', 'Truck', 'Sprayer', 'General equipment'],

  // Urgency options, most serious first. The ones in urgentAnswers below get
  // the red treatment; these are simply the choices offered.
  urgencyOptions: [
    'Safety issue - do not operate',
    'Down - cannot be used',
    'Needs attention soon',
    'Routine / next service'
  ],

  // Photos attached in the app land in this Drive folder.
  //
  // Pin an existing folder by ID and every photo goes straight into it. The ID
  // is the last part of the folder's URL:
  //   https://drive.google.com/drive/folders/THIS_PART?usp=drive_link
  // The account that runs the web app (Execute as: Me) must be able to edit that
  // folder. Leave photoFolderId '' to fall back to finding-or-creating a folder
  // by the name below instead.
  photoFolderId: '1EsuTNZZf2bbdlcEaKAP7ELqvAtbYLC9c',
  photoFolder: 'Equipment maintenance photos',

  // Anyone on a notification email needs to be able to open the photo, and
  // they are not all in your Drive. Set false to keep photos private to you —
  // the link then only works for people you share the folder with.
  photoLinkSharing: true,

  // The catch-all bucket, for step stools, ladders, pallet jacks, hand tools
  // and anything else that breaks too rarely to deserve its own QR code.
  // One QR code covers all of it; the "Which item" answer says what broke.
  // Must match the form's answer option exactly.
  generalEquipment: 'General equipment',

  // The Open and History filters group machines by the "Category" column on the
  // Equipment tab. Anything left without a category falls under this heading.
  uncategorisedLabel: 'Other',

  // Priority answers that should mark the email as high importance and put a
  // flag in the subject line. Match your form's wording.
  urgentAnswers: ['Safety issue - do not operate', 'Down - cannot be used'],

  // Work email domain. When someone opens the app signed in with an address in
  // this domain, "Reported by" fills itself in and the notification email can be
  // replied to directly. Leave blank to accept any signed-in address.
  //
  // Google only tells the script who the viewer is when the web app's access is
  // restricted to your organisation. Deployed as "Anyone", every viewer is
  // anonymous and the field falls back to being typed by hand.
  workEmailDomain: 'millcreekplants.com',

  // Prefix for generated ticket IDs, e.g. MNT-0007.
  ticketPrefix: 'MNT',

  // Paste your form's share link here and the mobile web app gets a
  // "New request" button. Leave blank to hide the button.
  formUrl: '',

  // Set false if you would rather not be emailed when a row is closed out.
  notifyOnClose: true,

  // How many *closed* requests the phone app loads. Open ones are always all
  // sent. Without a cap the payload grows with the log forever, and by year
  // three the app is downloading a decade of finished repairs on every open.
  // The full history is always in the sheet.
  closedHistoryShown: 50,

  // Dashboard: an open request older than this many days is counted as
  // "aging", and the repeat-offender and downtime figures cover this many
  // days back. A year keeps a full season in view.
  agingAfterDays: 7,
  dashboardWindowDays: 365
};

// Columns this script adds and manages on the response sheet.
var STATUS_COL = 'Status';
var TICKET_COL = 'Ticket';
var ASSIGNED_COL = 'Assigned to';
var CLOSED_COL = 'Closed on';
var NOTES_COL = 'Work done / notes';
var PHOTO_COL = 'Photo';
var EQUIPMENT_TAB = 'Equipment';
var STATUS_OPTIONS = ['Open', 'In progress', 'Waiting on parts', 'Done', 'Not needed'];

// ===========================================================================
// One-time setup
// ===========================================================================

/**
 * Run this once, from the Apps Script editor, after pasting the file in.
 * It is safe to run again; it will not duplicate columns or triggers.
 */
function setUp() {
  var sheet = responseSheet_();
  buildEquipmentTab_();
  addTrackingColumns_(sheet);
  applyReadableFormatting_(sheet);
  buildMobileTab_(sheet);
  installTriggers_();
  SpreadsheetApp.getActive().toast('Maintenance log is set up and watching for submissions.');
}

/**
 * The equipment the app offers, read from the "Equipment" tab.
 *
 * Kept in the spreadsheet rather than in this file on purpose: a fleet list
 * changes — machines get renamed, teams get split — and needing a code edit
 * and a redeploy for that is how an app ends up showing names nobody uses any
 * more. Editing the tab takes effect on the next page load.
 *
 * Falls back to CONFIG.equipment if the tab is missing or empty, so nothing
 * breaks if someone deletes it.
 */
function equipmentList_() {
  if (EQUIPMENT_CACHE) return EQUIPMENT_CACHE;

  var names = [];
  var tab = SpreadsheetApp.getActive().getSheetByName(EQUIPMENT_TAB);
  var lastRow = tab ? tab.getLastRow() : 0;
  if (lastRow > 1) {
    tab.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function (row) {
      var name = String(row[0] == null ? '' : row[0]).trim();
      if (name && names.indexOf(name) === -1) names.push(name);
    });
  }
  if (!names.length) names = (CONFIG.equipment || []).slice();

  EQUIPMENT_CACHE = names;
  return names;
}

var EQUIPMENT_CACHE = null;

/**
 * Which category each machine belongs to, read from a "Category" column on the
 * Equipment tab (any position — found by header). Lets the Open and History
 * filters group 30+ machines into a handful of chips instead of one long
 * left-right scroll.
 *
 * Returns { map: {name: category}, order: [categories, first seen first] }.
 * No "Category" column, or every cell blank, means an empty order — and the app
 * falls back to the flat list, so nothing breaks on a log that never set them.
 */
function equipmentCategoryMap_() {
  if (CATEGORY_CACHE) return CATEGORY_CACHE;

  var map = {};
  var order = [];
  var tab = SpreadsheetApp.getActive().getSheetByName(EQUIPMENT_TAB);
  var lastRow = tab ? tab.getLastRow() : 0;
  var lastCol = tab ? tab.getLastColumn() : 0;

  if (lastRow > 1 && lastCol >= 1) {
    var headers = tab.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(function (h) { return String(h).trim().toLowerCase(); });
    var nameCol = headers.indexOf('equipment');
    if (nameCol === -1) nameCol = 0;              // the list has always been column A
    var catCol = headers.indexOf('category');
    if (catCol !== -1) {
      tab.getRange(2, 1, lastRow - 1, lastCol).getValues().forEach(function (row) {
        var name = String(row[nameCol] == null ? '' : row[nameCol]).trim();
        var cat = String(row[catCol] == null ? '' : row[catCol]).trim();
        if (name && cat) {
          map[name] = cat;
          if (order.indexOf(cat) === -1) order.push(cat);
        }
      });
    }
  }

  CATEGORY_CACHE = { map: map, order: order };
  return CATEGORY_CACHE;
}

var CATEGORY_CACHE = null;

/**
 * Group a list of machine names into ordered categories for the filter chips.
 * Machines with no category fall into a trailing "Other" bucket. Returns [] when
 * no categories are set at all, which the app reads as "show the flat list".
 */
function groupEquipment_(names) {
  var info = equipmentCategoryMap_();
  if (!info.order.length) return [];

  var other = CONFIG.uncategorisedLabel || 'Other';
  var order = info.order.slice();
  var buckets = {};
  names.forEach(function (name) {
    var cat = info.map[name] || other;
    if (!buckets[cat]) {
      buckets[cat] = [];
      if (order.indexOf(cat) === -1) order.push(cat);   // the Other bucket, appended last
    }
    buckets[cat].push(name);
  });

  return order
    .filter(function (cat) { return buckets[cat] && buckets[cat].length; })
    .map(function (cat) { return { name: cat, items: buckets[cat] }; });
}

/** Which category a machine sits in, for filtering the whole log server-side. */
function categoryOf_(name) {
  return equipmentCategoryMap_().map[name] || (CONFIG.uncategorisedLabel || 'Other');
}

/** Create the Equipment tab on first run, seeded from CONFIG. Never overwrites. */
function buildEquipmentTab_() {
  var ss = SpreadsheetApp.getActive();
  var tab = ss.getSheetByName(EQUIPMENT_TAB);
  if (tab) return;   // already yours to edit — leave it alone

  tab = ss.insertSheet(EQUIPMENT_TAB);
  tab.getRange('A1:B1').setFontWeight('bold').setBackground('#e8efe9');
  tab.getRange('A1').setValue('Equipment').setNote(
    'One machine per row. The app reads this list every time it loads, so ' +
    'adding or renaming here needs no redeploy. Names must match the form\'s ' +
    'answer options and the printed QR labels.'
  );
  // Optional. Fill this in to group the Open and History filters — e.g. give
  // every tractor "Tractors" — so a long fleet is a few chips, not one long
  // scroll. Leave it blank and the app just lists every machine.
  tab.getRange('B1').setValue('Category').setNote(
    'Optional. A word that groups machines in the app\'s Open and History ' +
    'filters, e.g. "Tractors", "Golf Carts". Machines left blank appear under ' +
    '"' + (CONFIG.uncategorisedLabel || 'Other') + '".'
  );

  var seed = (CONFIG.equipment || []).map(function (name) { return [name]; });
  if (seed.length) tab.getRange(2, 1, seed.length, 1).setValues(seed);
  tab.setColumnWidth(1, 220);
  tab.setColumnWidth(2, 150);
  tab.setFrozenRows(1);
}

/** The form-responses tab. Uses the first sheet that has a Timestamp header. */
function responseSheet_() {
  var sheets = SpreadsheetApp.getActive().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var header = sheets[i].getRange(1, 1).getValue();
    if (String(header).trim().toLowerCase() === 'timestamp') return sheets[i];
  }
  throw new Error(
    'Could not find the form responses tab. Link the form to this spreadsheet ' +
    'first (in the form: Responses -> Link to Sheets).'
  );
}

/** Append the tracking columns to the right of the form's own columns. */
function addTrackingColumns_(sheet) {
  // Photo last: if the form already has a 'Photo' upload question the header
  // is already there and this leaves it alone.
  var wanted = [TICKET_COL, STATUS_COL, ASSIGNED_COL, CLOSED_COL, NOTES_COL, PHOTO_COL];
  var headers = headerRow_(sheet);

  var added = false;
  wanted.forEach(function (name) {
    if (headers.indexOf(name) !== -1) return;
    var col = sheet.getLastColumn() + 1;
    sheet.getRange(1, col).setValue(name).setFontWeight('bold');
    headers.push(name);
    added = true;
  });
  if (added) forgetHeaders_();

  // A dropdown on Status keeps the values consistent enough to filter on.
  var statusCol = headerRow_(sheet).indexOf(STATUS_COL) + 1;
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, statusCol, rows, 1).setDataValidation(rule);

  sheet.setFrozenRows(1);
}

/**
 * Make the log readable on a phone as far as a spreadsheet allows: narrow the
 * columns nobody reads, wrap the one that matters, and colour-code status and
 * urgency so the sheet can be skimmed without reading any text.
 *
 * Deliberately does not reorder columns. Google Forms writes responses by
 * column position, and shuffling them on a linked sheet is a known way to end
 * up with answers landing in the wrong column.
 */
function applyReadableFormatting_(sheet) {
  var headers = headerRow_(sheet);
  var lastRow = Math.max(sheet.getMaxRows(), 2);
  var q = CONFIG.questions;

  // Narrow for the columns you glance at, wide for the description.
  var widths = {};
  widths['Timestamp'] = 110;
  widths['Email Address'] = 120;
  widths[headerFor_(headers, q.equipment)] = 110;
  widths[headerFor_(headers, q.item)] = 180;
  widths[q.priority] = 130;
  widths[q.problem] = 320;
  widths[q.reportedBy] = 110;
  widths[q.leadership] = 130;
  widths[TICKET_COL] = 80;
  widths[STATUS_COL] = 110;
  widths[ASSIGNED_COL] = 150;
  widths[CLOSED_COL] = 110;
  widths[NOTES_COL] = 280;

  headers.forEach(function (name, i) {
    var width = widths[name];
    if (width) sheet.setColumnWidth(i + 1, width);
  });

  // Wrap and top-align the long text columns; clip everything else so one long
  // answer cannot make every row three lines tall.
  var wrapCols = [q.problem, NOTES_COL];
  headers.forEach(function (name, i) {
    var range = sheet.getRange(1, i + 1, lastRow, 1);
    var wrap = wrapCols.indexOf(name) !== -1;
    range.setWrapStrategy(wrap ? SpreadsheetApp.WrapStrategy.WRAP : SpreadsheetApp.WrapStrategy.CLIP)
      .setVerticalAlignment('top');
  });

  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#e8efe9');
  sheet.setFrozenRows(1);

  applyStatusColours_(sheet, headers, lastRow);
}

/** Colour rules so status and urgency read at a glance. */
function applyStatusColours_(sheet, headers, lastRow) {
  var statusIdx = headers.indexOf(STATUS_COL);
  var priorityIdx = headers.indexOf(CONFIG.questions.priority);
  if (statusIdx === -1) return;

  var statusRange = sheet.getRange(2, statusIdx + 1, lastRow - 1, 1);
  var rules = [];

  var byStatus = [
    ['Open', '#fdecc8', '#7a4f01'],
    ['In progress', '#d6e4f7', '#1c3d69'],
    ['Waiting on parts', '#f0e0f5', '#5b2d6e'],
    ['Done', '#dff0e2', '#1e5128'],
    ['Not needed', '#eceeed', '#6b7472']
  ];
  byStatus.forEach(function (s) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(s[0])
      .setBackground(s[1])
      .setFontColor(s[2])
      .setRanges([statusRange])
      .build());
  });

  // Urgent requests get a red cell in the urgency column, whatever the wording,
  // so a safety report is visible while scrolling past on a phone.
  if (priorityIdx !== -1) {
    var priorityRange = sheet.getRange(2, priorityIdx + 1, lastRow - 1, 1);
    ['Safety', 'Down'].forEach(function (word) {
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenTextContains(word)
        .setBackground('#fbe0dd')
        .setFontColor('#8e2a1c')
        .setBold(true)
        .setRanges([priorityRange])
        .build());
    });
  }

  // Replace only our rules; anything the user added by hand on other ranges stays.
  var managed = [statusIdx + 1];
  if (priorityIdx !== -1) managed.push(priorityIdx + 1);
  var kept = sheet.getConditionalFormatRules().filter(function (rule) {
    return rule.getRanges().every(function (r) {
      return managed.indexOf(r.getColumn()) === -1;
    });
  });
  sheet.setConditionalFormatRules(kept.concat(rules));
}

var MOBILE_TAB = 'On my phone';
var MOBILE_TAB_TITLE = 'Open maintenance requests';

/**
 * Build the "On my phone" tab: a live, five-column view of open requests only,
 * newest first. This is the tab to open on a phone — it fits the screen without
 * sideways scrolling, and it updates itself because it is a formula, not a copy.
 *
 * Rebuilt from scratch every time setUp runs, so it refuses to touch a tab of
 * the same name that it did not generate rather than clearing someone's work.
 */
function buildMobileTab_(sheet) {
  var ss = SpreadsheetApp.getActive();
  var tab = ss.getSheetByName(MOBILE_TAB);

  if (!tab) {
    tab = ss.insertSheet(MOBILE_TAB, 0);
  } else if (tab.getLastRow() > 0 && tab.getRange('A1').getValue() !== MOBILE_TAB_TITLE) {
    throw new Error(
      'A tab called "' + MOBILE_TAB + '" already exists and was not created by this ' +
      'script, so it has been left alone. Rename it and run setUp again.'
    );
  }

  tab.clear();
  tab.clearConditionalFormatRules();

  var headers = headerRow_(sheet);
  var q = CONFIG.questions;

  // The item column is optional: a log set up before the catch-all bucket
  // existed simply will not have it, and that should not break this tab.
  var wanted = [
    { title: TICKET_COL, required: true },
    { title: headerFor_(headers, q.equipment), required: true },
    { title: headerFor_(headers, q.item), required: false },
    { title: q.problem, required: true },
    { title: STATUS_COL, required: true }
  ];

  var cols = [];
  var letters = [];
  wanted.forEach(function (w) {
    var i = headers.indexOf(w.title);
    if (i === -1) {
      if (w.required) {
        throw new Error('Column "' + w.title + '" is missing from the log. Run setUp again.');
      }
      return;
    }
    cols.push(w.title);
    letters.push(columnLetter_(i + 1));
  });

  var statusLetter = columnLetter_(headers.indexOf(STATUS_COL) + 1);
  var quoted = "'" + sheet.getName().replace(/'/g, "''") + "'";

  // Open items only, newest first. Blank status counts as open so a request can
  // never hide from this view just because the status cell was cleared.
  var formula = '=IFERROR(QUERY(' + quoted + '!A:' + columnLetter_(headers.length) + ', ' +
    '"select ' + letters.join(', ') + ' ' +
    'where ' + statusLetter + " <> 'Done' and " + statusLetter + " <> 'Not needed' " +
    'order by A desc label ' +
    letters.map(function (l, i) { return l + " '" + cols[i].replace(/'/g, "''") + "'"; }).join(', ') +
    '", 1), "Nothing open right now.")';

  tab.getRange('A2').setFormula(formula);

  tab.getRange('A1')
    .setValue(MOBILE_TAB_TITLE)
    .setFontSize(14)
    .setFontWeight('bold');

  var widths = [70, 100, 120, 300, 100];
  widths.forEach(function (w, i) { tab.setColumnWidth(i + 1, w); });
  tab.getRange('D:D').setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
  tab.getRange('A:E').setVerticalAlignment('top');
  tab.setFrozenRows(2);

  var note = tab.getRange('G1');
  note.setValue(
    'This tab is generated by the script and rebuilds itself when setUp runs. ' +
    'Edit requests on the responses tab or in the web app, not here.'
  ).setFontColor('#6b7472').setFontSize(9);
}

/** 1 -> A, 27 -> AA. */
function columnLetter_(index) {
  var letter = '';
  while (index > 0) {
    var rem = (index - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    index = Math.floor((index - 1) / 26);
  }
  return letter;
}

/** Install the submit and edit triggers, replacing any this script made before. */
function installTriggers_() {
  var ss = SpreadsheetApp.getActive();
  var existing = ScriptApp.getProjectTriggers();
  existing.forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'onMaintenanceSubmit' || fn === 'onMaintenanceEdit') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('onMaintenanceSubmit').forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger('onMaintenanceEdit').forSpreadsheet(ss).onEdit().create();
}

// ===========================================================================
// Triggers
// ===========================================================================

/**
 * Run `fn` with the script lock held, so two triggers firing at once cannot
 * interleave a read and a write.
 *
 * If the lock cannot be taken in time the work still runs. Two people filing a
 * request in the same second might then share a ticket number, which is
 * untidy; dropping a maintenance request because a lock was busy would be
 * worse.
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
      SpreadsheetApp.flush();   // commit before another trigger can read
      lock.releaseLock();
    }
  }
}

/**
 * Runs on every Google Form submission.
 *
 * The form is kept as a backup way in; tickets created in the app take the
 * path below instead. Both end in processNewRequest_ so a request looks the
 * same however it arrived.
 */
function onMaintenanceSubmit(e) {
  var sheet = responseSheet_();
  var row = e && e.range ? e.range.getRow() : sheet.getLastRow();
  processNewRequest_(sheet, row, readAnswers_(e, sheet, row));
}

/**
 * Give a newly added row its ticket and status, then tell the three people who
 * need to know. Shared by the form trigger and by the app's Create Ticket.
 */
function processNewRequest_(sheet, row, answers) {
  bumpGeneration_();   // a form submission changes the numbers too
  // Allocating the ticket reads the whole column and then writes to it, so it
  // has to be atomic against another request arriving at the same moment.
  var ticket = withLock_(function () {
    // Apps Script retries a trigger after a transient failure. If this row was
    // already given a ticket, keep it rather than renumbering the request and
    // resetting a status somebody may have moved on already.
    var existing = readCell_(sheet, row, TICKET_COL);
    if (existing) return existing;

    var id = nextTicketId_(sheet);
    writeCell_(sheet, row, TICKET_COL, id);
    writeCell_(sheet, row, STATUS_COL, 'Open');
    return id;
  });

  writeCell_(sheet, row, ASSIGNED_COL, CONFIG.facilitiesLead);

  var recipients = recipientsFor_(answers.leadership);
  var urgent = isUrgent_(answers.priority);
  var subject = (urgent ? '[URGENT] ' : '') + ticket + ': ' +
    describe_(answers) + ' needs maintenance';

  // The sort below lifts this request to the top of the log (row 2); point the
  // link there, so it lands on the request the email is about.
  var link = rowUrl_(sheet, 2);
  MailApp.sendEmail({
    to: recipients.join(','),
    replyTo: answers.email || undefined,
    subject: subject,
    body: plainBody_(ticket, answers, link),
    htmlBody: htmlBody_(ticket, answers, link, urgent),
    name: 'Equipment Maintenance Log'
  });

  // Last of all: keep the newest request at the top so nobody scrolls years of
  // history to find today's. After the email — so a retry from a failed send
  // re-runs against a row that has not moved — and a sort failure never blocks
  // the notification, only the ordering.
  try { sortNewestFirst_(sheet); } catch (err) { /* the request is still filed */ }

  return ticket;
}

/** Runs on every manual edit; only acts when a Status changes to a closed value. */
function onMaintenanceEdit(e) {
  if (!CONFIG.notifyOnClose || !e || !e.range) return;

  var sheet = e.range.getSheet();
  var headers = headerRow_(sheet);
  var statusCol = headers.indexOf(STATUS_COL) + 1;
  if (statusCol === 0) return;
  if (e.range.getColumn() !== statusCol || e.range.getRow() < 2) return;

  var value = String(e.range.getValue()).trim();
  if (value !== 'Done' && value !== 'Not needed') return;

  // Re-picking "Done" on a request that was already closed still fires an edit.
  // Without this the whole notify list gets a second copy of the same email.
  var previous = String(e.oldValue === undefined ? '' : e.oldValue).trim();
  if (previous === 'Done' || previous === 'Not needed') return;

  notifyClosed_(sheet, e.range.getRow(), value);
}

/**
 * Stamp the close date and tell everyone the request is finished.
 *
 * Called from the edit trigger and from the web app. The web app has to call it
 * explicitly: an installable onEdit trigger does not fire for changes a script
 * makes, so closing a request in the app would otherwise notify nobody.
 */
function notifyClosed_(sheet, row, value) {
  if (!CONFIG.notifyOnClose) return;

  var answers = readAnswers_(null, sheet, row);
  var ticket = readCell_(sheet, row, TICKET_COL) || '(no ticket)';

  writeCell_(sheet, row, CLOSED_COL, new Date());

  var notes = readCell_(sheet, row, NOTES_COL);
  var closedBy = Session.getActiveUser().getEmail();

  MailApp.sendEmail({
    to: recipientsFor_(answers.leadership).join(','),
    subject: ticket + ' closed (' + value + '): ' + describe_(answers),
    body: [
      ticket + ' has been marked "' + value + '".',
      '',
      'Equipment:   ' + describe_(answers),
      'Problem:   ' + (answers.problem || '-'),
      'Notes:     ' + (notes || '(none recorded)'),
      'Closed by: ' + (closedBy || 'unknown'),
      '',
      rowUrl_(sheet, row)
    ].join('\n'),
    name: 'Equipment Maintenance Log'
  });
}

// ===========================================================================
// Reading the response
// ===========================================================================

/**
 * Pull the answers we care about, preferring the trigger's namedValues and
 * falling back to reading the row (so this also works when called by hand).
 */
function readAnswers_(e, sheet, row) {
  var named = e && e.namedValues ? e.namedValues : rowAsNamedValues_(sheet, row);
  var q = CONFIG.questions;
  return {
    equipment: lookup_(named, q.equipment),
    item: lookup_(named, q.item),
    leadership: lookup_(named, q.leadership),
    priority: lookup_(named, q.priority),
    problem: lookup_(named, q.problem),
    reportedBy: lookup_(named, q.reportedBy),
    email: (e && e.response ? tryRespondentEmail_(e) : '') || lookup_(named, 'Email Address'),
    timestamp: lookup_(named, 'Timestamp') || new Date(),
    photo: lookup_(named, PHOTO_COL),
    extras: extraAnswers_(named)
  };
}

function rowAsNamedValues_(sheet, row) {
  var headers = headerRow_(sheet);
  if (!headers.length) return {};
  var values = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
  var out = {};
  headers.forEach(function (h, i) { out[h] = [values[i]]; });
  return out;
}

/**
 * Header matching that tolerates case and trailing punctuation differences.
 * `title` may be a list of acceptable wordings, tried in order.
 */
function lookup_(named, title) {
  if (!title) return '';
  var wanted = titleList_(title);
  var keys = Object.keys(named);

  for (var w = 0; w < wanted.length; w++) {
    var want = normalise_(wanted[w]);
    for (var i = 0; i < keys.length; i++) {
      if (normalise_(keys[i]) === want) {
        var v = named[keys[i]];
        return String(Array.isArray(v) ? v.join(', ') : v).trim();
      }
    }
  }
  return '';
}

function titleList_(title) {
  return Array.isArray(title) ? title : [title];
}

/**
 * The column header actually present in the sheet for a question, given that
 * the question may have several accepted wordings. Falls back to the preferred
 * wording so callers always get a usable string.
 */
function headerFor_(headers, title) {
  var wanted = titleList_(title);
  for (var w = 0; w < wanted.length; w++) {
    for (var i = 0; i < headers.length; i++) {
      if (normalise_(headers[i]) === normalise_(wanted[w])) return headers[i];
    }
  }
  return wanted[0];
}

/**
 * What to call this request in an email subject or on a card.
 *
 * A request against the catch-all bucket says only "General equipment", which
 * tells the Facilities Lead nothing — a cracked ladder rung and a pallet jack
 * that will not lift are not the same job. So for that bucket the item answer
 * becomes the headline, and its absence is stated rather than left blank.
 */
function describe_(answers) {
  var equipment = String(answers.equipment || '').trim();
  var item = String(answers.item || '').trim();

  if (!isGeneral_(equipment)) return equipment || 'Equipment';
  if (item) return item + ' (' + equipment + ')';
  return equipment + ' — item not specified';
}

function isGeneral_(equipment) {
  return normalise_(equipment) === normalise_(CONFIG.generalEquipment);
}

function normalise_(s) {
  return String(s).toLowerCase().replace(/[\s\?\:\.\*]+/g, ' ').trim();
}

/** Any answers that are not one of the known questions, so nothing is lost. */
function extraAnswers_(named) {
  var known = [];
  Object.keys(CONFIG.questions).forEach(function (k) {
    // A question may have several accepted wordings; all of them count as known.
    titleList_(CONFIG.questions[k]).forEach(function (title) { known.push(normalise_(title)); });
  });
  known.push('timestamp', 'email address');
  [TICKET_COL, STATUS_COL, ASSIGNED_COL, CLOSED_COL, NOTES_COL, PHOTO_COL].forEach(function (c) {
    known.push(normalise_(c));
  });

  var out = [];
  Object.keys(named).forEach(function (key) {
    if (known.indexOf(normalise_(key)) !== -1) return;
    var v = named[key];
    var text = String(Array.isArray(v) ? v.join(', ') : v).trim();
    if (text) out.push({ label: key, value: text });
  });
  return out;
}

function tryRespondentEmail_(e) {
  try {
    return e.response.getRespondentEmail() || '';
  } catch (err) {
    return '';
  }
}

// ===========================================================================
// Recipients, tickets, cells
// ===========================================================================

/** Facilities Lead + Owner always, plus the selected Leadership Team member. */
function recipientsFor_(leadershipAnswer) {
  var list = [CONFIG.facilitiesLead, CONFIG.owner];
  var picked = CONFIG.leadership[String(leadershipAnswer).trim()];

  if (picked) {
    list.push(picked);
  } else if (leadershipAnswer && /any|no preference|whoever/i.test(leadershipAnswer)) {
    Object.keys(CONFIG.leadership).forEach(function (k) { list.push(CONFIG.leadership[k]); });
  } else {
    list.push(CONFIG.leadershipFallback);
  }

  // De-duplicate, drop blanks and any address left as an example.
  var seen = {};
  return list.filter(function (addr) {
    var a = String(addr || '').trim().toLowerCase();
    if (!a || a.indexOf('@') === -1 || seen[a]) return false;
    seen[a] = true;
    return true;
  });
}

/** Sequential ticket ID based on the row number, e.g. MNT-0007. */
/**
 * One past the highest number ever issued.
 *
 * Deliberately not derived from the row number. Deleting a row shifts every row
 * below it up, so a row-based ID would hand the next request an ID an older
 * request already holds.
 *
 * The highest number still in the sheet is not enough on its own either:
 * deleting the newest request would drop the ceiling and the next request would
 * reuse its number. A stored high-water mark remembers the ceiling across
 * deletions, so a ticket number is never handed out twice — which matters
 * because the app finds the row to update by ticket.
 */
function nextTicketId_(sheet) {
  var headers = headerRow_(sheet);
  var col = headers.indexOf(TICKET_COL) + 1;
  var lastRow = sheet.getLastRow();
  var highest = 0;

  if (col > 0 && lastRow > 1) {
    var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      var found = /(\d+)\s*$/.exec(String(values[i][0]).trim());
      if (found) highest = Math.max(highest, parseInt(found[1], 10));
    }
  }

  var stored = 0;
  try {
    stored = parseInt(PropertiesService.getScriptProperties().getProperty('lastTicket'), 10) || 0;
  } catch (err) { /* fall back to the sheet's ceiling */ }

  var next = Math.max(highest, stored) + 1;
  try {
    PropertiesService.getScriptProperties().setProperty('lastTicket', String(next));
  } catch (err) { /* the sheet's ceiling still moves us forward next time */ }

  // Pad to four digits without truncating: slicing the last four characters
  // would turn ticket 10000 into "0000" and collide forever after.
  var digits = String(next);
  while (digits.length < 4) digits = '0' + digits;

  return CONFIG.ticketPrefix + '-' + digits;
}

/**
 * The header row, or an empty list for a sheet with nothing in it.
 *
 * The edit trigger fires for every tab in the file, including blank ones a
 * user just added, and getRange(1, 1, 1, 0) is an error rather than an empty
 * range — without this guard, clearing a cell on an empty tab throws and
 * Google mails the owner a failure notice.
 */
function headerRow_(sheet) {
  // Memoised for the life of one execution. Every readCell_/writeCell_ needs
  // the header row to find its column, so a single form submission was reading
  // row 1 half a dozen times over. Nothing else changes the headers mid-run
  // except addTrackingColumns_, which clears this explicitly.
  var key = sheet.getSheetId();
  if (HEADER_CACHE[key]) return HEADER_CACHE[key];

  var lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) return [];

  var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  HEADER_CACHE[key] = headers;
  return headers;
}

var HEADER_CACHE = {};

/** Call after changing the header row, so the next read sees the new columns. */
function forgetHeaders_() {
  HEADER_CACHE = {};
}

function writeCell_(sheet, row, headerName, value) {
  var col = headerRow_(sheet).indexOf(headerName) + 1;
  if (col === 0) return;
  sheet.getRange(row, col).setValue(value);
}

function readCell_(sheet, row, headerName) {
  var col = headerRow_(sheet).indexOf(headerName) + 1;
  if (col === 0) return '';
  return String(sheet.getRange(row, col).getValue()).trim();
}

function rowUrl_(sheet, row) {
  return SpreadsheetApp.getActive().getUrl() + '#gid=' + sheet.getSheetId() +
    '&range=A' + row;
}

/**
 * Order the log newest first, by the Timestamp column, keeping the header row
 * in place. Whole rows move together, so every tracking column travels with its
 * request.
 *
 * Because rows move, nothing may treat a row number as a permanent handle for a
 * request — updateRequest looks a request up by its ticket for exactly this
 * reason.
 */
function sortNewestFirst_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 3 || lastCol < 1) return;   // 0 or 1 data rows: already in order

  var headers = headerRow_(sheet);
  var tsCol = headers.indexOf('Timestamp') + 1;
  if (tsCol < 1) tsCol = 1;                  // Timestamp is column A on a Forms sheet
  sheet.getRange(2, 1, lastRow - 1, lastCol).sort({ column: tsCol, ascending: false });
}

function isUrgent_(priority) {
  var p = String(priority).trim().toLowerCase();
  return CONFIG.urgentAnswers.some(function (u) {
    return p === String(u).trim().toLowerCase();
  });
}

// ===========================================================================
// Email bodies
// ===========================================================================

function plainBody_(ticket, a, link) {
  var lines = [
    ticket + ' - maintenance request',
    '',
    'Equipment:     ' + (a.equipment || '-'),
    'Item:          ' + (a.item || (isGeneral_(a.equipment) ? 'NOT SPECIFIED' : '-')),
    'Urgency:     ' + (a.priority || '-'),
    'Reported by: ' + (a.reportedBy || a.email || 'not given'),
    'Filed:       ' + formatWhen_(a.timestamp),
    '',
    'Problem:',
    a.problem || '(no description given)'
  ];

  a.extras.forEach(function (x) {
    lines.push('', x.label + ':', x.value);
  });

  if (a.photo) lines.push('', 'Photo:', a.photo);

  lines.push('', 'Open the log to update the status:', link);
  return lines.join('\n');
}

function htmlBody_(ticket, a, link, urgent) {
  var esc = function (s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  var rows = [
    ['Equipment', a.equipment],
    ['Item', a.item || (isGeneral_(a.equipment) ? 'Not specified' : '')],
    ['Urgency', a.priority],
    ['Reported by', a.reportedBy || a.email || 'not given'],
    ['Filed', formatWhen_(a.timestamp)]
  ];
  a.extras.forEach(function (x) { rows.push([x.label, x.value]); });

  var tableRows = rows.map(function (r) {
    if (!r[1]) return '';
    return '<tr>' +
      '<td style="padding:6px 14px 6px 0;color:#5f6b66;white-space:nowrap;vertical-align:top">' +
      esc(r[0]) + '</td>' +
      '<td style="padding:6px 0;font-weight:600">' + esc(r[1]) + '</td></tr>';
  }).join('');

  // A photo is the reason someone bothered to take one: it has to be one tap
  // away, not a URL printed as text in a table cell.
  var photoBlock = a.photo
    ? '<p style="margin:0 0 18px"><a href="' + esc(a.photo) + '" ' +
      'style="display:inline-block;border:1px solid #d7ded9;border-radius:6px;' +
      'padding:8px 14px;color:#2f6f4e;text-decoration:none;font-weight:600;font-size:14px">' +
      'View the photo</a></p>'
    : '';

  return '' +
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'max-width:560px;color:#1c2321;line-height:1.5">' +
      (urgent
        ? '<p style="background:#fdecea;border-left:4px solid #c0392b;padding:10px 14px;' +
          'margin:0 0 16px;font-weight:700;color:#8e2a1c">Urgent — this machine should not be used ' +
          'until it is looked at.</p>'
        : '') +
      '<h2 style="margin:0 0 4px;font-size:18px">' + esc(ticket) + ' — ' +
        esc(describe_(a)) + '</h2>' +
      '<p style="margin:0 0 18px;color:#5f6b66;font-size:14px">A new maintenance request was ' +
        'filed from the QR code on the machine.</p>' +
      '<table style="border-collapse:collapse;font-size:14px;margin-bottom:18px">' +
        tableRows +
      '</table>' +
      '<div style="background:#f6f8f6;border:1px solid #d7ded9;border-radius:8px;padding:14px;' +
        'margin-bottom:20px">' +
        '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;' +
          'color:#5f6b66;margin-bottom:6px">Problem</div>' +
        '<div style="white-space:pre-wrap">' + esc(a.problem || '(no description given)') + '</div>' +
      '</div>' +
      photoBlock +
      '<a href="' + link + '" ' +
        'style="display:inline-block;background:#2f6f4e;color:#fff;text-decoration:none;' +
        'font-weight:600;padding:10px 18px;border-radius:6px">Open the maintenance log</a>' +
      '<p style="color:#8a948f;font-size:12px;margin-top:22px">Set the Status column to ' +
        '"Done" when the work is finished and everyone on this email is notified.</p>' +
    '</div>';
}

function formatWhen_(value) {
  var date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'EEE d MMM yyyy, h:mm a');
}

// ===========================================================================
// Mobile web app
//
// Deploy -> New deployment -> Web app. Google hosts it for free. The URL it
// gives you can be added to a phone's home screen and behaves like an app.
// ===========================================================================

/**
 * Serves the mobile page. Requires an HTML file named "webapp" in this project.
 *
 * The QR sticker on each machine carries ?equipment=<name>. The page itself
 * runs in a sandboxed iframe and cannot see the address bar, so the value is
 * read here and baked into the markup for the app to pick up.
 */
function doGet(e) {
  var template = HtmlService.createTemplateFromFile('webapp');
  var asked = (e && e.parameter && e.parameter.equipment) || '';

  // Only accept a machine we actually know about, so a doctored link cannot
  // put arbitrary text on the screen.
  template.scannedEquipment = equipmentList_().indexOf(asked) === -1 ? '' : asked;

  return template.evaluate()
    .setTitle('Millcreek Equipment Maintenance')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Every row of the log, parsed once, newest first.
 *
 * The history, search and dashboard endpoints all need the whole log, and
 * reading the sheet cell by cell is the usual reason an Apps Script web app
 * feels slow. One getValues() call, one pass, shared by everything below.
 */
function logSnapshot_() {
  var sheet = responseSheet_();
  var headers = headerRow_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2 || !headers.length) return { requests: [], equipmentList: [] };

  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var q = CONFIG.questions;

  var at = {};
  headers.forEach(function (h, i) { at[h] = i; });
  var get = function (rowValues, header) {
    var i = at[header];
    return i === undefined ? '' : rowValues[i];
  };

  var equipmentHeader = headerFor_(headers, q.equipment);
  var itemHeader = headerFor_(headers, q.item);

  var requests = [];
  var equipment = {};

  for (var r = 0; r < values.length; r++) {
    var v = values[r];
    var name = String(get(v, equipmentHeader) || '').trim();
    if (name) equipment[name] = true;

    var item = String(get(v, itemHeader) || '').trim();
    var status = String(get(v, STATUS_COL) || 'Open').trim() || 'Open';
    var reportedAt = asTime_(get(v, 'Timestamp'));
    var closedAt = asTime_(get(v, CLOSED_COL));
    var closed = (status === 'Done' || status === 'Not needed');

    requests.push({
      row: r + 2,
      ticket: String(get(v, TICKET_COL) || ''),
      equipment: name,
      item: item,
      // What a card shows as its heading: for the catch-all bucket that is the
      // item, not the useless word "General equipment".
      label: describe_({ equipment: name, item: item }),
      general: isGeneral_(name),
      priority: String(get(v, q.priority) || '').trim(),
      problem: String(get(v, q.problem) || '').trim(),
      reportedBy: String(get(v, q.reportedBy) || '').trim(),
      status: status,
      notes: String(get(v, NOTES_COL) || ''),
      photo: String(get(v, PHOTO_COL) || '').trim(),
      urgent: isUrgent_(get(v, q.priority)),
      closed: closed,
      reportedAt: reportedAt,
      closedAt: closed ? closedAt : null,
      when: reportedAt ? formatWhen_(new Date(reportedAt)) : '',
      closedWhen: (closed && closedAt) ? formatWhen_(new Date(closedAt)) : ''
    });
  }

  // Newest first, ordered by when each was reported — not by physical row order,
  // which now changes as the sheet is kept sorted (and which a manual re-sort or
  // a partial sort could leave in any state). Ties — the same second, or a row
  // with no timestamp — fall back to the ticket number, which only ever climbs.
  requests.sort(function (a, b) {
    var byTime = (b.reportedAt || 0) - (a.reportedAt || 0);
    return byTime || (ticketNumber_(b.ticket) - ticketNumber_(a.ticket));
  });

  return { requests: requests, equipmentList: Object.keys(equipment).sort() };
}

/** The trailing number in a ticket like MNT-0007, or 0 if there isn't one. */
function ticketNumber_(ticket) {
  var m = /(\d+)\s*$/.exec(String(ticket || ''));
  return m ? parseInt(m[1], 10) : 0;
}

/** Milliseconds for a cell that may hold a Date, a string, or nothing. */
function asTime_(value) {
  if (!value) return null;
  var date = (value instanceof Date) ? value : new Date(value);
  var time = date.getTime();
  return isNaN(time) ? null : time;
}

var DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between two instants, never negative. */
function daysBetween_(fromTime, toTime) {
  if (!fromTime || !toTime) return 0;
  return Math.max(0, Math.floor((toTime - fromTime) / DAY_MS));
}

/**
 * The Open tab: every unresolved request, plus a bounded tail of recent closed
 * ones. Without the cap the payload grows with the log forever.
 */
function getRequests() {
  var cached = cacheGet_('open');
  if (cached) return cached;

  var built = buildOpenList_();
  cachePut_('open', built, 90);
  return built;
}

function buildOpenList_() {
  var snapshot = logSnapshot_();
  var limit = CONFIG.closedHistoryShown;
  if (typeof limit !== 'number' || limit < 0) limit = 50;

  var out = [];
  var closedShown = 0;
  var closedHidden = 0;

  snapshot.requests.forEach(function (request) {
    if (request.closed) {
      if (closedShown >= limit) { closedHidden++; return; }
      closedShown++;
    }
    out.push(request);
  });

  return {
    requests: out,
    equipmentList: snapshot.equipmentList,
    categories: groupEquipment_(snapshot.equipmentList),
    statuses: STATUS_OPTIONS,
    formUrl: CONFIG.formUrl || '',
    closedHidden: closedHidden
  };
}

/**
 * The History tab: the full service record, optionally for one machine,
 * returned a page at a time so a five-year log never lands on a phone at once.
 */
function getHistory(options) {
  options = options || {};
  var wanted = String(options.equipment || '').trim();
  var wantedCat = String(options.category || '').trim();
  var offset = Math.max(0, Number(options.offset) || 0);
  var limit = Math.min(Math.max(Number(options.limit) || 25, 1), 100);

  // Paging through history and switching between machines walks the same few
  // pages over and over, and each one otherwise re-reads the whole log. The key
  // carries the generation, so a new ticket still shows up straight away.
  var key = 'hist:' + wanted + '|' + wantedCat + ':' + offset + ':' + limit;
  var cached = cacheGet_(key);
  if (cached) return cached;

  var byCategory = wantedCat && wantedCat !== 'All' && (!wanted || wanted === 'All');
  var snapshot = logSnapshot_();
  var matching = snapshot.requests.filter(function (request) {
    if (wanted && wanted !== 'All') return request.equipment === wanted;   // one machine
    if (byCategory) return categoryOf_(request.equipment) === wantedCat;    // a whole category
    return true;
  });

  var page = {
    requests: matching.slice(offset, offset + limit),
    total: matching.length,
    offset: offset,
    hasMore: offset + limit < matching.length,
    equipmentList: snapshot.equipmentList,
    categories: groupEquipment_(snapshot.equipmentList)
  };
  cachePut_(key, page, 300);
  return page;
}

/**
 * Search the whole log, not just what the phone already holds.
 *
 * Matches across ticket, equipment, item, problem, reporter and work notes.
 * Every word has to match somewhere, so "tractor brake" narrows rather than
 * widening the way a plain substring search would.
 */
function searchRequests(options) {
  options = options || {};
  var query = String(options.query || '').trim();
  var limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  if (!query) return { requests: [], total: 0, query: '', hasMore: false };

  var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  var snapshot = logSnapshot_();

  var matching = snapshot.requests.filter(function (request) {
    var haystack = [
      request.ticket, request.equipment, request.item, request.problem,
      request.reportedBy, request.notes, request.status, request.priority
    ].join(' ').toLowerCase();

    // "7", "MNT-7" and "mnt-0007" should all find ticket MNT-0007.
    var ticketNumber = (/(\d+)\s*$/.exec(request.ticket) || [])[1];
    var ticketPlain = ticketNumber ? String(parseInt(ticketNumber, 10)) : '';

    return terms.every(function (term) {
      if (haystack.indexOf(term) !== -1) return true;
      var asNumber = term.replace(/^[a-z]+-?/, '').replace(/^0+/, '');
      return !!ticketPlain && asNumber === ticketPlain;
    });
  });

  return {
    requests: matching.slice(0, limit),
    total: matching.length,
    query: query,
    hasMore: matching.length > limit
  };
}

/**
 * The Dashboard tab. Everything is reduced to totals on the server: shipping
 * the whole log to a phone so it can count rows would undo the payload cap.
 */
function getDashboard() {
  var cached = cacheGet_('dashboard');
  if (cached) return cached;
  var built = buildDashboard_();
  cachePut_('dashboard', built, 90);
  return built;
}

/**
 * A small cache in front of the expensive reads.
 *
 * Every write bumps a generation counter that is part of the key, so a new
 * ticket or a status change invalidates instantly rather than leaving someone
 * looking at numbers that disagree with the list they just changed.
 */
var GENERATION = null;
var BUMPS = 0;

function cacheGeneration_() {
  // Read once per execution. Script properties are among the slowest calls
  // available here, and this was being read twice for every cached lookup.
  if (GENERATION !== null) return GENERATION;
  try {
    GENERATION = PropertiesService.getScriptProperties().getProperty('gen') || '0';
  } catch (err) {
    GENERATION = '0';
  }
  return GENERATION;
}

function bumpGeneration_() {
  // A timestamp rather than a counter, so invalidating costs one write and no
  // read: we never need to know what the old value was. The suffix matters —
  // a create and a status change can land in the same millisecond, and two
  // identical stamps would hand the second one the first one's cached numbers.
  try {
    var stamp = Date.now() + '.' + (++BUMPS);
    PropertiesService.getScriptProperties().setProperty('gen', stamp);
    GENERATION = stamp;
  } catch (err) { /* cache just stays warm a little longer */ }
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
    var json = JSON.stringify(value);
    if (json.length > 90000) return;   // CacheService caps entries at 100KB
    CacheService.getScriptCache().put(name + ':' + cacheGeneration_(), json, seconds);
  } catch (err) { /* not worth failing a request over */ }
}

function buildDashboard_() {
  var snapshot = logSnapshot_();
  var now = Date.now();
  var windowDays = CONFIG.dashboardWindowDays;
  if (typeof windowDays !== 'number' || windowDays < 1) windowDays = 365;
  var windowStart = now - windowDays * DAY_MS;

  var byStatus = {};
  var openByStatus = {};
  STATUS_OPTIONS.forEach(function (status) { byStatus[status] = 0; openByStatus[status] = 0; });

  var open = [];
  var perEquipment = {};

  snapshot.requests.forEach(function (request) {
    if (byStatus[request.status] === undefined) byStatus[request.status] = 0;
    byStatus[request.status]++;

    var name = request.equipment || 'Not given';
    if (!perEquipment[name]) {
      perEquipment[name] = { equipment: name, total: 0, recent: 0, open: 0, downDays: 0 };
    }
    var stats = perEquipment[name];
    stats.total++;
    if (request.reportedAt && request.reportedAt >= windowStart) stats.recent++;
    if (!request.closed) {
      stats.open++;
      open.push(request);
      if (openByStatus[request.status] === undefined) openByStatus[request.status] = 0;
      openByStatus[request.status]++;
    }

    // Downtime: how long a machine was unusable, counted only for the reports
    // that actually take it out of service. Still-open ones count to today.
    if (request.urgent && request.reportedAt) {
      var until = request.closed ? (request.closedAt || request.reportedAt) : now;
      if (until >= windowStart) stats.downDays += daysBetween_(request.reportedAt, until);
    }
  });

  open.sort(function (a, b) { return (a.reportedAt || 0) - (b.reportedAt || 0); });

  var agingDays = CONFIG.agingAfterDays;
  if (typeof agingDays !== 'number' || agingDays < 1) agingDays = 7;

  var aging = 0;
  var urgentOpen = 0;
  open.forEach(function (request) {
    if (request.reportedAt && daysBetween_(request.reportedAt, now) >= agingDays) aging++;
    if (request.urgent) urgentOpen++;
  });

  var downNow = open.filter(function (request) { return request.urgent; })
    .map(function (request) {
      return {
        ticket: request.ticket,
        label: request.label,
        equipment: request.equipment,
        priority: request.priority,
        days: request.reportedAt ? daysBetween_(request.reportedAt, now) : 0
      };
    });

  var offenders = Object.keys(perEquipment).map(function (name) { return perEquipment[name]; });
  offenders.sort(function (a, b) {
    return (b.recent - a.recent) || (b.total - a.total) || a.equipment.localeCompare(b.equipment);
  });

  var downtime = offenders.filter(function (stats) { return stats.downDays > 0; })
    .slice()
    .sort(function (a, b) { return b.downDays - a.downDays; });

  var oldest = open.length ? open[0] : null;

  return {
    generatedAt: formatWhen_(new Date(now)),
    windowDays: windowDays,
    agingAfterDays: agingDays,
    backlog: {
      open: open.length,
      urgent: urgentOpen,
      aging: aging,
      total: snapshot.requests.length,
      byStatus: STATUS_OPTIONS.map(function (status) {
        return { status: status, count: byStatus[status] || 0 };
      }),
      // Only the live states. A ring of every status ever is 90% "Done" and
      // says nothing about whether the backlog is under control.
      openByStatus: STATUS_OPTIONS
        .filter(function (status) { return status !== 'Done' && status !== 'Not needed'; })
        .map(function (status) { return { status: status, count: openByStatus[status] || 0 }; }),
      oldest: oldest ? {
        ticket: oldest.ticket,
        label: oldest.label,
        days: oldest.reportedAt ? daysBetween_(oldest.reportedAt, now) : 0,
        status: oldest.status
      } : null
    },
    downNow: downNow,
    offenders: offenders.slice(0, 8),
    downtime: downtime.slice(0, 8)
  };
}

/**
 * The signed-in viewer's work address, or '' if we cannot tell.
 *
 * Returns nothing rather than guessing: getEffectiveUser() would hand back the
 * script owner, which would stamp every crew member's ticket with your name.
 */
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

/**
 * What the app needs to build its Create Ticket form. Driven by CONFIG rather
 * than by what happens to be in the log already, so a machine that has never
 * broken still appears in the list.
 */
function getFormOptions() {
  var leadership = Object.keys(CONFIG.leadership || {});
  return {
    equipment: equipmentList_(),
    urgency: (CONFIG.urgencyOptions || []).slice(),
    leadership: leadership.concat(['Any / no preference']),
    generalEquipment: CONFIG.generalEquipment || '',
    urgentAnswers: (CONFIG.urgentAnswers || []).slice(),
    itemQuestion: titleList_(CONFIG.questions.item)[0],
    photosEnabled: true,
    formUrl: CONFIG.formUrl || '',
    viewerEmail: viewerEmail_()
  };
}

/**
/**
 * Keep a typed-in value from acting as a spreadsheet formula.
 *
 * A description of "=IMPORTDATA(...)" would run as a live formula the moment
 * the owner opened the raw sheet — a way to pull other cells out to an outside
 * URL. Leading a suspect value with an apostrophe forces the cell to stay text.
 * The app itself already shows every value as escaped text, so this is only for
 * the sheet; only strings are touched, so dates and numbers are untouched.
 */
function plainText_(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

/**
 * Create a ticket from the app.
 *
 * Appends a row to the same sheet the form writes to, matching by header name
 * rather than by position so a reordered form cannot scatter the answers, then
 * hands off to the shared processNewRequest_ for the ticket and the emails.
 * The form's own trigger does not fire for rows a script appends, which is
 * exactly why that work is shared rather than living in the trigger.
 */
function createRequest(payload) {
  payload = payload || {};

  var equipment = String(payload.equipment || '').trim();
  var priority = String(payload.priority || '').trim();
  var problem = String(payload.problem || '').trim();
  var reportedBy = String(payload.reportedBy || '').trim();
  var leadership = String(payload.leadership || '').trim();
  var item = String(payload.item || '').trim();

  var known = equipmentList_();
  if (!known.length) {
    throw new Error('No equipment is set up yet. Add machines to the "' +
      EQUIPMENT_TAB + '" tab of the log, one per row.');
  }
  if (!equipment) throw new Error('Choose which equipment this is about.');
  if (known.indexOf(equipment) === -1) {
    throw new Error('"' + equipment + '" is not on the ' + EQUIPMENT_TAB +
      ' tab. Add it there, or pick one of: ' + known.join(', '));
  }
  if (!priority) throw new Error('Choose how urgent it is.');
  if ((CONFIG.urgencyOptions || []).indexOf(priority) === -1) {
    throw new Error('Unknown urgency: ' + priority);
  }
  if (!problem) throw new Error('Describe what needs attention.');
  if (!reportedBy) throw new Error('Add your name so someone can follow up.');
  if (isGeneral_(equipment) && !item) {
    throw new Error('For general equipment, say which item it is and where.');
  }

  var sheet = responseSheet_();
  var headers = headerRow_(sheet);
  if (!headers.length) throw new Error('The log has no header row. Run setUp first.');

  var q = CONFIG.questions;
  var whoEmail = viewerEmail_();
  var values = {};
  values['Timestamp'] = new Date();
  // Taken from the session, not from the payload: it is the one field nobody
  // should be able to put someone else's name in.
  if (whoEmail) values['Email Address'] = whoEmail;

  // headerFor_ falls back to the preferred wording when nothing in the sheet
  // matches, and the positional append below drops any value whose header is
  // not really there. Renaming a question on the form used to file a ticket
  // with a blank machine on it and email everyone about nothing, so say which
  // column is missing instead of writing an empty row.
  var missing = [];
  var put = function (question, value) {
    var header = headerFor_(headers, question);
    if (headers.indexOf(header) === -1) { missing.push('"' + header + '"'); return; }
    values[header] = plainText_(value);
  };
  put(q.equipment, equipment);
  put(q.priority, priority);
  put(q.problem, problem);
  put(q.reportedBy, reportedBy);
  if (missing.length) {
    throw new Error('The log has no ' + missing.join(' or ') + ' column, so this request ' +
      'cannot be filed. The log currently has: ' + headers.join(', ') + '. Rename the ' +
      'column to match, or update CONFIG.questions in the script.');
  }
  // Optional, so a sheet without them just carries less detail.
  put(q.item, item);
  put(q.leadership, leadership);

  // One append, built positionally from the header row.
  var rowValues = headers.map(function (header) {
    return values[header] === undefined ? '' : values[header];
  });

  var row = withLock_(function () {
    sheet.appendRow(rowValues);
    return sheet.getLastRow();
  });

  // Only once the request is safely on the sheet. Saving first left a photo
  // orphaned in Drive whenever the append failed, and losing the photo is a
  // far smaller problem than losing the request, so this never throws.
  var photoUrl = '';
  var photoError = '';
  if (payload.photo && payload.photo.data) {
    try {
      photoUrl = savePhoto_(payload.photo, equipment);
      if (headers.indexOf(PHOTO_COL) !== -1) writeCell_(sheet, row, PHOTO_COL, photoUrl);
    } catch (err) {
      photoError = 'The ticket was filed, but the photo did not upload.';
    }
  }

  var answers = readAnswers_(null, sheet, row);
  // processNewRequest_ invalidates the cache; both routes go through it.
  var ticket = processNewRequest_(sheet, row, answers);

  return { ok: true, ticket: ticket, row: row, photoUrl: photoUrl,
           photoError: photoError, reportedByEmail: whoEmail };
}

/**
 * Put an attached photo in Drive and return a link to it.
 *
 * Files are named after the ticket's machine and the date so the folder stays
 * browsable. A folder pinned by ID in CONFIG is used as-is; otherwise one is
 * found or created by name. Link sharing is on by default because the people
 * who get the email are not all in this Drive — turn it off in CONFIG if you
 * would rather share the folder by hand.
 */
function savePhoto_(photo, equipment) {
  var folder = photoFolder_();

  var mime = String(photo.mimeType || 'image/jpeg');
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
  var extension = (/\/(\w+)$/.exec(mime) || [])[1] || 'jpg';
  var name = equipment + ' ' + stamp + '.' + extension;

  var blob = Utilities.newBlob(Utilities.base64Decode(photo.data), mime, name);
  var file = folder.createFile(blob);

  if (CONFIG.photoLinkSharing !== false) {
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      // A domain that forbids link sharing should not lose the whole request.
    }
  }
  return file.getUrl();
}

/**
 * The folder photos go into: a folder pinned by ID if CONFIG.photoFolderId is
 * set, otherwise found-or-created by name.
 *
 * A bad or inaccessible ID throws from getFolderById, which would lose the
 * photo silently on the by-name path; catch it and fall back so a mistyped ID
 * is a folder-in-the-wrong-place problem, not a lost-photo one.
 */
function photoFolder_() {
  var id = String(CONFIG.photoFolderId || '').trim();
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (err) {
      // Fall through to the named folder below rather than dropping the photo.
    }
  }
  var folderName = CONFIG.photoFolder || 'Equipment maintenance photos';
  var folders = DriveApp.getFoldersByName(folderName);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
}

/**
 * The row a ticket is on right now.
 *
 * Rows move — the log re-sorts newest-first on every submission, and deleting a
 * row shifts everything below it up — so the row number a phone loaded with is
 * only a hint. The ticket is the stable handle: trust the hint when it still
 * holds that ticket, otherwise find it. Returns 0 if the ticket is gone.
 *
 * With no ticket to go on, the hint is all there is, so it is trusted as-is.
 */
function resolveRow_(sheet, ticket, hintRow) {
  var last = sheet.getLastRow();
  var hintOk = hintRow >= 2 && hintRow <= last;
  if (!ticket) return hintOk ? hintRow : 0;
  if (hintOk && readCell_(sheet, hintRow, TICKET_COL) === ticket) return hintRow;

  var col = headerRow_(sheet).indexOf(TICKET_COL) + 1;
  if (col < 1 || last < 2) return 0;
  var values = sheet.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === ticket) return i + 2;
  }
  return 0;
}

/**
 * Update one request from the web app.
 *
 * The request is found by its ticket, not by the row number the phone happened
 * to load it at: the log re-sorts on every submission and rows can be deleted,
 * so the row is only a hint. If the ticket is gone, the update is refused rather
 * than written onto whatever request now sits at that row.
 */
function updateRequest(payload) {
  var sheet = responseSheet_();
  var ticket = String(payload && payload.ticket !== undefined ? payload.ticket : '').trim();

  if (!resolveRow_(sheet, ticket, Number(payload && payload.row))) {
    throw new Error('That request no longer exists. Pull down to refresh.');
  }

  var status = String(payload.status || '').trim();
  if (STATUS_OPTIONS.indexOf(status) === -1) {
    throw new Error('Unknown status: ' + status);
  }

  // Resolve again inside the lock and write there: a submission arriving at the
  // same moment may have just re-sorted the sheet and moved this ticket. The
  // lock also stops two phones both seeing it open and both emailing a close.
  var transition = withLock_(function () {
    var row = resolveRow_(sheet, ticket, Number(payload && payload.row));
    if (!row) throw new Error('That request no longer exists. Pull down to refresh.');
    var previous = readCell_(sheet, row, STATUS_COL);
    if (payload.notes !== undefined) writeCell_(sheet, row, NOTES_COL, plainText_(String(payload.notes)));
    writeCell_(sheet, row, STATUS_COL, status);
    return {
      row: row,
      closing: (status === 'Done' || status === 'Not needed'),
      wasClosed: (previous === 'Done' || previous === 'Not needed')
    };
  });

  bumpGeneration_();

  if (transition.closing && !transition.wasClosed) {
    notifyClosed_(sheet, transition.row, status);
  } else if (!transition.closing) {
    writeCell_(sheet, transition.row, CLOSED_COL, '');
  }

  return { ok: true, status: status };
}

// ===========================================================================
// Handy extras
// ===========================================================================

/**
 * Run this after pasting a new version in. It checks the things that are easy
 * to get wrong in CONFIG and quiet when they are wrong — an urgency listed in
 * urgentAnswers that no longer matches the options, a catch-all bucket that is
 * not one of the equipment choices, a column the app expects and cannot find.
 *
 * Returns the report as text so it shows in the execution log, and shows it in
 * the spreadsheet too.
 */
function healthCheck() {
  var problems = [];
  var notes = [];

  function placeholder(address) {
    return !address || /example\.com\s*$/i.test(String(address));
  }

  // --- who gets told ---
  if (placeholder(CONFIG.facilitiesLead)) problems.push('facilitiesLead is still the example address.');
  if (placeholder(CONFIG.owner)) problems.push('owner is still the example address.');
  var leadershipNames = Object.keys(CONFIG.leadership || {});
  if (!leadershipNames.length) problems.push('leadership is empty — nobody can be picked as the contact.');
  leadershipNames.forEach(function (name) {
    if (placeholder(CONFIG.leadership[name])) {
      problems.push('leadership["' + name + '"] is still an example address.');
    }
  });
  if (placeholder(CONFIG.leadershipFallback)) {
    problems.push('leadershipFallback is still the example address.');
  }

  // --- what the app offers ---
  var equipment = equipmentList_();
  var urgency = CONFIG.urgencyOptions || [];
  if (!equipment.length) {
    problems.push('No equipment anywhere — add machines to the "' + EQUIPMENT_TAB +
      '" tab, one per row. Create ticket has nothing to offer until you do.');
  } else {
    notes.push('Equipment (' + equipment.length + '): ' + equipment.join(', '));
  }
  if (!urgency.length) {
    problems.push('urgencyOptions is empty — Create ticket in the app will have nothing to choose.');
  }
  if (equipment.length && CONFIG.generalEquipment &&
      equipment.indexOf(CONFIG.generalEquipment) === -1) {
    problems.push('generalEquipment ("' + CONFIG.generalEquipment + '") is not on the ' +
      EQUIPMENT_TAB + ' tab, so the "which item" question will never appear.');
  }
  (CONFIG.urgentAnswers || []).forEach(function (answer) {
    if (urgency.length && urgency.indexOf(answer) === -1) {
      problems.push('urgentAnswers has "' + answer + '", which is not one of urgencyOptions — ' +
        'nothing will ever be flagged urgent by it.');
    }
  });

  // --- the sheet ---
  var sheet = null;
  try {
    sheet = responseSheet_();
  } catch (err) {
    problems.push(err.message);
  }

  if (sheet) {
    var headers = headerRow_(sheet);
    [TICKET_COL, STATUS_COL, ASSIGNED_COL, CLOSED_COL, NOTES_COL, PHOTO_COL].forEach(function (col) {
      if (headers.indexOf(col) === -1) problems.push('The log has no "' + col + '" column. Run setUp.');
    });

    var q = CONFIG.questions;
    ['equipment', 'priority', 'problem', 'reportedBy', 'leadership'].forEach(function (key) {
      var wanted = titleList_(q[key]);
      var found = headerFor_(headers, q[key]);
      if (headers.indexOf(found) === -1) {
        problems.push('No column matches the ' + key + ' question (' + wanted.join(' / ') + ').');
      }
    });
    if (headers.indexOf(headerFor_(headers, q.item)) === -1) {
      notes.push('No "which item" column yet. General-equipment requests will say ' +
        '"item not specified" until you add that question to the form.');
    }

    notes.push('Log: ' + sheet.getName() + ', ' + Math.max(sheet.getLastRow() - 1, 0) + ' requests.');
  }

  // --- the photo folder, if one is pinned by ID ---
  var folderId = String(CONFIG.photoFolderId || '').trim();
  if (folderId) {
    try {
      var pinned = DriveApp.getFolderById(folderId);
      notes.push('Photos go to the Drive folder "' + pinned.getName() + '".');
    } catch (err) {
      problems.push('photoFolderId "' + folderId + '" is not a folder this account can ' +
        'open. Photos would go to a folder named "' + (CONFIG.photoFolder || '') +
        '" instead. Check the ID, or that the folder is shared with whoever runs the app.');
    }
  }

  // --- triggers ---
  var installed = {};
  ScriptApp.getProjectTriggers().forEach(function (t) { installed[t.getHandlerFunction()] = true; });
  if (!installed.onMaintenanceSubmit) problems.push('The form-submit trigger is missing. Run setUp.');
  if (!installed.onMaintenanceEdit) problems.push('The edit trigger is missing. Run setUp.');

  var report = problems.length
    ? 'Found ' + problems.length + ' thing(s) to fix:\n\n• ' + problems.join('\n• ')
    : 'All good. Nothing in CONFIG or the log looks wrong.';
  if (notes.length) report += '\n\n' + notes.join('\n');

  // The trap this exists to stop people falling into twice.
  report += '\n\nThis checks the code in the editor. The app serves the last ' +
    'DEPLOYED version, so if you have edited CONFIG since deploying, the app is ' +
    'still running the old settings until you do Deploy > Manage deployments > ' +
    'edit > Version: New version. (The Equipment tab is the exception — that is ' +
    'read live and needs no redeploy.)';

  Logger.log(report);

  // Show the whole report where it was asked for: a dialog when run from the
  // spreadsheet menu, the execution log when run from the editor.
  try {
    var ui = SpreadsheetApp.getUi();
    ui.alert('Health check', report, ui.ButtonSet.OK);
  } catch (err) {
    try {
      SpreadsheetApp.getActive().toast(
        problems.length ? problems.length + ' problem(s) — see the execution log' : 'All good',
        'Health check', 8);
    } catch (err2) { /* running from the editor with no sheet attached */ }
  }

  return report;
}

/** Run by hand to check your CONFIG addresses without filing a real request. */
function sendTestEmail() {
  var recipients = recipientsFor_('');
  MailApp.sendEmail({
    to: recipients.join(','),
    subject: '[test] Equipment maintenance log is connected',
    body: 'If you are reading this, notifications are working.\n\n' +
      'Recipients on this test: ' + recipients.join(', ') + '\n\n' +
      'Note that a real request also emails the Leadership Team member the ' +
      'person picks on the form.',
    name: 'Equipment Maintenance Log'
  });
  SpreadsheetApp.getActive().toast('Test email sent to: ' + recipients.join(', '));
}

/** Adds an "Open requests" menu so the log is easy to filter from the sheet. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Maintenance')
    .addItem('Set up / repair triggers', 'setUp')
    .addItem('Health check', 'healthCheck')
    .addItem('Send test email', 'sendTestEmail')
    .addToUi();
}
