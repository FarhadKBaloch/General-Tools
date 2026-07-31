# Equipment maintenance log — QR codes on the machines

A maintenance request system for the tractor, gator, truck and sprayer — plus
ladders, stools, pallet jacks and everything else — that costs nothing, needs
no server, and takes about 45 minutes to set up.

Someone scans the sticker on the machine, a form opens with that equipment
already filled in, they describe the problem and submit. The Facilities Lead,
the Owner, and a Leadership Team member get an email within seconds, and the
request lands as a row in a spreadsheet you can filter and sort.

Equipment that breaks rarely doesn't need its own sticker. One **General
equipment** QR code covers all of it, and asks the person what they're looking
at.

---

## Is a QR code the right approach?

Yes — with one adjustment to what you described.

The instinct to build "an app where a QR code opens the equipment's page and you
tag people" is the right *idea*, but building it that way means hosting,
accounts, and a login prompt standing between a person in a dusty cab and a
30-second report. Whatever you build, the thing that decides whether this
succeeds is **how many seconds it takes a seasonal crew member holding a
greasy phone to file a report**. Everything else is secondary.

So: keep the QR codes, drop the app. Use **one Google Form with a pre-filled
link per item**, which gives you the same scan-to-report experience with
none of the infrastructure.

| | Google Form + Sheet | Custom app | Shared sheet, no form | Paper log |
|---|---|---|---|---|
| **Cost** | $0 | Hosting + your time | $0 | $0 |
| **Server to maintain** | None | Yes | None | None |
| **Works without a login** | Yes | Rarely | No | Yes |
| **Usable one-handed on a phone** | Yes | If well built | Poor | n/a |
| **Notifies people automatically** | Yes | Yes | No | No |
| **History is queryable** | Yes | Yes | Yes | No |
| **Time to first working version** | ~45 min | Weeks | ~15 min | 0 |

The one thing you give up is that a scan opens a *blank request form*, not a
page showing that equipment's service history. In practice the person scanning
is reporting a problem, not researching one — the history matters to whoever
does the repair, and they can open the sheet. If you later decide the history
does need to be at the point of scan, [see the upgrade path](#if-you-outgrow-this).

### One change to the "tagging" idea

You asked for the person to tag the Facilities Lead, a Leadership Team member,
and the Owner. Making all three a manual choice is a reliability problem: the
crew member who finds the hydraulic leak is often the one least likely to know
who's on the Leadership Team, and a request tagged to nobody is a request that
gets lost.

What's set up here:

- **Facilities Lead and Owner are notified automatically**, on every request.
  No one has to remember, and no one can forget.
- **The Leadership Team member is a dropdown** the requester picks, since that
  one genuinely varies. If they skip it or pick "no preference", it falls back
  to an address you choose, so a request is never delivered to nobody.

That gives you exactly the three-way notification you asked for, with two of
the three impossible to get wrong.

---

## What you're building

```
   Sticker on the tractor
            │  scan
            ▼
   Google Form, equipment pre-filled     ← one form, one pre-filled link per item
            │  submit
            ▼
   Google Sheet (the maintenance log)  ← every request, permanently, sortable
            │
            ▼
   Apps Script emails 3 people         ← Facilities Lead + Owner + Leadership pick
```

Files in this repo that you'll use:

| File | What it does |
|---|---|
| `equipment-qr-labels.html` | Open in a browser. Generates printable QR labels. |
| `qr.js` | The QR encoder the label page uses. No dependencies. |
| `maintenance-notify.gs` | Paste into the sheet's Apps Script. Sends the emails. |
| `maintenance-webapp.html` | Paste in alongside it. The phone-friendly view of the log. |
| `qr.test.js` | `node qr.test.js` — checks the encoder still works. |

---

## Step 1 — Build the form (15 minutes)

Go to [forms.google.com](https://forms.google.com) and create a blank form
called **Equipment Maintenance Request**.

Add these questions. The titles matter — the script looks for them by name, and
if you reword one you must update `CONFIG.questions` in the script to match.

| # | Question title | Type | Required | Options |
|---|---|---|---|---|
| 1 | `Equipment` | Multiple choice | Yes | Tractor, Gator, Truck, Sprayer, **General equipment** |
| 2 | `Which item, and where is it?` | Short answer | No | See below — this is what makes the catch-all bucket work |
| 3 | `How urgent is it?` | Multiple choice | Yes | `Safety issue - do not operate`, `Down - cannot be used`, `Needs attention soon`, `Routine / next service` |
| 4 | `What needs attention?` | Paragraph | Yes | — |
| 5 | `Your name` | Short answer | Yes | — |
| 6 | `Leadership Team contact` | Dropdown | Yes | The names of your leadership team, plus `Any / no preference` |
| 7 | `Photo` | File upload | No | Requires the submitter to be signed in — see the warning below |
| 8 | `Hours / mileage reading` | Short answer | No | — |

Question 1's options must be spelled **exactly** the way you'll type the
equipment names into the label generator later. `Tractor` and `Tractor ` (with a
trailing space) are different answers as far as Google is concerned.

### The "General equipment" bucket

Step stools, ladders, pallet jacks, hand tools, hose reels — things that break
once a year and don't warrant their own sticker. Giving each one a QR code
means printing and maintaining forty labels for maybe six reports a season.
Instead, one **General equipment** option covers all of it, with a single QR
code you can put in the shop, the headhouse and by the loading dock.

The catch: a request that says only "General equipment" tells the Facilities
Lead nothing. A cracked ladder rung and a pallet jack that won't lift are not
the same job, and they aren't in the same place. That's what question 2 is for.

The script handles this for you. When the answer is **General equipment**, the
item becomes the headline everywhere it matters:

| Answers | What the email subject says |
|---|---|
| Tractor | `MNT-0007: Tractor needs maintenance` |
| General equipment + "Step ladder, Greenhouse 3" | `MNT-0007: Step ladder, Greenhouse 3 (General equipment) needs maintenance` |
| General equipment, item left blank | `MNT-0007: General equipment — item not specified needs maintenance` |

That last row is deliberate. A blank item is visible in the subject line rather
than producing a request nobody can act on.

**Make the item question required only for the catch-all.** In Google Forms,
open question 1's **⋮** menu and choose **Go to section based on answer**. Send
the named equipment straight to the urgency question, and send **General
equipment** to a short section containing a *required* "Which item, and where is
it?" question. That way the tractor's QR code doesn't ask a question its sticker
already answered, and the general one can't be submitted without saying what
broke.

If section branching feels like more fiddling than it's worth, leave question 2
as a plain optional question. Everything still works; you'll just occasionally
get an "item not specified" that needs a follow-up. Give it the description:

> *Only needed for general equipment — which ladder, which pallet jack, and
> where is it?*

### Settings to change

Open **Settings** (the gear icon):

- **Collect email addresses** → `Responder input`. This lets the script set the
  reply-to address, so leadership can reply straight to whoever reported it.
- **Limit to 1 response** → **off**. Leave this off or people can only ever
  file one request, forever.
- **Edit after submit** → on, so someone can correct a typo.

> **The one thing that will break this for your crew:** if your form is
> restricted to people in your organisation, anyone without a company Google
> account gets a sign-in wall instead of the form. Seasonal crew usually don't
> have one. Under Settings → Responses, make sure the form is **not** limited to
> users in your organisation. The trade is that the form is technically open to
> anyone with the link — for an internal maintenance log that's a fine trade,
> but it does mean skipping the **file upload** question, which always requires
> sign-in. If photos matter more than open access, keep the upload and accept
> that only account holders can file.

Finally: **Responses** tab → **Link to Sheets** → *Create a new spreadsheet*.
Name it **Equipment Maintenance Log**. This sheet is now your permanent record.

---

## Step 2 — Wire up the notifications (10 minutes)

In the **spreadsheet** (not the form), choose **Extensions → Apps Script**.

1. Delete the placeholder `function myFunction() {}`.
2. Paste in the entire contents of `maintenance-notify.gs`.
3. Edit the `CONFIG` block at the top — real email addresses for the Facilities
   Lead and the Owner, and the leadership names spelled exactly as they appear
   in the form dropdown.
4. Click **Save**, then choose `setUp` in the function dropdown and press **Run**.
5. Google will ask you to authorise the script. Click through
   *Review permissions → (your account) → Advanced → Go to (project name) → Allow*.
   The "unverified app" warning is expected: you are the developer, and the
   script only touches this one spreadsheet and sends mail as you.

`setUp` adds five tracking columns to the sheet — **Ticket**, **Status**,
**Assigned to**, **Closed on**, **Work done / notes** — and installs the
triggers. It's safe to run more than once.

To confirm it works before printing anything: **Maintenance → Send test email**
from the spreadsheet menu bar. If it doesn't appear, the addresses in `CONFIG`
are the first thing to check.

---

## Step 3 — Get one pre-filled link (2 minutes)

This is the trick the whole system rests on. A Google Form can have a value
pre-selected via the URL, so **one form** serves every piece of equipment — you just
point each QR code at a different version of the link.

In the **form**, click the **⋮** menu (top right) → **Get pre-filled link**.
Select any one item — it doesn't matter which — then click **Get link** and
**Copy link**.

You'll get something like:

```
https://docs.google.com/forms/d/e/1FAIpQLSd.../viewform?usp=pp_url&entry.1234567890=Tractor
```

That `entry.1234567890` is the internal ID of your Equipment question. Keep the
link on your clipboard.

> Don't use the short `forms.gle` link for this — shortened links drop the
> pre-fill, and every QR code would open a blank form.

---

## Step 4 — Generate and print the labels (10 minutes)

Open `equipment-qr-labels.html` in any browser (double-click it; it needs
`qr.js` sitting next to it). Nothing is uploaded — the QR codes are generated
in the page itself.

1. Paste the pre-filled link into **Pre-filled form link**. The page will
   confirm which field it found.
2. Type your equipment names, one per line, spelled exactly as in the form —
   including `General equipment`:

   ```
   Tractor
   Gator
   Truck
   Sprayer
   General equipment
   ```

3. Leave **error correction** on **Q (25%)** — that's the level that keeps
   working when a label picks up scratches and dust.
4. Click **Generate labels**, then **Print** (or print to PDF).

Each label is the equipment name and the code, and nothing else. A sticker on
a machine is read at arm's length by someone who already knows what they are
standing in front of; instructions on it are just ink that makes the code
smaller.

### Making them survive a farm

The labels are the part most likely to fail, and it won't be the software's
fault:

- **Print at 2 per row or larger.** These codes carry a long URL, so they have
  a lot of small squares. At 2-per-row on letter paper each code is about
  2.5 inches, which scans reliably from a couple of feet in bright sun. At
  4-per-row they're marginal for older phones.
- **Laminate them, or print on outdoor vinyl.** A paper label in a tractor cab
  lasts one humid Ohio August.
- **Mount them where the operator sits**, not on the engine cowl. Somewhere
  that doesn't get pressure-washed, sprayed, or sat on.
- **Print several copies of the general-equipment label.** It is the one that
  should be in more than one place — the shop wall, the headhouse, by the
  loading dock, the pallet-jack corner. It costs nothing to reprint.
- **Test each one with a phone before it goes on the machine.** Scan it, check
  the form opens with the right equipment already selected. Two minutes now
  beats discovering in May that the sprayer's label points at the truck.
- **Print a couple of spares of each** and keep them in the shop.

---

## Step 5 — How it runs day to day

**Someone finds a problem:** scan, describe, submit. Under a minute.

**The three notified people get an email** with the equipment, urgency, the
description, who reported it, and a button that opens that row of the log.
Safety and down-machine reports arrive with `[URGENT]` in the subject line and
a red banner.

**Whoever does the work** sets **Status** to `In progress`, then `Done`, and
writes what they did in **Work done / notes** — either in the sheet or, more
likely, from their phone in the web app ([Step 6](#step-6--using-the-log-on-a-phone)).
Marking it `Done` stamps the date and emails the same three people that it's
closed, whichever way it was closed.

**Once a month**, sort the log by Equipment. Four repairs on the same hydraulic
line is a pattern that's invisible when the reports live in text messages,
and that pattern is the actual return on doing this — it's what turns
"the gator's acting up again" into a replace-or-repair decision you can defend
with dates.

A few things worth setting up once you've used it for a season:

- Add a **Filter view** per item so anyone can see one machine's history.
- Add a `Cost` column and you have annual spend per machine.
- Google Sheets has scheduled emails via Apps Script if you want a Monday
  morning "still open" digest — a natural next addition to the same script.

---

## Step 6 — Using the log on a phone

A spreadsheet is a poor fit for a phone, and no amount of formatting fully
fixes that: the Google Sheets mobile app shows you roughly three columns at a
time, editing a cell means pinching and scrolling, and this log is twelve
columns wide. So there are two answers here, and you'll probably use both.

### The sheet itself, made as readable as a sheet gets

`setUp` now also formats the log for skimming:

- **Sensible column widths** — narrow for the ones you glance at, wide for the
  problem description, which wraps instead of running off the screen.
- **Colour-coded Status**, so you can tell open from done without reading.
- **Red urgency cells** for safety and down-machine reports, visible while
  scrolling past.
- **A frozen header row**, so column meanings survive scrolling.

It deliberately does **not** reorder your columns. Google Forms writes
responses by column position, and shuffling columns on a linked response sheet
is a well-known way to end up with answers landing in the wrong place.

It also adds a tab called **"On my phone"** — a live, five-column view of open
requests only, newest first, that fits a phone screen without sideways
scrolling. It's a formula, not a copy, so it's always current. Open it read-only
on a phone when you just need to know what's outstanding.

The honest limit: that tab is for *reading*. Updating a request still means the
full sheet, which is where the web app comes in.

### The web app — the real fix

Apps Script can publish a web page, hosted by Google, for free. That gives you
an actual mobile app: cards instead of a grid, tap to expand, thumb-sized
controls, filter chips per item, and a Save button that writes straight back
to the sheet.

**To deploy it:**

1. In the Apps Script editor: **File → New → HTML file**. Name it exactly
   `webapp` (Google adds the `.html` itself).
2. Paste in the entire contents of `maintenance-webapp.html` and save.
3. Optional: put your form's share link in `CONFIG.formUrl` so the app gets a
   **New request** button.
4. **Deploy → New deployment → Web app**.
   - *Execute as:* **Me**
   - *Who has access:* **Anyone** if your crew have no Google accounts, or
     **Anyone within (your organisation)** if they do — the tighter option is
     better whenever it's workable.
5. Copy the web app URL. On a phone, open it and use **Add to Home Screen** —
   it then launches full-screen with its own icon, like any other app.

What you get:

- **Open requests as cards**, urgent ones flagged red and sorted to the top of
  your attention rather than buried in row 47.
- **Filter chips** — open only, or one piece of equipment at a time.
- **Tap Update** to change status and add notes, then Save. Closing a request
  from the app emails everyone exactly as closing it in the sheet does.
- **A running count** of what's open and how much of it is urgent.
- Dark mode, and no sideways scrolling at any phone size.

One thing worth knowing: *Execute as Me* means the app reads and writes the
sheet with your permissions, so people using it don't need access to the
spreadsheet itself — which is usually what you want. The flip side is that
anyone with the URL can update requests. For an internal maintenance log that's
the same trust model as the form itself, but it is a deliberate choice rather
than an accident.

> **If you deploy an updated version later**, use **Deploy → Manage deployments
> → Edit → Version: New version**. Creating a *new deployment* instead mints a
> different URL and everyone's home-screen icon keeps pointing at the old one.

---

## Upgrading an install that's already running

If you already have the form, sheet and script live, you are not rebuilding
anything. Your data, ticket numbers and QR stickers all stay as they are.

**Nothing to redo:** the form is unchanged, so **the printed QR codes still
work** — don't reprint them. Existing rows keep their ticket IDs, statuses,
notes and close dates. `setUp` skips columns that already exist and replaces
its own triggers rather than adding a second copy, so it's safe to re-run.

### The steps

1. **Make a backup first.** In the spreadsheet: **File → Make a copy**, name it
   something like `Maintenance Log — backup before upgrade`. Takes five seconds
   and means any surprise is a one-click undo.

2. **Save your CONFIG before you overwrite it.** Open **Extensions → Apps
   Script**, select the whole `CONFIG = { … }` block — from `var CONFIG = {`
   down to the closing `};` — and paste it somewhere safe. This is the only
   part of the script that holds your real email addresses, and step 3 wipes
   it.

3. **Replace the script.** Click into the code, select all (`Ctrl/Cmd + A`),
   and paste in the whole of the new `maintenance-notify.gs`.

4. **Paste your CONFIG back** over the new placeholder one. Your old block is
   missing the new `formUrl` setting, and that's fine — it's optional and
   defaults to empty. Add it if you want the app's **New request** button:

   ```js
   formUrl: 'https://forms.gle/your-form-link',
   ```

5. **Add the web app page.** **File → New → HTML file**, named exactly
   `webapp`, and paste in `maintenance-webapp.html`. Save.

6. **Run `setUp`.** Pick it from the function dropdown and press Run. Google may
   ask you to re-authorise — that's expected, the script gained new abilities.
   This adds the formatting, builds the "On my phone" tab, and reinstalls the
   triggers.

7. **Deploy the web app**, per [Step 6](#step-6--using-the-log-on-a-phone).

8. **Check it worked:** the log should now be colour-coded, an "On my phone"
   tab should exist listing only open requests, and **Maintenance → Send test
   email** should still arrive.

### What does get overwritten

Two things, both cosmetic, both only if you customised them:

- **Column widths** you set by hand are replaced with the script's.
- **Conditional formatting rules on the Status and urgency columns** are
  replaced. Rules you added on *other* columns are left alone.

And one thing that will stop you rather than break anything: if you happen to
already have a tab named **"On my phone"**, `setUp` refuses to touch it and
tells you to rename it first, rather than clearing whatever is in it.

> **Going back**, if you ever want to: paste the old script over the new one and
> run `setUp`. The extra columns and the mobile tab are additive — nothing in
> the new version changes how a response is recorded, so old and new script
> versions read the same sheet identically.

### Going from vehicles to all equipment

If your log started life tracking only vehicles, this is an additive change too.
**Your existing QR codes keep working and your history stays intact** — there is
no data migration.

The one thing to know: renaming a question in Google Forms does **not** rename
the matching column in the linked sheet. Your log will keep its `Vehicle`
header even after the form says `Equipment`. That's fine — the script accepts
either, which is why `CONFIG.questions.equipment` is a list:

```js
equipment: ['Equipment', 'Vehicle'],
```

It looks for `Equipment` first and falls back to `Vehicle`, so a season of
history recorded under the old header keeps reading correctly. Leave both in
the list; there is no benefit to removing the old one.

**In the form:**

1. Rename question 1 from `Vehicle` to `Equipment`.
2. Add `General equipment` as a new option on it.
3. Add the new short-answer question, `Which item, and where is it?`, and
   optionally set up the branching described in
   [Step 1](#the-general-equipment-bucket).
4. Rename the form itself to *Equipment Maintenance Request*.

**In the sheet:** nothing. Google appends the new question as a new column on
the right, and old rows simply have it blank. If you'd rather the header said
`Equipment`, you can retype that one header cell by hand — safe, since the
script matches on header text, not position — but you don't have to.

**Then:** paste in the new script (keeping your CONFIG, per the steps above),
run `setUp`, and print one more label for `General equipment`. Nothing else
needs reprinting.

If you skip the new question entirely, everything still runs — the phone tab
just leaves out the item column, and general-equipment requests arrive saying
"item not specified".

---

## What this costs and where the limits are

Nothing, and the ceilings are far above what you'll use:

| Limit | Free Gmail account | Google Workspace |
|---|---|---|
| Emails per day from the script | 100 recipients | 1,500 recipients |
| Form responses | Unlimited | Unlimited |
| Rows in the sheet | 10 million cells | 10 million cells |

With a handful of machines and three recipients per request, the free-Gmail ceiling is
roughly 33 requests a day. If you're filing 33 maintenance requests a day, the
email quota is not your problem.

Honest limitations:

- **Anyone with the link can submit**, if you left the form open so crew
  without Google accounts can use it. Spam is theoretically possible; in
  practice the link only exists on stickers in your equipment. The log is
  append-only from the form side, so a bad entry is deleted, not damaging.
- **The script runs as you.** Notification emails come from your address, and
  if you leave the company someone must re-run `setUp` under a new account.
  Consider creating the form under a shared/role account from the start if
  that matters.
- **No offline capability.** A scan in a dead-signal corner of the property
  won't submit. The form will hold the page but not the submission — the
  fallback is filing it back at the shop.
- **No parts inventory, no scheduled-service reminders.** This tracks reported
  problems, not a preventive maintenance calendar.

---

## If you outgrow this

In rough order of effort, if the simple version stops being enough:

1. **Point the QR codes at the web app instead of the form.** Now that the web
   app exists, this is the short path to "scanning takes you to the equipment":
   add a `?equipment=Tractor` parameter to the web app URL, read it in `doGet`,
   and open the app pre-filtered to that machine with its history and a *Report
   a problem* button. Switch the label generator's **Link source** to "A
   separate link for each item" and give each one its own URL. An hour or
   two, and no new hosting — Google is already serving the page.
2. **Scheduled service reminders**, by adding an hours/mileage threshold per
   equipment and a daily Apps Script check.
3. **A real CMMS** (Fiix, UpKeep, Limble all have free tiers) once you're
   tracking parts inventory, labour cost per repair, and warranty claims. Move
   when the spreadsheet genuinely hurts, not before — and by then you'll have
   a season of real data to import and a crew already in the habit of
   scanning, which is the hard part of any rollout.

---

## Troubleshooting

**The QR code opens a blank form with no equipment selected.**
The link was shortened, or copied from the address bar rather than from *Get
pre-filled link*. It must contain `usp=pp_url&entry.` — regenerate it.

**The equipment name shows in the URL but the form doesn't select it.**
The spelling doesn't match the form's answer option exactly. Check for trailing
spaces, and for `#` or `&` in an equipment name (those are fine — the generator
escapes them — but retyping them by hand in the form is where mismatches creep in).

**No emails arrive.**
Run **Maintenance → Send test email** from the sheet. If the test works but
real submissions don't, the trigger didn't install: re-run `setUp`. Check spam
on the recipients' side once — the first message from a new script often lands
there, and marking it "not spam" fixes it permanently.

**A general-equipment request arrives saying "item not specified".**
Whoever filed it skipped question 2. Set up the branching in
[Step 1](#the-general-equipment-bucket) so that question is required when the
answer is `General equipment` — the form can then only be submitted with it
filled in.

**General-equipment requests show the bucket name instead of the item.**
`CONFIG.generalEquipment` must match the form's answer option exactly. If the
form says `General Equipment` and the config says `General equipment`, the
match still works (it ignores case), but a different wording like
`Other equipment` will not — update the config to match the form.

**The Leadership Team member never gets the email.**
The key in `CONFIG.leadership` must match the dropdown option character for
character. Copy the option text out of the form and paste it into the script
rather than retyping it.

**`setUp` fails with "Could not find the form responses tab".**
The form isn't linked to the spreadsheet yet. In the form: Responses → Link to
Sheets.

**The web app shows "Script function not found: doGet".**
The HTML file isn't named `webapp`, or `maintenance-notify.gs` wasn't saved
before deploying. Both files must be in the same Apps Script project.

**The web app loads but shows no requests.**
Check that the form is linked to the sheet and that at least one response
exists. If the sheet has rows but the app is empty, the tracking columns are
missing — run `setUp` again.

**Saving in the web app says "The log changed since this list was loaded".**
Someone deleted or inserted a row while your phone had the list open, so the
row numbers shifted. This is the safety check doing its job rather than writing
your update onto someone else's request — tap ↻ to refresh and redo it.

**Closing a request in the web app didn't email anyone.**
Check `notifyOnClose` is `true` in `CONFIG`. Note that closing it *twice* only
notifies once, by design.

**The "On my phone" tab shows a `#REF!` or `#VALUE!` error.**
It's rebuilt by `setUp`, so run that again — most often this means a column was
renamed or deleted. Don't edit that tab by hand; it's generated.
