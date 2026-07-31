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

  // The catch-all bucket, for step stools, ladders, pallet jacks, hand tools
  // and anything else that breaks too rarely to deserve its own QR code.
  // One QR code covers all of it; the "Which item" answer says what broke.
  // Must match the form's answer option exactly.
  generalEquipment: 'General equipment',

  // Priority answers that should mark the email as high importance and put a
  // flag in the subject line. Match your form's wording.
  urgentAnswers: ['Safety issue - do not operate', 'Down - cannot be used'],

  // Prefix for generated ticket IDs, e.g. MNT-0007.
  ticketPrefix: 'MNT',

  // Paste your form's share link here and the mobile web app gets a
  // "New request" button. Leave blank to hide the button.
  formUrl: '',

  // Set false if you would rather not be emailed when a row is closed out.
  notifyOnClose: true
};

// Columns this script adds and manages on the response sheet.
var STATUS_COL = 'Status';
var TICKET_COL = 'Ticket';
var ASSIGNED_COL = 'Assigned to';
var CLOSED_COL = 'Closed on';
var NOTES_COL = 'Work done / notes';
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
  addTrackingColumns_(sheet);
  applyReadableFormatting_(sheet);
  buildMobileTab_(sheet);
  installTriggers_();
  SpreadsheetApp.getActive().toast('Maintenance log is set up and watching for submissions.');
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
  var wanted = [TICKET_COL, STATUS_COL, ASSIGNED_COL, CLOSED_COL, NOTES_COL];
  var headers = headerRow_(sheet);

  wanted.forEach(function (name) {
    if (headers.indexOf(name) !== -1) return;
    var col = sheet.getLastColumn() + 1;
    sheet.getRange(1, col).setValue(name).setFontWeight('bold');
    headers.push(name);
  });

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

/** Runs on every form submission. */
function onMaintenanceSubmit(e) {
  var sheet = responseSheet_();
  var row = e && e.range ? e.range.getRow() : sheet.getLastRow();
  var answers = readAnswers_(e, sheet, row);

  var ticket = nextTicketId_(sheet, row);
  writeCell_(sheet, row, TICKET_COL, ticket);
  writeCell_(sheet, row, STATUS_COL, 'Open');

  var recipients = recipientsFor_(answers.leadership);
  writeCell_(sheet, row, ASSIGNED_COL, CONFIG.facilitiesLead);

  var urgent = isUrgent_(answers.priority);
  var subject = (urgent ? '[URGENT] ' : '') + ticket + ': ' +
    describe_(answers) + ' needs maintenance';

  var link = rowUrl_(sheet, row);
  MailApp.sendEmail({
    to: recipients.join(','),
    replyTo: answers.email || undefined,
    subject: subject,
    body: plainBody_(ticket, answers, link),
    htmlBody: htmlBody_(ticket, answers, link, urgent),
    name: 'Equipment Maintenance Log'
  });
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
    extras: extraAnswers_(named)
  };
}

function rowAsNamedValues_(sheet, row) {
  var headers = headerRow_(sheet);
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
  [TICKET_COL, STATUS_COL, ASSIGNED_COL, CLOSED_COL, NOTES_COL].forEach(function (c) {
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
function nextTicketId_(sheet, row) {
  var n = row - 1;
  var padded = ('0000' + n).slice(-4);
  return CONFIG.ticketPrefix + '-' + padded;
}

function headerRow_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
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

/** Serves the mobile page. Requires an HTML file named "webapp" in this project. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('webapp')
    .setTitle('Equipment Maintenance')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Every request, newest first, as plain objects the page can render as cards.
 * Reads the sheet in one call — reading cell by cell is the usual reason an
 * Apps Script web app feels slow.
 */
function getRequests() {
  var sheet = responseSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { requests: [], equipmentList: [], statuses: STATUS_OPTIONS, formUrl: CONFIG.formUrl || '' };
  }

  var headers = headerRow_(sheet);
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var q = CONFIG.questions;

  var at = {};
  headers.forEach(function (h, i) { at[h] = i; });
  var get = function (rowValues, header) {
    var i = at[header];
    return i === undefined ? '' : rowValues[i];
  };

  var requests = [];
  var equipmentList = {};

  for (var r = values.length - 1; r >= 0; r--) {
    var v = values[r];
    var equipment = String(get(v, headerFor_(headers, q.equipment)) || '').trim();
    if (equipment) equipmentList[equipment] = true;

    var timestamp = get(v, 'Timestamp');
    var item = String(get(v, headerFor_(headers, q.item)) || '').trim();
    requests.push({
      row: r + 2,
      ticket: String(get(v, TICKET_COL) || ''),
      equipment: equipment,
      item: item,
      // What the card shows as its heading: for the catch-all bucket that is
      // the item, not the useless word "General equipment".
      label: describe_({ equipment: equipment, item: item }),
      general: isGeneral_(equipment),
      priority: String(get(v, q.priority) || '').trim(),
      problem: String(get(v, q.problem) || '').trim(),
      reportedBy: String(get(v, q.reportedBy) || '').trim(),
      status: String(get(v, STATUS_COL) || 'Open').trim() || 'Open',
      notes: String(get(v, NOTES_COL) || ''),
      urgent: isUrgent_(get(v, q.priority)),
      when: timestamp instanceof Date ? formatWhen_(timestamp) : String(timestamp || '')
    });
  }

  return {
    requests: requests,
    equipmentList: Object.keys(equipmentList).sort(),
    statuses: STATUS_OPTIONS,
    formUrl: CONFIG.formUrl || ''
  };
}

/**
 * Update one request from the web app.
 *
 * The ticket is passed back and re-checked against the row before writing:
 * someone deleting a row while a phone has the list open would otherwise
 * shift every row number and write the update onto the wrong request.
 */
function updateRequest(payload) {
  var sheet = responseSheet_();
  var row = Number(payload && payload.row);
  if (!row || row < 2 || row > sheet.getLastRow()) {
    throw new Error('That request no longer exists. Pull down to refresh.');
  }

  var onSheet = readCell_(sheet, row, TICKET_COL);
  if (payload.ticket && onSheet && onSheet !== payload.ticket) {
    throw new Error('The log changed since this list was loaded. Refresh and try again.');
  }

  var status = String(payload.status || '').trim();
  if (STATUS_OPTIONS.indexOf(status) === -1) {
    throw new Error('Unknown status: ' + status);
  }

  var previous = readCell_(sheet, row, STATUS_COL);
  if (payload.notes !== undefined) writeCell_(sheet, row, NOTES_COL, String(payload.notes));
  writeCell_(sheet, row, STATUS_COL, status);

  var closing = (status === 'Done' || status === 'Not needed');
  var wasClosed = (previous === 'Done' || previous === 'Not needed');
  if (closing && !wasClosed) {
    notifyClosed_(sheet, row, status);
  } else if (!closing) {
    writeCell_(sheet, row, CLOSED_COL, '');
  }

  return { ok: true, status: status };
}

// ===========================================================================
// Handy extras
// ===========================================================================

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
    .addItem('Send test email', 'sendTestEmail')
    .addToUi();
}
