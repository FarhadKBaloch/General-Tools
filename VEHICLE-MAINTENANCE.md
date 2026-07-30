# Vehicle maintenance log — QR codes on the machines

A maintenance request system for the tractor, gator, truck and sprayer that
costs nothing, needs no server, and takes about 45 minutes to set up.

Someone scans the sticker on the machine, a form opens with that vehicle
already filled in, they describe the problem and submit. The Facilities Lead,
the Owner, and a Leadership Team member get an email within seconds, and the
request lands as a row in a spreadsheet you can filter and sort.

---

## Is a QR code the right approach?

Yes — with one adjustment to what you described.

The instinct to build "an app where a QR code opens the vehicle's page and you
tag people" is the right *idea*, but building it that way means hosting,
accounts, and a login prompt standing between a person in a dusty cab and a
30-second report. Whatever you build, the thing that decides whether this
succeeds is **how many seconds it takes a seasonal crew member holding a
greasy phone to file a report**. Everything else is secondary.

So: keep the QR codes, drop the app. Use **one Google Form with a pre-filled
link per vehicle**, which gives you the same scan-to-report experience with
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
page showing that vehicle's service history. In practice the person scanning
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
   Google Form, vehicle pre-filled     ← one form, one pre-filled link per vehicle
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
| `vehicle-qr-labels.html` | Open in a browser. Generates printable QR labels. |
| `qr.js` | The QR encoder the label page uses. No dependencies. |
| `maintenance-notify.gs` | Paste into the sheet's Apps Script. Sends the emails. |
| `qr.test.js` | `node qr.test.js` — checks the encoder still works. |

---

## Step 1 — Build the form (15 minutes)

Go to [forms.google.com](https://forms.google.com) and create a blank form
called **Vehicle Maintenance Request**.

Add these questions. The titles matter — the script looks for them by name, and
if you reword one you must update `CONFIG.questions` in the script to match.

| # | Question title | Type | Required | Options |
|---|---|---|---|---|
| 1 | `Vehicle` | Multiple choice | Yes | Tractor, Gator, Truck, Sprayer |
| 2 | `How urgent is it?` | Multiple choice | Yes | `Safety issue - do not operate`, `Down - cannot be used`, `Needs attention soon`, `Routine / next service` |
| 3 | `What needs attention?` | Paragraph | Yes | — |
| 4 | `Your name` | Short answer | Yes | — |
| 5 | `Leadership Team contact` | Dropdown | Yes | The names of your leadership team, plus `Any / no preference` |
| 6 | `Photo` | File upload | No | Requires the submitter to be signed in — see the warning below |
| 7 | `Hours / mileage reading` | Short answer | No | — |

Question 1's options must be spelled **exactly** the way you'll type the
vehicle names into the label generator later. `Tractor` and `Tractor ` (with a
trailing space) are different answers as far as Google is concerned.

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
Name it **Vehicle Maintenance Log**. This sheet is now your permanent record.

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
pre-selected via the URL, so **one form** serves all four vehicles — you just
point each QR code at a different version of the link.

In the **form**, click the **⋮** menu (top right) → **Get pre-filled link**.
Select any one vehicle — it doesn't matter which — then click **Get link** and
**Copy link**.

You'll get something like:

```
https://docs.google.com/forms/d/e/1FAIpQLSd.../viewform?usp=pp_url&entry.1234567890=Tractor
```

That `entry.1234567890` is the internal ID of your Vehicle question. Keep the
link on your clipboard.

> Don't use the short `forms.gle` link for this — shortened links drop the
> pre-fill, and every QR code would open a blank form.

---

## Step 4 — Generate and print the labels (10 minutes)

Open `vehicle-qr-labels.html` in any browser (double-click it; it needs
`qr.js` sitting next to it). Nothing is uploaded — the QR codes are generated
in the page itself.

1. Paste the pre-filled link into **Pre-filled form link**. The page will
   confirm which field it found.
2. Type your vehicle names, one per line, spelled exactly as in the form.
3. Leave **error correction** on **Q (25%)** — that's the level that keeps
   working when a label picks up scratches and dust.
4. Click **Generate labels**, then **Print** (or print to PDF).

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
- **Test each one with a phone before it goes on the machine.** Scan it, check
  the form opens with the right vehicle already selected. Two minutes now
  beats discovering in May that the sprayer's label points at the truck.
- **Print a couple of spares of each** and keep them in the shop.

---

## Step 5 — How it runs day to day

**Someone finds a problem:** scan, describe, submit. Under a minute.

**The three notified people get an email** with the vehicle, urgency, the
description, who reported it, and a button that opens that row of the log.
Safety and down-machine reports arrive with `[URGENT]` in the subject line and
a red banner.

**Whoever does the work** sets **Status** to `In progress`, then `Done`, and
writes what they did in **Work done / notes**. Marking it `Done` stamps the
date and emails the same three people that it's closed.

**Once a month**, sort the log by Vehicle. Four repairs on the same hydraulic
line is a pattern that's invisible when the reports live in text messages,
and that pattern is the actual return on doing this — it's what turns
"the gator's acting up again" into a replace-or-repair decision you can defend
with dates.

A few things worth setting up once you've used it for a season:

- Add a **Filter view** per vehicle so anyone can see one machine's history.
- Add a `Cost` column and you have annual spend per machine.
- Google Sheets has scheduled emails via Apps Script if you want a Monday
  morning "still open" digest — a natural next addition to the same script.

---

## What this costs and where the limits are

Nothing, and the ceilings are far above what you'll use:

| Limit | Free Gmail account | Google Workspace |
|---|---|---|
| Emails per day from the script | 100 recipients | 1,500 recipients |
| Form responses | Unlimited | Unlimited |
| Rows in the sheet | 10 million cells | 10 million cells |

With four vehicles and three recipients per request, the free-Gmail ceiling is
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

1. **A landing page per vehicle instead of a straight-to-form link.** Host a
   small static page free on GitHub Pages with two buttons — *Report a problem*
   and *See this vehicle's history* — and point the QR codes there instead. The
   label generator supports this: switch **Link source** to "A separate link
   for each vehicle". This is the direct answer to "I want the scan to take
   them to the vehicle", and it's maybe two hours of work.
2. **Scheduled service reminders**, by adding an hours/mileage threshold per
   vehicle and a daily Apps Script check.
3. **A real CMMS** (Fiix, UpKeep, Limble all have free tiers) once you're
   tracking parts inventory, labour cost per repair, and warranty claims. Move
   when the spreadsheet genuinely hurts, not before — and by then you'll have
   a season of real data to import and a crew already in the habit of
   scanning, which is the hard part of any rollout.

---

## Troubleshooting

**The QR code opens a blank form with no vehicle selected.**
The link was shortened, or copied from the address bar rather than from *Get
pre-filled link*. It must contain `usp=pp_url&entry.` — regenerate it.

**The vehicle name shows in the URL but the form doesn't select it.**
The spelling doesn't match the form's answer option exactly. Check for trailing
spaces, and for `#` or `&` in a vehicle name (those are fine — the generator
escapes them — but retyping them by hand in the form is where mismatches creep in).

**No emails arrive.**
Run **Maintenance → Send test email** from the sheet. If the test works but
real submissions don't, the trigger didn't install: re-run `setUp`. Check spam
on the recipients' side once — the first message from a new script often lands
there, and marking it "not spam" fixes it permanently.

**The Leadership Team member never gets the email.**
The key in `CONFIG.leadership` must match the dropdown option character for
character. Copy the option text out of the form and paste it into the script
rather than retyping it.

**`setUp` fails with "Could not find the form responses tab".**
The form isn't linked to the spreadsheet yet. In the form: Responses → Link to
Sheets.
