# Equipment maintenance log — QR codes on the machines

A maintenance request system for the tractor, gator, truck and sprayer — plus
ladders, stools, pallet jacks and everything else — that costs nothing, needs
no server, and takes about 45 minutes to set up.

Someone scans the sticker on the machine, the app opens already knowing which
machine it is, they tap **Create ticket** and describe the problem. The
Facilities Lead, the Owner, and a Leadership Team member get an email within
seconds, and the request lands as a row in a spreadsheet you can filter and
sort.

Equipment that breaks rarely doesn't need its own sticker. One **General
equipment** QR code covers all of it, and asks the person what they're looking
at.

---

## Why this shape

The thing that decides whether a maintenance log succeeds is **how many seconds
it takes a seasonal crew member holding a greasy phone to file a report**.
Everything else is secondary.

So the whole system is a QR sticker, an app page, and a spreadsheet — no server,
no accounts, no hosting bill.

| | This (app + Sheet) | A real CMMS | Shared sheet, no app | Paper log |
|---|---|---|---|---|
| **Cost** | $0 | $30–200/mo | $0 | $0 |
| **Server to maintain** | None | Theirs | None | None |
| **Works without a login** | Yes | Rarely | No | Yes |
| **Usable one-handed on a phone** | Yes | Usually | Poor | n/a |
| **Notifies people automatically** | Yes | Yes | No | No |
| **History is queryable** | Yes | Yes | Yes | No |
| **Time to first working version** | ~1 hour | Days | ~15 min | 0 |

**The one honest cost of the app** over a bare Google Form: an Apps Script web
app cold-starts in roughly 2–4 seconds, where a form opens in under one. In
exchange you get the service history, search, the dashboard, and photos — none
of which a form can do. If the wake-up ever becomes the thing people complain
about, the backup form stickers are still live and still work.

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
   The app opens on Home               ← the machine is already known
            │  Create ticket
            ▼
   Google Sheet (the maintenance log)  ← every request, permanently, sortable
            │
            ▼
   Apps Script emails 3 people         ← Facilities Lead + Owner + Leadership pick
```

Crew only ever see the app. The Google Form still exists behind it and still
works — it is the backup route if the app is slow to wake or someone has an
older sticker — but nothing points people at it. Both routes write the same
row, take a number from the same sequence, and send the same email.

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

## Step 3 — Get the link the QR codes will use (2 minutes)

Deploy the web app first ([Step 6](#step-6--using-the-log-on-a-phone)), then
copy its URL: **Deploy → Manage deployments → copy the web app URL**. It ends
in `/exec`.

That single URL is all the label generator needs. It appends `?equipment=<name>`
per machine, so the tractor's sticker opens the app already knowing it is the
tractor.

> Use the `/exec` deployment URL, not the `/dev` one. A `/dev` link only works
> for you, while signed in — crew would get an error.

### If you also want backup form stickers

A Google Form can have a value pre-selected via the URL, so one form serves
every machine. In the **form**, click the **⋮** menu → **Get pre-filled link**,
select any one item, then **Get link** → **Copy link**. It looks like:

```
https://docs.google.com/forms/d/e/1FAIpQLSd.../viewform?usp=pp_url&entry.1234567890=Tractor
```

Feed that to the label generator's *pre-filled Google Form link* mode. Don't use
the short `forms.gle` link — shortened links drop the pre-fill, and every code
would open a blank form.

---

## Step 4 — Generate and print the labels (10 minutes)

Open `equipment-qr-labels.html` in any browser (double-click it; it needs
`qr.js` sitting next to it). Nothing is uploaded — the QR codes are generated
in the page itself.

1. Leave **Link source** on **The maintenance app** and paste the web app URL.
   The page shows you what one label will open.
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

The app has three tabs along the bottom, where a thumb can reach them.

### Home — where a scan lands

The wordmark, a **Create ticket** button, and how many requests are open and
urgent. If they arrived by scanning the tractor's sticker, Home says so and
lists what is already open against that machine — so two people don't file the
same fault twice — and Create ticket opens with **Tractor** already chosen.

**Create ticket** does everything the Google Form did, without leaving the app:
equipment, urgency, what's wrong, who's reporting it, and which Leadership Team
member to copy. It asks *Which item, and where is it?* only when the answer is
**General equipment**, so the tractor's sticker never asks a question it already
answered.

Two small things that matter in practice:

- **Reported by fills itself in** with the signed-in person's work address, so
  nobody types their name and the notification email can be replied to
  straight back to them. It stays editable, for filing on someone else's
  behalf. **This only works if the web app's access is restricted to your
  organisation** — see the trade below. When it can't tell who the viewer is,
  the field falls back to the name remembered on that phone.
- **A photo can be attached** — a cracked weld is worth more than a paragraph.
  It's resized on the phone before it's sent (long edge 1600px, JPEG), because a
  raw camera file is several megabytes over farm signal. The photo lands in a
  Drive folder and the link goes into the sheet, the email, and the request card.

### Open — what needs doing

- **Requests as cards**, urgent ones flagged red rather than buried in row 47.
- **Filter chips** — open only, or one piece of equipment at a time.
- **Tap Update** to change status and add notes, then Save. Closing a request
  from the app emails everyone exactly as closing it in the sheet does.
- **A running count** of what's open and how much of it is urgent, and a badge
  on the tab itself when something urgent is waiting.

### History — the full service record, searchable

- **Pick a machine** to see everything ever logged against it, newest first,
  including what was done about it. This is the tab to open before deciding
  whether to repair or replace something.
- **Search** matches ticket number, machine, item, problem text, who reported
  it, the work notes and the status. Every word has to match somewhere, so
  `tractor brake` narrows rather than widening.
- Ticket search is forgiving: `7`, `MNT-7` and `mnt-0007` all find MNT-0007.
- **It searches the whole log on the server**, not just what your phone has
  loaded, and returns a page at a time — so a five-year history never lands on
  a phone at once. History cards are read-only; the Open tab is where things
  get changed.

### Dashboard — for whoever has to answer for the backlog

- **Backlog**: a single large figure for what's open, with two ring meters
  qualifying it — how many are urgent, and how many have been sitting longer
  than a week — plus the oldest one still open.
- **Where the backlog sits**: a ring showing the open requests split by stage.
  Deliberately only the *live* states: a ring of every status ever logged would
  be nine-tenths "Done" and answer nothing. Every segment is named and counted
  in the legend beside it, so it never has to be read by colour alone.
- **Out of service now**: anything reported as a safety issue or unusable and
  still open, with how many days it has been down.
- **Requests per machine** over the last twelve months. This is the number that
  turns "the gator's playing up again" into a decision you can defend.
- **Days out of service** per machine — the operational cost of a breakdown, as
  distinct from how often it happens. Still-open ones count to today.
- **Every request by status**, so the totals reconcile against the sheet.

Everything on the dashboard is counted on the server and only the totals travel
to the phone, so it stays fast no matter how long the log gets. It is also
cached for 90 seconds, and any new ticket or status change clears that cache
immediately — so the numbers never disagree with the list you just changed.

**Tab switching is instant** because the History and Dashboard tabs are fetched
quietly in the background as soon as Home has loaded, rather than when you first
tap them. On Apps Script the first request of a session carries the cold start;
warming the others while someone is still reading Home hides it. Two settings in
`CONFIG` control it:

```js
agingAfterDays: 7,        // an open request older than this counts as "aging"
dashboardWindowDays: 365  // how far back the per-machine figures look
```

### The Equipment tab — changing the fleet without redeploying

`setUp` creates an **Equipment** tab in the spreadsheet, seeded from
`CONFIG.equipment`. From then on **that tab is the source of truth**: one
machine per row, and the app reads it fresh every time it loads.

That matters because a fleet list changes — machines get renamed, teams get
split — and everything else in `CONFIG` only reaches the app when you create a
**new deployment version**. Equipment is the setting most likely to change and
the one you least want to redeploy for, so it lives where you can edit it.

To add or rename a machine: type it on the tab. That's the whole job. The next
person to open the app sees it. (Renaming does not rewrite history — old
requests keep the old name, which is correct: that is what they were filed
against. Print a new sticker for the new name.)

Blank rows and duplicates are ignored, and names are trimmed. If the tab is
deleted the script falls back to `CONFIG.equipment`, so nothing breaks.

The rest of the Create ticket form still comes from `CONFIG`:

```js
urgencyOptions: [ ... ],              // most serious first
photoFolder: 'Equipment maintenance photos',
photoLinkSharing: true                // see below
```

> **On `photoLinkSharing`.** Photos go into a folder in *your* Drive, and the
> people getting the email aren't all in it. With this on, each photo gets a
> view-only link that works for anyone who has it — which is what makes the
> link in the email usable. Turn it off if you'd rather share the folder by
> hand; the photo is still saved and still linked, it just won't open for
> everyone. Nothing else in the app is affected either way.

The dashboard is visible to anyone who can open the app. There's no sign-in to
hang a permission on, and a crew member seeing the backlog is usually a good
thing rather than a risk.

Throughout: dark mode, 44px touch targets, and no sideways scrolling at any
phone size.

One thing worth knowing: *Execute as Me* means the app reads and writes the
sheet with your permissions, so people using it don't need access to the
spreadsheet itself — which is usually what you want. The flip side is that
anyone with the URL can update requests. For an internal maintenance log that's
the same trust model as the form itself, but it is a deliberate choice rather
than an accident.

> **The trade behind the auto-filled address.** Google only tells the script
> who is looking when the deployment's *Who has access* is **Anyone within
> your organisation**. Set to **Anyone**, every viewer is anonymous: the field
> is typed by hand and the notification has no reply-to. Restricting access
> makes the app identify people properly, but locks out anyone without a
> company Google account — seasonal crew, most often. Pick whichever costs you
> less; both work, and `CONFIG.workEmailDomain` guards against someone signed
> into a personal account being recorded as the reporter.

> **If you deploy an updated version later**, use **Deploy → Manage deployments
> → Edit → Version: New version**. Creating a *new deployment* instead mints a
> different URL and everyone's home-screen icon keeps pointing at the old one.

---

## Deploying an update

Whether you're a version behind or several, the sequence is the same. Nothing
here touches your data: rows, ticket numbers, statuses, notes and close dates
all survive, and `setUp` is safe to run as many times as you like.

**Back up first.** In the spreadsheet, **File → Make a copy**. Five seconds, and
it makes any surprise a one-click undo.

### 1. Note your own settings

Open **Extensions → Apps Script** and copy these five values somewhere:

```js
facilitiesLead, owner, leadership { … }, leadershipFallback, formUrl
```

> **Do not paste your whole old `CONFIG` block over the new one.** That was the
> right advice when the config had eight settings; it now has seventeen, and the
> new ones are not optional. An old block silently leaves `equipment` and
> `urgencyOptions` empty, which kills **Create ticket** in the app — the list
> comes up blank and every submission is rejected — while everything else
> carries on working, so it is easy to miss. Copy your *values* into the new
> block, not the other way round.

### 2. Replace the script

Select all in the editor and paste in the whole of `maintenance-notify.gs`.
Put your five values back, then check the settings that describe your equipment:

```js
equipment:      ['Tractor', 'Gator', 'Truck', 'Sprayer', 'General equipment'],
urgencyOptions: [ … ],          // most serious first
generalEquipment: 'General equipment',   // must be one of `equipment`
urgentAnswers:  [ … ]           // each must be one of `urgencyOptions`
```

Those last two lines are the easiest thing to get quietly wrong, and step 5
checks them for you.

### 3. Add or replace the app page

**File → New → HTML file**, named exactly `webapp`, and paste in
`maintenance-webapp.html`. If you already have one, select all and replace it.
Save.

### 4. Run `setUp`, and re-authorise

Pick `setUp` from the function dropdown and press **Run**.

Google will ask for permission again, because this version needs **Drive
access** to save photos and it did not before. Click through
*Review permissions → your account → Advanced → Go to (project) → Allow*.
The "unverified app" warning is expected — you are the developer.

### 5. Run `healthCheck`

Either way works:

- **From the spreadsheet:** **Maintenance → Health check**. The report opens in
  a dialog. If you don't see the Maintenance menu, reload the spreadsheet tab —
  the menu is added when the file opens, so it won't appear in a tab that was
  already open when you pasted the script.
- **From the Apps Script editor:** pick `healthCheck` in the function dropdown
  next to **Run** — the one that probably says `setUp` — and press **Run**. The
  report appears in the **Execution log** panel at the bottom.

It checks everything easy to get quietly wrong in one pass: placeholder
addresses still in place, an empty equipment or urgency list, a
`generalEquipment` value that isn't one of the equipment options, an entry in
`urgentAnswers` that no longer matches `urgencyOptions`, missing tracking
columns, missing triggers. Fix what it lists and run it again until it says
*All good*.

A clean run looks like this:

```
All good. Nothing in CONFIG or the log looks wrong.

Log: Form Responses 1, 47 requests.
```

and a run with something to fix looks like this:

```
Found 2 thing(s) to fix:

• equipment is empty — Create ticket in the app will have nothing to choose.
• The log has no "Photo" column. Run setUp.
```

`healthCheck` only reads; it never changes anything, so it's safe to run
whenever you want to know where things stand.

### 6. Deploy the web app

- **If you have deployed the app before:** **Deploy → Manage deployments →**
  pencil icon **→ Version: New version → Deploy**. This keeps the same URL, so
  every printed sticker and home-screen icon keeps working.
- **If this is your first web app deployment:** **Deploy → New deployment →**
  gear icon **→ Web app**. Set *Execute as* **Me** and *Who has access*
  **Anyone** (or **Anyone within your organisation** if all your crew have
  accounts). Copy the URL it gives you — it ends in `/exec`.

> Creating a *new deployment* when you meant to update an existing one mints a
> **different URL**, and every sticker keeps opening the old version. If you do
> it by accident, delete the new deployment and edit the original instead.

### 7. Update the form

The form stays as the backup route, so it is worth keeping current:

1. Rename question 1 from `Vehicle` to `Equipment`, if it still says Vehicle.
2. Add `General equipment` as an option on it.
3. Add a short-answer question, `Which item, and where is it?`
   ([why](#the-general-equipment-bucket)).

The sheet needs nothing: Google appends any new question as a new column and
old rows simply have it blank.

### 8. Reprint the stickers — only if you're moving them to the app

If your QR codes still point at the Google Form, this is the version that moves
them to the app. Open `equipment-qr-labels.html`, leave **Link source** on *The
maintenance app*, paste the `/exec` URL from step 6, and print.

Leave the old stickers up until the new ones are on the machines. Both routes
write to the same sheet and share one ticket sequence, so there is no cutover
moment and nothing to co-ordinate.

### 9. Check it end to end

- **Maintenance → Send test email** — confirms the addresses.
- Open the app URL on a phone. It should land on **Home** with the wordmark.
- **Create ticket** on something harmless. Confirm the ticket number appears,
  the email arrives, and the row is in the sheet.
- Scan one printed sticker and confirm Home names the right machine.

---

## What carries over, and what changes

**Untouched:** every row, ticket ID, status, work note and close date. The
ticket sequence continues from your highest existing number.

**Added, not replaced:** a `Photo` column, an "On my phone" tab, and the
tracking columns if you don't already have them.

**Overwritten, if you customised them:** column widths you set by hand, and
conditional formatting rules on the Status and urgency columns. Rules on other
columns are left alone.

**Refused rather than clobbered:** if you happen to have a tab named
"On my phone" that this script did not generate, `setUp` stops and asks you to
rename it.

### Two behaviours worth knowing

- **Ticket numbers continue from the highest in the log**, rather than being
  derived from the row number. The old scheme handed out a duplicate ID after
  anyone deleted a row.
- **The phone app loads the 50 most recent closed requests**, not all of them,
  and says so when it trims. Open requests are always shown in full, and the
  History tab searches the whole log regardless. Change it with
  `closedHistoryShown`.

### If your log still says "Vehicle"

Renaming a question in Google Forms does **not** rename the column in the linked
sheet, so your log may keep its `Vehicle` header. That's fine — the script
accepts either:

```js
equipment: ['Equipment', 'Vehicle'],
```

It looks for `Equipment` first and falls back to `Vehicle`, so a season of
history under the old header keeps reading correctly. Leave both in the list.

### Going back

Paste the old script over the new one and run `setUp`. Everything this version
adds is additive — extra columns, extra tabs — and nothing changes how a
response is recorded, so old and new read the same sheet identically. You would
lose the app's Create ticket, so put the form stickers back first.

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

**The phone app says "N older closed requests not shown".**
Working as intended — it loads the 50 most recent closed requests so the
payload does not grow with the log forever. Raise `closedHistoryShown` in
`CONFIG` if you want more, or open the sheet for the full history.

**I changed something in `CONFIG` and the app still shows the old value.**
The app serves the **last deployed version**, not whatever is currently in the
editor. Do **Deploy → Manage deployments → pencil → Version: New version**.
`healthCheck` reads the editor's code, so it will happily say *All good* while
the app is still running last week's settings — it now says so in its report.
The one exception is the equipment list, which is read live from the Equipment
tab and needs no redeploy.

**The badge next to the Open tab.**
It counts **open requests**, and turns red when any of them are urgent. Grey
with a number means work outstanding but nothing on fire.

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
