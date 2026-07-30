/**
 * maintenance-notify.gs — Google Apps Script for the vehicle maintenance log.
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
  questions: {
    vehicle: 'Vehicle',
    leadership: 'Leadership Team contact',
    priority: 'How urgent is it?',
    problem: 'What needs attention?',
    reportedBy: 'Your name'
  },

  // Priority answers that should mark the email as high importance and put a
  // flag in the subject line. Match your form's wording.
  urgentAnswers: ['Safety issue - do not operate', 'Down - cannot be used'],

  // Prefix for generated ticket IDs, e.g. MNT-0007.
  ticketPrefix: 'MNT',

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
    (answers.vehicle || 'Vehicle') + ' needs maintenance';

  var link = rowUrl_(sheet, row);
  MailApp.sendEmail({
    to: recipients.join(','),
    replyTo: answers.email || undefined,
    subject: subject,
    body: plainBody_(ticket, answers, link),
    htmlBody: htmlBody_(ticket, answers, link, urgent),
    name: 'Vehicle Maintenance Log'
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

  var row = e.range.getRow();
  var answers = readAnswers_(null, sheet, row);
  var ticket = readCell_(sheet, row, TICKET_COL) || '(no ticket)';

  writeCell_(sheet, row, CLOSED_COL, new Date());

  var notes = readCell_(sheet, row, NOTES_COL);
  var closedBy = Session.getActiveUser().getEmail();

  MailApp.sendEmail({
    to: recipientsFor_(answers.leadership).join(','),
    subject: ticket + ' closed (' + value + '): ' + (answers.vehicle || 'Vehicle'),
    body: [
      ticket + ' has been marked "' + value + '".',
      '',
      'Vehicle:   ' + (answers.vehicle || '-'),
      'Problem:   ' + (answers.problem || '-'),
      'Notes:     ' + (notes || '(none recorded)'),
      'Closed by: ' + (closedBy || 'unknown'),
      '',
      rowUrl_(sheet, row)
    ].join('\n'),
    name: 'Vehicle Maintenance Log'
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
    vehicle: lookup_(named, q.vehicle),
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

/** Header matching that tolerates case and trailing punctuation differences. */
function lookup_(named, title) {
  if (!title) return '';
  var want = normalise_(title);
  var keys = Object.keys(named);
  for (var i = 0; i < keys.length; i++) {
    if (normalise_(keys[i]) === want) {
      var v = named[keys[i]];
      return String(Array.isArray(v) ? v.join(', ') : v).trim();
    }
  }
  return '';
}

function normalise_(s) {
  return String(s).toLowerCase().replace(/[\s\?\:\.\*]+/g, ' ').trim();
}

/** Any answers that are not one of the known questions, so nothing is lost. */
function extraAnswers_(named) {
  var known = [];
  Object.keys(CONFIG.questions).forEach(function (k) { known.push(normalise_(CONFIG.questions[k])); });
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
    'Vehicle:     ' + (a.vehicle || '-'),
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
    ['Vehicle', a.vehicle],
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
        esc(a.vehicle || 'Vehicle') + '</h2>' +
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
// Handy extras
// ===========================================================================

/** Run by hand to check your CONFIG addresses without filing a real request. */
function sendTestEmail() {
  var recipients = recipientsFor_('');
  MailApp.sendEmail({
    to: recipients.join(','),
    subject: '[test] Vehicle maintenance log is connected',
    body: 'If you are reading this, notifications are working.\n\n' +
      'Recipients on this test: ' + recipients.join(', ') + '\n\n' +
      'Note that a real request also emails the Leadership Team member the ' +
      'person picks on the form.',
    name: 'Vehicle Maintenance Log'
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
