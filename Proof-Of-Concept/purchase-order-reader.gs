/**
 * purchase-order-reader.gs — Purchase Order Reader (proof of concept)
 *
 * Reads incoming purchase-order emails on a schedule, pulls out the order
 * number, plant name, unit count, unit cost and total cost, and appends one
 * row per line item to a Google Sheet in the shared Drive.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DESIGN — security is the priority
 * ---------------------------------------------------------------------------
 * This runs as Google Apps Script BOUND to the destination spreadsheet. That
 * choice is the security story, not an implementation detail:
 *
 *   1. No server, ever.  The code runs on Google's own infrastructure, invoked
 *      by a time trigger. There is no machine to patch, no port to expose, no
 *      web host that can be breached, and nothing running while the trigger is
 *      idle.
 *
 *   2. No credentials to leak.  There is no API key, no password, no OAuth
 *      refresh token stored anywhere in this file or in the project. Access is
 *      the signed-in owner's own Google identity, granted through Google's
 *      consent screen. Nothing sensitive is committed to GitHub.
 *
 *   3. Data never leaves your Workspace.  Mail is read from Millcreek's Gmail
 *      and written to Millcreek's Sheet. This script makes no outbound network
 *      calls to any third party — there is no other place the data could go.
 *
 *   4. Read-only mail.  Via the Gmail *advanced service* the app holds only the
 *      gmail.readonly scope (see appsscript.json). It cannot send, delete, or
 *      alter a single message. The blast radius of a bug is "read the PO inbox".
 *
 *   5. Least privilege everywhere else.  It can write to ONLY this one bound
 *      spreadsheet (spreadsheets.currentonly), and the dashboard is locked to
 *      @millcreekplants.com accounts.
 *
 *   6. Trust the sender, not the text.  Only mail from an explicit allowlist of
 *      senders is parsed, and every value written to the sheet is neutralised so
 *      a malicious email body can never execute as a spreadsheet formula.
 *
 * ---------------------------------------------------------------------------
 * SETUP (about ten minutes) — full walkthrough in README.md
 * ---------------------------------------------------------------------------
 *   1. Open the destination Google Sheet -> Extensions -> Apps Script.
 *   2. Paste this file, purchase-order-webapp.html, and appsscript.json in.
 *      (Show appsscript.json via the gear -> "Show manifest file".)
 *   3. Edit the CONFIG block below — at minimum, poSenders.
 *   4. Run setUp() once and grant the permissions it asks for.
 *   5. (Optional) Deploy -> New deployment -> Web app for the dashboard.
 *
 * Everything you need to change lives in CONFIG. Nothing below it should need
 * editing except parsePurchaseOrder_(), which you tune to your real emails.
 */

// ===========================================================================
// CONFIG — the only section you need to edit.
// ===========================================================================
var CONFIG = {

  // --- Who is allowed to send a purchase order --------------------------
  // ONLY mail from these addresses (or domains) is ever parsed. This is the
  // primary trust boundary: an attacker cannot get a row onto the sheet just
  // by emailing the inbox — the mail has to come from a sender you listed.
  //
  // Use full addresses ('orders@a-grower.com') for tight control, or a bare
  // domain ('a-grower.com') to trust everyone at a supplier. Keep it short.
  poSenders: [
    'orders@example-supplier.com'
    // 'sales@another-grower.com',
    // 'a-trusted-supplier.com'
  ],

  // --- How we find the emails -------------------------------------------
  // A Gmail search string. The sender filter above is applied on top of this
  // in code, so this only needs to narrow things down. Newer-than keeps each
  // run fast. Adjust the subject words to match your suppliers.
  //   https://support.google.com/mail/answer/7190
  searchQuery: 'newer_than:14d (subject:"purchase order" OR subject:"PO" OR subject:"order confirmation")',

  // --- Where the data goes ----------------------------------------------
  // The tab within THIS spreadsheet that rows are appended to. Created by
  // setUp() if it does not exist.
  sheetName: 'Purchase Orders',

  // --- The company domain -----------------------------------------------
  // Used to lock the web dashboard to Millcreek staff. Sign-ins from any other
  // domain are refused.
  workEmailDomain: 'millcreekplants.com',

  // --- Housekeeping ------------------------------------------------------
  // How many message threads to examine per run. A ceiling so a backlog can
  // never make one run hang; leftovers are picked up next run.
  maxThreadsPerRun: 25,

  // Notify these addresses if a run hits an error (leave [] for none). Uses
  // no extra scope — this is the owner's own Apps Script quota mail, not the
  // read-only Gmail service.
  alertOnErrorTo: []
};

// Column order for the sheet. Header text is what a person reads; `key` is what
// parsePurchaseOrder_() must return for each line item. Add or reorder freely —
// the writer matches by header, never by position.
var COLUMNS = [
  { header: 'Logged At',        key: '_loggedAt'   },
  { header: 'Order Number',     key: 'orderNumber' },
  { header: 'Vendor SKU',       key: 'sku'         },
  { header: 'Plant / Item',     key: 'itemName'    },
  { header: 'Spec / Size',      key: 'spec'        },
  { header: 'Units',            key: 'units'       },
  { header: 'Unit Cost',        key: 'unitCost'    },
  { header: 'Line Total',       key: 'totalCost'   },
  { header: 'Supplier',         key: 'supplier'    },
  { header: 'Order Date',       key: 'orderDate'   },
  { header: 'From',             key: '_from'       },
  { header: 'Email Subject',    key: '_subject'    },
  { header: 'Gmail Link',       key: '_gmailLink'  }
];

var PROP_KEY_WATERMARK = 'po_reader_last_ts';   // high-water mark (ms since epoch)

// ===========================================================================
// SETUP
// ===========================================================================

/**
 * Run this once, by hand, from the Apps Script editor.
 *
 * Creates the destination tab with headers, installs a single time-based
 * trigger, and — critically — makes you approve the permission scopes so you
 * can read on the consent screen exactly what the app may touch.
 */
function setUp() {
  ensureSheet_();
  ensureTrigger_();

  // Seed the watermark to "now" so the very first scheduled run does not walk
  // the entire mailbox history. Comment this out for a one-time backfill.
  if (!PropertiesService.getScriptProperties().getProperty(PROP_KEY_WATERMARK)) {
    PropertiesService.getScriptProperties()
      .setProperty(PROP_KEY_WATERMARK, String(Date.now()));
  }

  var senders = normaliseSenders_(CONFIG.poSenders);
  var stillExample = !senders.length ||
    (senders.length === 1 && senders[0] === 'orders@example-supplier.com');

  SpreadsheetApp.getActive().toast(
    stillExample
      ? 'Set up — but CONFIG.poSenders is still the example, so NO email will be ' +
        'logged yet. Edit it to your real suppliers, then run runDiagnostics().'
      : 'Purchase Order Reader is set up. It will check for new orders every 15 minutes.',
    stillExample ? 'Action needed' : 'Ready', 10);
}

/**
 * One-shot health check — run this from the editor and read View -> Logs when
 * the sheet is not filling. It reports, in order, the things that stop rows
 * from appearing: no trigger, an unset watermark, poSenders left as the
 * example, the Gmail service not being enabled, and (most useful) the senders
 * of the emails your search is actually matching, with whether each is allowed.
 */
function runDiagnostics() {
  var out = ['=== Purchase Order Reader diagnostics ==='];
  var props = PropertiesService.getScriptProperties();

  var hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'processPurchaseOrders';
  });
  out.push('1. Trigger installed: ' + (hasTrigger ? 'yes' : 'NO  -> run setUp()'));

  var wm = props.getProperty(PROP_KEY_WATERMARK);
  out.push('2. Watermark: ' + (wm
    ? Utilities.formatDate(new Date(Number(wm)), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') +
      '  (only mail newer than this is considered)'
    : 'NOT SET  -> run setUp()'));

  var senders = normaliseSenders_(CONFIG.poSenders);
  var stillExample = senders.length === 1 && senders[0] === 'orders@example-supplier.com';
  out.push('3. Trusted senders: ' + (senders.length ? senders.join(', ') : '(none)') +
    (stillExample ? '  <-- STILL THE EXAMPLE. Set CONFIG.poSenders to your suppliers.'
                  : (!senders.length ? '  <-- EMPTY. Nothing is trusted, so nothing is logged.' : '')));

  try {
    var list = Gmail.Users.Messages.list('me', { q: CONFIG.searchQuery, maxResults: 5 });
    var refs = (list && list.messages) || [];
    out.push('4. Gmail service: OK. Your search matched ' + refs.length + ' recent message(s):');
    refs.forEach(function (ref) {
      var full = Gmail.Users.Messages.get('me', ref.id,
        { format: 'metadata', metadataHeaders: ['From', 'Subject'] });
      var from = headerValue_(full, 'From');
      out.push('     - ' + from + '  |  ' + headerValue_(full, 'Subject') +
        '  |  allowed=' + senderAllowed_(from, senders));
    });
    if (!refs.length) out.push('     (No matches. Widen CONFIG.searchQuery or check the subject words.)');
  } catch (e) {
    out.push('4. Gmail service: ERROR — ' + (e && e.message || e) +
      '  -> Editor: Services (+) -> add "Gmail API", then save.');
  }

  var sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.sheetName);
  out.push('5. Sheet "' + CONFIG.sheetName + '": ' +
    (sheet ? Math.max(0, sheet.getLastRow() - 1) + ' data row(s)' : 'MISSING -> run setUp()'));

  out.push('6. You are seen as: ' + (viewerEmail_() ||
    '(empty / not a ' + CONFIG.workEmailDomain + ' account — the web app would refuse this login)'));

  var report = out.join('\n');
  Logger.log(report);
  return report;
}

/** Create (or update the header of) the destination tab. */
function ensureSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(CONFIG.sheetName) || ss.insertSheet(CONFIG.sheetName);

  var headers = COLUMNS.map(function (c) { return c.header; });
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#e8efe9');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
  return sheet;
}

/** Install exactly one 15-minute trigger; never stack duplicates. */
function ensureTrigger_() {
  var handler = 'processPurchaseOrders';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(15).create();
}

// ===========================================================================
// MAIN — this is what the trigger calls.
// ===========================================================================

/**
 * Find new purchase-order emails, parse them, and append their line items.
 *
 * Idempotent by two independent guards, so re-running never double-writes:
 *   - a timestamp watermark, so already-seen messages are skipped, and
 *   - an order-number set read from the sheet, so a resend of the same PO is
 *     ignored even if the watermark is reset.
 */
function processPurchaseOrders() {
  try {
    var sheet = ensureSheet_();
    var props = PropertiesService.getScriptProperties();
    var watermark = Number(props.getProperty(PROP_KEY_WATERMARK) || 0);
    var seenOrders = existingOrderNumbers_(sheet);

    var senders = normaliseSenders_(CONFIG.poSenders);
    if (!senders.length) {
      Logger.log('No poSenders configured — nothing is trusted, so nothing runs.');
      return;
    }

    var messages = findCandidateMessages_(CONFIG.searchQuery, CONFIG.maxThreadsPerRun);
    var newWatermark = watermark;
    var rowsToAppend = [];

    messages.forEach(function (msg) {
      if (msg.internalMs <= watermark) return;            // already past this point
      newWatermark = Math.max(newWatermark, msg.internalMs);

      if (!senderAllowed_(msg.from, senders)) return;     // untrusted sender: ignore

      var parsed = parsePurchaseOrder_(msg.body, msg.subject) || {};
      var order = String(parsed.orderNumber || '').trim();
      if (!order) return;                                 // couldn't identify the PO
      if (seenOrders[order.toLowerCase()]) return;        // already logged this PO
      seenOrders[order.toLowerCase()] = true;

      var items = Array.isArray(parsed.items) && parsed.items.length
        ? parsed.items
        : [parsed];                                       // single-item fallback

      items.forEach(function (item) {
        rowsToAppend.push(buildRow_(item, parsed, msg));
      });
    });

    if (rowsToAppend.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, COLUMNS.length)
        .setValues(rowsToAppend);
    }

    if (newWatermark > watermark) {
      props.setProperty(PROP_KEY_WATERMARK, String(newWatermark));
    }
    Logger.log('Purchase Order Reader: appended %s row(s).', rowsToAppend.length);
  } catch (err) {
    reportError_(err);
    throw err;   // still surface it in the Apps Script execution log
  }
}

// ===========================================================================
// GMAIL — read-only, via the advanced Gmail service.
// ===========================================================================

/**
 * Return lightweight, already-decoded records for messages matching the query,
 * newest first. Using the REST Gmail service (not GmailApp) is what lets the
 * whole project stay on the gmail.readonly scope.
 */
function findCandidateMessages_(query, maxThreads) {
  var out = [];
  var list = Gmail.Users.Messages.list('me', {
    q: query,
    maxResults: Math.max(1, Math.min(maxThreads, 100))
  });
  var ids = (list && list.messages) || [];

  ids.forEach(function (ref) {
    var full = Gmail.Users.Messages.get('me', ref.id, { format: 'full' });
    if (!full) return;
    out.push({
      id: ref.id,
      threadId: full.threadId,
      internalMs: Number(full.internalDate || 0),
      from: headerValue_(full, 'From'),
      subject: headerValue_(full, 'Subject'),
      body: extractPlainText_(full.payload),
      gmailLink: 'https://mail.google.com/mail/u/0/#all/' + (full.threadId || ref.id)
    });
  });

  // Newest first so the watermark advances monotonically.
  out.sort(function (a, b) { return b.internalMs - a.internalMs; });
  return out;
}

/** Pull a header value (case-insensitive) from a Gmail message resource. */
function headerValue_(message, name) {
  var headers = (message.payload && message.payload.headers) || [];
  var wanted = String(name).toLowerCase();
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name).toLowerCase() === wanted) return headers[i].value || '';
  }
  return '';
}

/**
 * Walk a MIME payload and return the plain-text body.
 *
 * Prefers text/plain. Falls back to a crude tag-strip of text/html so a
 * plain-text-free email still yields something to parse. Recurses through
 * multipart containers.
 */
function extractPlainText_(payload) {
  if (!payload) return '';

  var plain = collectMimeText_(payload, 'text/plain');
  if (plain) return plain;

  var html = collectMimeText_(payload, 'text/html');
  if (html) {
    return html
      .replace(/<\s*(br|\/p|\/div|\/tr|\/li)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }
  return '';
}

/** Concatenate the decoded body of every part whose mimeType matches. */
function collectMimeText_(part, mimeType) {
  var acc = [];
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === mimeType && p.body && p.body.data) {
      acc.push(decodeBase64Url_(p.body.data));
    }
    (p.parts || []).forEach(walk);
  })(part);
  return acc.join('\n');
}

/** Decode Gmail's base64url message bodies to a UTF-8 string. */
function decodeBase64Url_(data) {
  try {
    var bytes = Utilities.base64DecodeWebSafe(data);
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  } catch (err) {
    return '';
  }
}

// ===========================================================================
// SENDER TRUST
// ===========================================================================

/** Lower-case, de-blank the configured sender allowlist. */
function normaliseSenders_(list) {
  return (list || [])
    .map(function (s) { return String(s || '').trim().toLowerCase(); })
    .filter(function (s) { return s.length > 0; });
}

/**
 * Is this From header on the allowlist?
 *
 * Matches a full address exactly, or a bare-domain entry against the address's
 * domain. The address is pulled out of "Name <addr@x>" first so display-name
 * spoofing ("orders@example-supplier.com" as a *name*) cannot slip through.
 */
function senderAllowed_(fromHeader, senders) {
  var addr = extractAddress_(fromHeader);
  if (!addr) return false;
  var domain = addr.slice(addr.indexOf('@') + 1);
  for (var i = 0; i < senders.length; i++) {
    var entry = senders[i];
    if (entry.indexOf('@') === -1) {
      if (domain === entry) return true;        // bare-domain rule
    } else if (addr === entry) {
      return true;                              // exact-address rule
    }
  }
  return false;
}

/** Extract the bare email address from a From header, lower-cased. */
function extractAddress_(fromHeader) {
  var s = String(fromHeader || '');
  var m = s.match(/<([^>]+)>/);
  var addr = (m ? m[1] : s).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : '';
}

// ===========================================================================
// PARSER — tune this to your real purchase-order emails.
// ===========================================================================

/**
 * Turn one email body into a purchase order: header fields plus line items.
 *
 * Returns an object shaped like:
 *   {
 *     orderNumber: 'PO-10432',
 *     supplier:    'Example Supplier',
 *     orderDate:   '2026-08-01',
 *     items: [
 *       { itemName: 'Echinacea Magnus', units: 200, unitCost: 1.85, totalCost: 370 },
 *       ...
 *     ]
 *   }
 *
 * The two blocks below are deliberately generic so the PoC works on day one:
 *   A. header fields are read from "Label: value" lines, and
 *   B. line items are read from rows that end in three numbers
 *      (units, unit cost, total), which is how most PO tables flatten to text.
 *
 * Every real supplier formats POs differently. Treat this as the ONE function
 * you adapt: run runParserSelfTest() and paste a real (sanitised) email into
 * the SAMPLE_PO string at the bottom to see what it extracts, then adjust the
 * patterns. Nothing else in the file should need to change.
 */
function parsePurchaseOrder_(body, subject) {
  var text = String(body || '');
  var subjectText = String(subject || '');
  var lines = text.split(/\r?\n/);

  // --- A. Header fields -------------------------------------------------
  // The order number MUST be preceded by an order/PO cue AND a ":" or "#", and
  // MUST contain a digit. That rules out false hits like the heading "PURCHASE
  // ORDER SUMMARY" or the phrase "purchase order on behalf of ...".
  var orderNumber =
    firstToken_(text, /\b(?:purchase\s*order|p\.?o\.?|order)\s*(?:number|no\.?|#)?\s*[:#]\s*([A-Za-z0-9][\w\-\/]{2,})/i) ||
    firstToken_(subjectText, /\b(?:purchase\s*order|p\.?o\.?|order)\s*(?:number|no\.?|#)?\s*[:#]?\s*([A-Za-z0-9][\w\-\/]{2,})/i);

  // "Supplier:" / "Vendor:" if present; otherwise "on behalf of <Company>".
  // Leading bullets (*, -, •) are tolerated on labelled lines.
  var supplier =
    firstMatch_(text, /^[\s*•\-]*(?:supplier|vendor|sold\s*by)\s*:\s*(.+?)\s*$/im) ||
    firstMatch_(text, /on\s+behalf\s+of\s+(.+?)\s*[.,\n]/i);

  var orderDate =
    firstMatch_(text, /^[\s*•\-]*(?:order\s*date|po\s*date)\s*:\s*(.+?)\s*$/im) ||
    firstMatch_(text, /^[\s*•\-]*date\s*:\s*(.+?)\s*$/im);

  // --- B. Line items ----------------------------------------------------
  // Preferred: a pipe-delimited table (Markdown / pasted spreadsheet), which is
  // how most modern PO emails present their line items. Fall back to the
  // one-line-per-item patterns for plain-text orders.
  var items = parseTableItems_(lines);
  if (!items.length) {
    lines.forEach(function (line) {
      var item = parseLineItem_(line);
      if (item) items.push(item);
    });
  }

  return {
    orderNumber: orderNumber,
    supplier: supplier,
    orderDate: orderDate,
    items: items
  };
}

// ---------------------------------------------------------------------------
// Pipe-table parser
// ---------------------------------------------------------------------------

/**
 * Extract line items from any pipe-delimited table whose header row names a
 * quantity, a unit price and a line total. Other tables in the same email (a
 * Ship-To / Bill-To block, say) have no such columns, so they are ignored.
 *
 * Columns are matched BY HEADER NAME, so suppliers can reorder or add columns
 * without breaking anything — the SKU and container spec are captured too when
 * the table offers them.
 */
function parseTableItems_(lines) {
  var items = [];
  var map = null;   // active column map, or null when we are not inside an items table

  for (var i = 0; i < lines.length; i++) {
    var cells = splitPipeRow_(lines[i]);

    if (!cells) { map = null; continue; }   // a non-table line ends the table
    if (isSeparatorRow_(cells)) continue;    // the |---|---| divider

    if (!map) {
      map = mapColumns_(cells);              // is THIS an items header? (null if not)
      continue;                              // header row itself carries no data
    }

    var item = rowToItem_(cells, map);
    if (item) items.push(item);
  }
  return items;
}

/**
 * Split a "| a | b | c |" row into trimmed cell values, dropping the empty
 * cells the outer pipes create. Returns null for any line that is not a table
 * row (fewer than two pipes), which is how the parser knows a table has ended.
 */
function splitPipeRow_(line) {
  var s = String(line || '');
  if ((s.match(/\|/g) || []).length < 2) return null;

  var cells = s.split('|').map(function (c) { return c.trim(); });
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells.length ? cells : null;
}

/** True for a Markdown divider row like |---|:--:|---| . */
function isSeparatorRow_(cells) {
  return cells.every(function (c) { return /^:?-{2,}:?$/.test(c) || c === ''; }) &&
         cells.some(function (c) { return /-/.test(c); });
}

/**
 * If these header cells describe a line-item table, return a map of the
 * columns we care about; otherwise null. Requires at least a quantity column
 * plus a unit price or a line total — enough to tell an order table apart from
 * an address table.
 */
function mapColumns_(headerCells) {
  var qty   = findHeader_(headerCells, /\bqty\b|quantit|\bunits?\b|\bcount\b/i);
  var unit  = findHeader_(headerCells, /unit\s*(?:price|cost)|price\s*each|\beach\b|price\s*\(/i);
  var total = findHeader_(headerCells, /line\s*(?:total|amount)|ext(?:ended)?\s*(?:price|cost)|\bamount\b|\btotal\b/i);
  if (qty === -1 || (unit === -1 && total === -1)) return null;

  var name = findHeader_(headerCells, /botanical|common|description|product|plant/i);
  if (name === -1) name = findHeader_(headerCells, /\bname\b/i);
  if (name === -1) name = findHeader_(headerCells, /\bitem\b(?!\s*#)/i);

  // Prefer a real product code column; only fall back to a line-number ("Item #")
  // column if there is no dedicated SKU/part-number column.
  var sku = findHeader_(headerCells, /\bsku\b|part\s*(?:#|no)|\bmpn\b|\bupc\b|item\s*code|\bcode\b/i);
  if (sku === -1) sku = findHeader_(headerCells, /item\s*#|item\s*no|line\s*#/i);

  return {
    name:  name,
    qty:   qty,
    unit:  unit,
    total: total,
    sku:   sku,
    spec:  findHeader_(headerCells, /spec|container|\bsize\b|grade|form/i)
  };
}

/** Index of the first header cell matching re, or -1. */
function findHeader_(cells, re) {
  for (var i = 0; i < cells.length; i++) {
    if (re.test(cells[i])) return i;
  }
  return -1;
}

/** Turn one data row into a line item using the column map, or null. */
function rowToItem_(cells, map) {
  var at = function (idx) { return idx >= 0 && idx < cells.length ? cells[idx] : ''; };

  var units = toNumber_(at(map.qty));
  var item = finishItem_(at(map.name), units, toNumber_(at(map.unit)), toNumber_(at(map.total)));
  if (!item) return null;

  item.sku = plainish_(at(map.sku));
  item.spec = plainish_(at(map.spec));
  return item;
}

/** Trim and collapse internal whitespace; used for free-text cells. */
function plainish_(value) {
  return String(value || '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Parse a single line into {itemName, units, unitCost, totalCost} or null.
 * Tolerant of $ signs, commas in thousands, "x"/"@"/"=" separators, and
 * trailing/leading whitespace.
 */
function parseLineItem_(line) {
  var raw = String(line || '').trim();
  if (!raw) return null;

  // Pattern 1: "200 x Name @ $1.60 = $320.00"
  var m = raw.match(
    /^(\d[\d,]*)\s*[xX*]\s*(.+?)\s*[@]\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(?:[=]\s*\$?\s*([\d,]+(?:\.\d+)?))?$/);
  if (m) {
    var units1 = toNumber_(m[1]);
    var unit1 = toNumber_(m[3]);
    var total1 = m[4] ? toNumber_(m[4]) : round2_(units1 * unit1);
    return finishItem_(m[2], units1, unit1, total1);
  }

  // Pattern 2: "Name .... <units> <unitCost> <total>" (whitespace/table columns)
  m = raw.match(
    /^(.+?)\s{2,}(\d[\d,]*)\s+\$?([\d,]+(?:\.\d+)?)\s+\$?([\d,]+(?:\.\d+)?)\s*$/);
  if (!m) {
    m = raw.match(
      /^(.+?)\s+(\d[\d,]*)\s+\$?([\d,]+(?:\.\d+)?)\s+\$?([\d,]+(?:\.\d+)?)\s*$/);
  }
  if (m) {
    var name2 = m[1];
    // Guard against matching a label line like "Order Total: 1 2 3".
    if (/order|total|subtotal|invoice|tax|shipping/i.test(name2) &&
        !/[a-z]{3,}/i.test(name2.replace(/order|total|subtotal|invoice|tax|shipping/ig, ''))) {
      return null;
    }
    return finishItem_(name2, toNumber_(m[2]), toNumber_(m[3]), toNumber_(m[4]));
  }

  return null;
}

/** Assemble a clean line-item object, dropping obviously empty rows. */
function finishItem_(name, units, unitCost, totalCost) {
  var itemName = String(name || '').replace(/\s{2,}/g, ' ').trim();
  if (!itemName || !(units > 0)) return null;
  return {
    itemName: itemName,
    units: units,
    unitCost: unitCost,
    totalCost: totalCost
  };
}

// ===========================================================================
// SHEET WRITING — injection-hardened.
// ===========================================================================

/**
 * Build one sheet row (array in COLUMNS order) from a line item, its parent
 * order, and the source message. Header fields fall back to the order-level
 * value; every text value is neutralised against formula injection.
 */
function buildRow_(item, order, msg) {
  var loggedAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(),
    'yyyy-MM-dd HH:mm');

  var value = {
    _loggedAt: loggedAt,
    orderNumber: order.orderNumber || '',
    sku: item.sku || '',
    itemName: item.itemName || '',
    spec: item.spec || '',
    units: numberOrText_(item.units),
    unitCost: numberOrText_(item.unitCost),
    totalCost: numberOrText_(item.totalCost),
    supplier: order.supplier || extractAddress_(msg.from) || '',
    orderDate: order.orderDate || '',
    _from: msg.from || '',
    _subject: msg.subject || '',
    _gmailLink: msg.gmailLink || ''
  };

  return COLUMNS.map(function (col) { return plainText_(value[col.key]); });
}

/**
 * Keep an email-supplied value from acting as a spreadsheet formula.
 *
 * A cell beginning with = + - @ (or a tab/CR) is evaluated as a formula when
 * the sheet opens; a crafted PO could use =IMPORTDATA(...) to exfiltrate other
 * cells to an outside URL. Prefixing a suspect string with an apostrophe forces
 * it to stay literal text. Numbers and dates are left untouched so totals still
 * add up.
 */
function plainText_(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

/** Pass real numbers through as numbers; leave anything else as its string. */
function numberOrText_(value) {
  return (typeof value === 'number' && isFinite(value)) ? value : String(value || '');
}

/** Set of order numbers already in the sheet (lower-cased), for dedupe. */
function existingOrderNumbers_(sheet) {
  var seen = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return seen;

  var col = 0;
  for (var i = 0; i < COLUMNS.length; i++) {
    if (COLUMNS[i].key === 'orderNumber') { col = i + 1; break; }
  }
  if (!col) return seen;

  var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  values.forEach(function (r) {
    var v = String(r[0] || '').trim().toLowerCase();
    if (v) seen[v] = true;
  });
  return seen;
}

// ===========================================================================
// WEB APP — a read-only monitoring dashboard, locked to the company domain.
// ===========================================================================

/**
 * Serve the dashboard. Deploy As: user deploying; Access: anyone in the domain
 * (see appsscript.json). We still re-check the signed-in address here so a
 * misconfigured deployment cannot leak the data to an outside account.
 */
function doGet() {
  if (!viewerEmail_()) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:2rem">Please sign in with your ' +
      '<b>@' + CONFIG.workEmailDomain + '</b> account to view this dashboard.</p>');
  }
  return HtmlService.createTemplateFromFile('purchase-order-webapp')
    .evaluate()
    .setTitle('Millcreek — Purchase Orders')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Data for the dashboard: the most recent rows plus a few headline numbers.
 * Refuses to return anything to a non-domain viewer — defence in depth on top
 * of the deployment's own domain restriction.
 */
function getDashboardData() {
  if (!viewerEmail_()) throw new Error('Not authorised.');

  var sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.sheetName);
  var lastRow = sheet ? sheet.getLastRow() : 0;
  if (!sheet || lastRow < 2) {
    return { headers: COLUMNS.map(function (c) { return c.header; }), rows: [],
             totalRows: 0, totalUnits: 0, totalSpend: 0, lastRun: lastRunLabel_() };
  }

  var width = COLUMNS.length;
  var take = Math.min(50, lastRow - 1);
  var values = sheet.getRange(lastRow - take + 1, 1, take, width).getValues();
  values.reverse();   // newest first

  var idx = keyIndex_();
  var totalUnits = 0, totalSpend = 0;
  var allUnits = sheet.getRange(2, idx.units + 1, lastRow - 1, 1).getValues();
  var allSpend = sheet.getRange(2, idx.totalCost + 1, lastRow - 1, 1).getValues();
  allUnits.forEach(function (r) { totalUnits += toNumber_(r[0]) || 0; });
  allSpend.forEach(function (r) { totalSpend += toNumber_(r[0]) || 0; });

  return {
    headers: COLUMNS.map(function (c) { return c.header; }),
    rows: values,
    totalRows: lastRow - 1,
    totalUnits: totalUnits,
    totalSpend: round2_(totalSpend),
    lastRun: lastRunLabel_()
  };
}

/** Let the dashboard "Check now" button trigger a run on demand. */
function checkNow() {
  if (!viewerEmail_()) throw new Error('Not authorised.');
  processPurchaseOrders();
  return getDashboardData();
}

/** Map each COLUMNS key to its zero-based position. */
function keyIndex_() {
  var idx = {};
  COLUMNS.forEach(function (c, i) { idx[c.key] = i; });
  return idx;
}

/** Human label for when the reader last advanced its watermark. */
function lastRunLabel_() {
  var ms = Number(PropertiesService.getScriptProperties().getProperty(PROP_KEY_WATERMARK) || 0);
  if (!ms) return 'not yet run';
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(),
    'EEE d MMM, h:mm a');
}

/**
 * The signed-in viewer's work address, or '' if we cannot confirm it is a
 * company account. Never guesses with getEffectiveUser() (which would return
 * the script owner and defeat the check).
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
    return '';
  }
  return email;
}

// ===========================================================================
// SMALL UTILITIES
// ===========================================================================

/** First capture group of the first match, trimmed, or '' . */
function firstMatch_(text, re) {
  var m = String(text || '').match(re);
  return m && m[1] ? m[1].trim() : '';
}

/**
 * First captured token that contains a digit, or '' . Used for the order
 * number so a text-only match (a heading, a stray "purchase order" in prose)
 * is skipped in favour of something that actually looks like an order id.
 */
function firstToken_(text, re) {
  var flags = re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags;
  var re2 = new RegExp(re.source, flags);
  var m;
  while ((m = re2.exec(String(text || ''))) !== null) {
    var val = (m[1] || '').trim();
    if (/\d/.test(val)) return val;
    if (m.index === re2.lastIndex) re2.lastIndex++;   // guard against zero-width loops
  }
  return '';
}

/** Parse "$1,234.50" / "1,234.5" / "200" to a Number, or NaN. */
function toNumber_(s) {
  if (typeof s === 'number') return s;
  var cleaned = String(s || '').replace(/[$,\s]/g, '');
  if (!cleaned) return NaN;
  var n = Number(cleaned);
  return isFinite(n) ? n : NaN;
}

/** Round to cents. */
function round2_(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Email the owner if a run throws, using their own quota (no extra scope). */
function reportError_(err) {
  var to = CONFIG.alertOnErrorTo || [];
  if (!to.length) return;
  try {
    MailApp.sendEmail({
      to: to.join(','),
      subject: 'Purchase Order Reader: run failed',
      body: 'A scheduled run threw an error:\n\n' + (err && err.stack || err) +
            '\n\nCheck Extensions -> Apps Script -> Executions for detail.'
    });
  } catch (ignored) { /* never let alerting mask the original error */ }
}

// ===========================================================================
// SELF-TEST — prove the parser works before you wire up real mail.
// ===========================================================================

// A sanitised sample PO in the pipe-table format most suppliers send. Replace
// this with a real (scrubbed) email body to tune the parser to a new supplier,
// then run runParserSelfTest(). The plain-text fallback patterns are covered by
// runFallbackSelfTest() below.
var SAMPLE_PO = [
  'Dear Oakridge Wholesale Team,',
  'Please accept the following purchase order on behalf of Apex Flora Sourcing Co.',
  '',
  'PURCHASE ORDER SUMMARY',
  ' * Purchase Order Number: PO-2026-08942',
  ' * Order Date: August 5, 2026',
  ' * Requested Ship Date: August 11, 2026',
  ' * Payment Terms: Net 30 (Per Master Vendor Agreement #AV-402)',
  '',
  'DELIVERY & BILLING INFORMATION',
  '| Ship To (Delivery Address) | Bill To (Invoicing Address) |',
  '|---|---|',
  '| Apex Flora Receiving Hub — Dock B | Apex Flora Sourcing Co. |',
  '| 1420 Nursery Way, Building 4 | P.O. Box 88102 |',
  '',
  'ORDER SPECIFICATIONS',
  '| Item # | Vendor SKU | Botanical / Common Name | Spec / Container Size | Qty | Unit Price ($) | Line Total ($) |',
  '|---|---|---|---|---|---|---|',
  "| 01 | AP-BL-03 | Acer palmatum 'Bloodgood' | #3 Container (Heavy) | 35 | 38.50 | 1,347.50 |",
  "| 02 | BM-WG-02 | Buxus microphylla 'Winter Gem' | #2 Container | 120 | 14.25 | 1,710.00 |",
  "| 03 | EP-M-72P | Echinacea purpurea 'Magnus' | 72-Cell Plug Tray | 12 | 31.00 | 372.00 |",
  "| 04 | IG-D-05 | Ilex glabra 'Densa' | #5 Container | 40 | 24.00 | 960.00 |",
  "| 05 | CS-G-01 | Calamagrostis x acutiflora 'Karl Foerster' | #1 Container | 80 | 6.50 | 520.00 |",
  '',
  'FINANCIAL SUMMARY',
  ' * Subtotal: $4,909.50',
  ' * TOTAL ORDER VALUE: $5,289.50',
  '',
  'Please send confirmation referencing PO-2026-08942 to orders@apexflorasourcing.com.'
].join('\n');

/** Run from the editor and read the Logs (View -> Logs) to see the extraction. */
function runParserSelfTest() {
  var parsed = parsePurchaseOrder_(SAMPLE_PO, 'Your purchase order PO-2026-08942');
  Logger.log('Order number: %s', parsed.orderNumber);
  Logger.log('Supplier:     %s', parsed.supplier);
  Logger.log('Order date:   %s', parsed.orderDate);
  Logger.log('Line items:   %s', parsed.items.length);
  parsed.items.forEach(function (it, i) {
    Logger.log('  %s. [%s] %s (%s)  x%s  @%s  = %s',
      i + 1, it.sku, it.itemName, it.spec, it.units, it.unitCost, it.totalCost);
  });

  assert_(parsed.orderNumber === 'PO-2026-08942', 'order number, got ' + parsed.orderNumber);
  assert_(parsed.items.length === 5, 'expected 5 items, got ' + parsed.items.length);
  assert_(parsed.items[0].sku === 'AP-BL-03', 'SKU on item 1');
  assert_(parsed.items[1].units === 120, 'units on item 2');
  assert_(parsed.items[2].unitCost === 31, 'unit cost on item 3');
  assert_(parsed.items[0].totalCost === 1347.5, 'line total on item 1');
  Logger.log('runParserSelfTest: PASS');
  return parsed;
}

/** Proves the plain-text fallback still works for suppliers who don't use tables. */
function runFallbackSelfTest() {
  var body = [
    'Purchase Order #: PO-10432',
    'Supplier: Example Grower Co.',
    "Echinacea 'Magnus'           200      1.85        370.00",
    '300 x Salvia May Night @ $1.40 = $420.00'
  ].join('\n');
  var parsed = parsePurchaseOrder_(body, '');
  assert_(parsed.orderNumber === 'PO-10432', 'fallback order number');
  assert_(parsed.items.length === 2, 'fallback items, got ' + parsed.items.length);
  Logger.log('runFallbackSelfTest: PASS');
  return parsed;
}

function assert_(cond, msg) {
  if (!cond) throw new Error('Self-test failed: ' + msg);
}
