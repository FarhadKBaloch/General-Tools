# Purchase Order Reader — proof of concept

Reads purchase-order emails as they arrive, pulls out the order number, plant
name, unit count, unit cost and total cost, and drops one row per line item into
a Google Sheet in the shared Drive. A small read-only dashboard shows what has
been captured.

Built the same way as the rest of this repo: **Google Apps Script, no server,
no cost.** For this project that is not just convenient — it is the security
model. Sensitive company information never leaves Millcreek's Google Workspace,
and there is no infrastructure of ours for anyone to attack.

> **Status: demo.** The plumbing (secure mail read → parse → sheet → dashboard)
> is production-shaped. The one part that must be tuned to real emails is the
> parser — see [Adapting the parser](#5-adapt-the-parser-to-your-real-emails).

---

## Files

| File | What it is |
| --- | --- |
| `purchase-order-reader.gs` | The whole backend: scheduled read, parse, and write. |
| `purchase-order-webapp.html` | The read-only dashboard (an Apps Script web app). |
| `appsscript.json` | The manifest — this is where the **least-privilege scopes** live. |

---

## Why this is secure (the part that matters most)

Security was the deciding factor in *how* this is built, not a feature bolted on
afterward. Seven concrete properties:

1. **No server exists.** The code runs on Google's infrastructure, woken by a
   time trigger. There is no host to breach, no port open to the internet, and
   nothing running at all while the trigger is idle. You cannot hack a server
   that does not exist.

2. **No credentials are stored.** There is no API key, service-account file,
   password, or refresh token anywhere in these files or the project. Access is
   the signed-in owner's own Google identity, granted through Google's consent
   screen. **Nothing secret is committed to GitHub.**

3. **The data never leaves the Workspace.** Mail is read from Millcreek's Gmail;
   rows are written to Millcreek's Sheet. The script makes **zero** outbound
   calls to any third party — there is nowhere else the data could travel to.

4. **Mail access is read-only.** The app holds the `gmail.readonly` scope and
   nothing broader. It physically cannot send, reply, forward, delete, or edit a
   message. The worst a bug or compromise could do to email is *read the
   purchase-order inbox it already reads.* (This is why the code uses the Gmail
   REST service instead of the convenient `GmailApp`, which would demand full
   send-and-delete access.)

5. **Sheet access is scoped to one file.** `spreadsheets.currentonly` lets the
   script write to *only* the spreadsheet it is attached to. It cannot open,
   read, or modify anything else in the shared Drive.

6. **Only trusted senders are parsed.** Mail is acted on only if it comes from an
   address or domain you explicitly listed in `poSenders`. The real email address
   is extracted from the `From` header first, so a spoofed display name cannot
   sneak past. Someone emailing the inbox from outside the allowlist gets ignored.

7. **The email body cannot attack the sheet.** Every text value is neutralised
   before it is written, so a malicious PO containing `=IMPORTDATA(...)` lands as
   literal text, never a live formula. The dashboard is read-only and limited to
   `@millcreekplants.com` sign-ins, re-checked on the server for every request.

**What this design deliberately does _not_ do:** send email, delete email, read
or change other files already in your Drive, contact any non-Google service, or
store any secret. The only files it creates are throwaway conversion documents
it deletes seconds later. The one outbound call it can make — only if you turn
on AI extraction — is to **your own** Google Cloud Vertex AI, authenticated with
the script's own Google login (no key). Each of the other doors is simply not
built.

### The exact permissions it asks for

These are declared in `appsscript.json`, so the consent screen shows precisely
this and nothing more. Each is the narrowest scope that still works:

| Scope | What it grants | What it cannot do |
| --- | --- | --- |
| `gmail.readonly` | Read messages and their attachments | Send, reply, delete, or edit any mail |
| `spreadsheets.currentonly` | Write to the one bound sheet | Open or touch any other Drive file |
| `drive.file` | Create and manage **only files this app itself creates** | See, read, or change anything else already in your Drive |
| `cloud-platform` + `script.external_request` | Call **your** Google Cloud Vertex AI (Gemini) to read messy PDFs | Only used to POST document text to Gemini; no other service is contacted |
| `script.scriptapp` | Create the 15-minute trigger | — |
| `userinfo.email` | See the signed-in address (for the domain lock) | Read any other profile data |

> The last two scopes appear **only if you turn on AI extraction** (`CONFIG.ai`).
> Leave it off and the app keeps the shorter scope list and uses the built-in
> regex parser. See [AI extraction](#ai-extraction-for-messy-pdfs) below.

> The read-only Gmail scope is only possible because the code uses the Gmail
> *advanced service* (enabled in the manifest). The convenient `GmailApp` class
> would force the far broader `https://mail.google.com/` scope — full send and
> delete — which is exactly what we avoid.
>
> `drive.file` exists only for reading PDF attachments (see below). It is the
> narrowest Drive scope there is: the app can touch the throwaway document it
> creates to read a PDF, and nothing else in your Drive — not even the
> spreadsheet, which is reached through its own `currentonly` scope.

### How a PDF order is read

Most suppliers send the order as a **PDF attachment**, not body text. To read
one, the script asks **Google's own converter** to turn the PDF into a
temporary Google Doc (this is what performs OCR on a scanned page, or lifts the
text out of a digital one), reads that Doc's text, and then **deletes the
temporary Doc immediately**. The PDF is never uploaded anywhere outside your
Workspace and never touches a third-party service — the conversion happens
inside Google. This is the *only* reason `drive.file` is requested.

### AI extraction (for messy PDFs)

Real supplier PDFs come in wildly different layouts — multi-column forms,
line items that wrap across several lines, `$0.00` label rows, multi-page
orders. Hand-written patterns are brittle against that variety. So the reader
can hand the extracted text to **Gemini** for structured extraction, which is
far more reliable across vendors.

It uses **Vertex AI** (Gemini inside Google Cloud), chosen deliberately for the
security posture:

- **Stays in Google.** The text goes to Vertex AI in *your own* Google Cloud
  project — not to a third-party AI service. Under Vertex AI's terms Google
  **does not use your prompts to train models**.
- **No API key to store.** It authenticates with this script's *own* Google
  login (`ScriptApp.getOAuthToken()`), so there is no secret saved anywhere —
  consistent with the rest of the design.
- **Optional and off by default.** With `CONFIG.ai.enabled = false` the two AI
  scopes are never requested and the regex parser is used. The regex parser
  also remains the automatic fallback if an AI call ever fails.

**One-time setup:**
1. Create (or pick) a **Google Cloud project** and note its **Project ID**.
   Enable billing (Gemini Flash is a fraction of a cent per PDF).
2. In that project, enable the **Vertex AI API**
   (APIs & Services → Enable APIs → "Vertex AI API").
3. Point this Apps Script at that project: **Project Settings (gear) → Google
   Cloud Platform (GCP) Project → Change project →** enter the project number.
4. In `CONFIG.ai`, set `enabled: true` and `project: '<your project ID>'`
   (adjust `location`/`model` if you like).
5. Run `setUp()` again and approve the new consent (it now lists Google Cloud
   and external-request access), then run `testAiExtraction()` to confirm it
   returns structured JSON, or `dumpLatestPdfText()` to see it read a real PDF.

---

## Setup (about ten minutes)

You need edit access to the destination Google Sheet and a
`@millcreekplants.com` account.

### 1. Open the script editor
Open (or create) the Google Sheet the orders should land in, in the shared
Drive. Go to **Extensions → Apps Script**. A new project opens, already bound to
that sheet.

### 2. Paste in the three files
- Paste `purchase-order-reader.gs` over the default `Code.gs`.
- **File → New → HTML file**, name it exactly `purchase-order-webapp`, and paste
  in `purchase-order-webapp.html`.
- Show the manifest with the **gear icon (Project Settings) → “Show
  ‘appsscript.json’ manifest file”**, then paste in `appsscript.json`. This step
  is what pins the least-privilege scopes and enables the read-only Gmail
  service and the Drive service used to read PDFs.
- Confirm both advanced services are on: in the editor sidebar click
  **Services (＋)** and make sure **Gmail API** and **Drive API** are both
  listed (pasting the manifest usually adds them; add any that is missing).

### 3. Edit `CONFIG`
At the top of `purchase-order-reader.gs`, set at least:
- **`poSenders`** — the supplier addresses or domains you trust. *Nothing runs
  until this has at least one entry.*
- **`searchQuery`** — tweak the subject words your suppliers actually use.
- **`workEmailDomain`** — already `millcreekplants.com`; leave it.

### 4. Run `setUp()` once
In the editor's function dropdown pick **`setUp`** and click **Run**. Google
shows a consent screen — **read it**: it should ask only to *view* your email,
manage *this* spreadsheet, and run the trigger. Approve it. This:
- creates the **Purchase Orders** tab with headers,
- installs one trigger that runs every 15 minutes, and
- marks "now" as the starting point (so it does not backfill your whole mailbox).

### 5. Adapt the parser to your real emails
This is the only code you should expect to touch.

Different suppliers format POs differently, so `parsePurchaseOrder_()` ships with
sensible generic patterns and a built-in test. To tune it:
1. Copy a **real purchase-order email**, remove anything you don't want in a
   commit, and paste the body into the `SAMPLE_PO` string near the bottom of the
   `.gs`.
2. Run **`runParserSelfTest`** and open **View → Logs**. It prints the order
   number, supplier, and every line item it found.
3. Adjust the regexes in `parseLineItem_()` / `parsePurchaseOrder_()` until the
   log matches the email. The comments explain each pattern.

Out of the box it already handles the common layouts:
- **pipe / Markdown tables** (how most PO emails present line items) —
  `| SKU | Botanical Name | Spec | Qty | Unit Price | Line Total |`. Columns are
  matched **by header name**, so a supplier can reorder or add columns without
  breaking anything, and the Vendor SKU and container spec are captured too.
  Non-item tables in the same email (a Ship-To / Bill-To block) are ignored
  because they have no quantity or price columns.
- **whitespace tables** — `Echinacea 'Magnus'   200   1.85   370.00`, and
- **inline lines** — `300 x Salvia May Night @ $1.40 = $420.00`.

The order number is only accepted when it follows an order/PO cue **and** a
`:` or `#` **and** contains a digit — so a heading like "PURCHASE ORDER SUMMARY"
or the phrase "purchase order on behalf of…" is never mistaken for one.

Two self-tests ship with the script: `runParserSelfTest` (pipe-table format)
and `runFallbackSelfTest` (plain-text supplier). Run either from the editor and
read **View → Logs**.

### 6. (Optional) Publish the dashboard
**Deploy → New deployment → Web app.** Set **Execute as: Me** and **Who has
access: <your organisation>** (`appsscript.json` already requests this). Share
the resulting URL with staff — only `@millcreekplants.com` accounts can open it.

---

## How it runs day to day

```
 every 15 min
      │
      ▼
 Gmail (read-only) ──► search + sender allowlist ──► parse each PO
                                                          │
                                          one row per line item
                                                          │
                                       neutralise text, append ▼
                                                    Purchase Orders sheet
                                                          │
                                                 read-only ▼
                                                    Dashboard (domain-locked)
```

Two independent guards stop duplicates, so a re-run or a resent email never
double-writes:
- a **timestamp watermark** (in Script Properties) skips messages already seen, and
- an **order-number check** against the sheet ignores a PO that is already logged.

---

## Adjusting later

| You want to… | Change |
| --- | --- |
| Trust another supplier | add to `CONFIG.poSenders` |
| Capture a new field | add a `{ header, key }` to `COLUMNS`, set that key in the parser |
| Check more / less often | the `everyMinutes(15)` in `ensureTrigger_()` |
| Be emailed if a run fails | put addresses in `CONFIG.alertOnErrorTo` |
| Widen the date window | the `newer_than:` in `CONFIG.searchQuery` |

---

## Troubleshooting

**First step for anything: run `runDiagnostics()`** from the editor's function
dropdown, then open **View → Logs**. It checks, in order, the things that stop
the app working and prints the senders of the emails your search is matching
(with whether each is trusted) — usually the answer is right there.

### The Sheet is not filling in

Most common causes, in order:
1. **`poSenders` is still the example** (`orders@example-supplier.com`). Your
   real supplier isn't trusted, so their email is skipped. `runDiagnostics()`
   line 3 flags this and line 4 shows the real sender address to add.
2. **`setUp()` was never run**, so there is no trigger and no watermark. Run it.
3. **The Gmail advanced service isn't enabled.** In the editor, click
   **Services (＋)**, add **Gmail API**, and save. (Line 4 of the diagnostics
   reports this.)
4. **The search doesn't match.** Widen `CONFIG.searchQuery` (e.g. the
   `newer_than:` window or the subject words).

### Orders arrive as PDF attachments

The reader converts each attached PDF to text with Google's own OCR (see
[How a PDF order is read](#how-a-pdf-order-is-read)). Two helpers make tuning
easy:
- **`dumpLatestPdfText()`** — run it, open **View → Logs**, and it prints the
  text extracted from your newest supplier PDF plus what the parser found. This
  is the fastest way to see how a supplier's PDF flattens to text so the parser
  can be adjusted to it (exactly how the email parser was tuned).
- **`backfillDays(14)`** — the scheduled reader ignores mail older than the
  watermark, so orders that arrived before `setUp()` are skipped. This looks
  back N days and runs once to pull them in; already-logged order numbers are
  de-duplicated.

PDF layouts vary a lot between suppliers, so expect to tune the parser's
patterns per supplier using `dumpLatestPdfText()`. Scanned/photographed PDFs are
OCR'd but are less reliable than digitally generated ones.

### The web app hangs on "Loading…" / the button does nothing

Almost always the page was **not opened from the deployed web app URL**. The
dashboard only works at a URL ending in **`/exec`** (or a **Test deployment**
URL) — opening the raw HTML file, or a stale deployment, leaves it unable to
reach the server. The hardened page now says this instead of hanging. If it
still stalls: **Deploy → Manage deployments**, confirm a web app deployment
exists and is on the current version, and that you approved the script's
permissions. A "Server error: …" or "Not authorised" message means the call is
reaching the server — read the message; "Not authorised" means you're signed in
with a non-`@millcreekplants.com` account.

### Will pushing new commits delete the purchase orders already captured?

**No.** The data lives in your **Google Sheet in Drive**, which is completely
separate from this GitHub repo and from the Apps Script code. Editing or
re-pasting the code never touches existing rows — the script only ever *appends*
rows and never deletes. Re-running `setUp()` only rewrites the header row and
re-checks the trigger; it leaves your data rows alone. (One caveat: this update
adds two columns — Vendor SKU and Spec/Size. If you already have rows from the
older layout, re-run `setUp()` to refresh the header; old rows keep their data
but will sit one or two columns to the left of the new headers, so a clean
re-import is tidiest if you captured orders under the old version.)

## Limits to be honest about (it's a proof of concept)

- **Extraction accuracy.** With AI on, Gemini reads varied supplier layouts well
  but is not infallible — spot-check totals against the PDF, especially for a new
  supplier or a "changed"/partial order. With AI off, the regex parser is more
  brittle and needs tuning per layout. Either way, `dumpLatestPdfText()` shows
  what was extracted so you can verify.
- **Cost & time.** Each PDF is converted through a temporary Google Doc, and (if
  AI is on) one Gemini call runs per document — a fraction of a cent each. Fine
  at nursery order volumes; not built for thousands a day.
- **Scanned/photographed PDFs** are OCR'd but less reliable than digitally
  generated ones.
- **~15-minute latency**, since it polls on a schedule rather than reacting the
  instant mail arrives. Fine for orders; not for anything real-time.
- **Owner-bound.** It runs as whoever set it up and approved the scopes. If that
  person leaves, someone else re-runs `setUp()` under their account.
- Best judged with a small pilot: a couple of real suppliers, watch the sheet for
  a week, tune the parser, then widen the allowlist.
