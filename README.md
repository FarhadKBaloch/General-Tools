# Sprout Scout — Slack daily brief

Posts one message each morning telling growers what to watch for that day:
irrigation call, disease and leaf-wetness risk, pest pressure, frost, and light.

It uses the **same thresholds as the Sprout Scout dashboard**. The shared rules
are extracted from `sprout-scout.html` into `shared-logic.js`, so the bot and the
dashboard can never disagree about what counts as a frost or a mite day.

---

## Why this is a separate program

The dashboard is a single HTML file that runs entirely in your browser. Nothing
runs when the tab is closed, so it cannot post at 6am on its own. This is a small
companion script that runs on a schedule and posts into Slack.

It needs **Node 18 or newer** and has **no npm dependencies**.

---

## 1. Create the Slack app (5 minutes)

The old "Incoming WebHooks" app in the App Directory is deprecated; create a
proper Slack app instead.

1. Go to <https://api.slack.com/apps> and click **Create New App** → **From scratch**.
2. Name it `Sprout Scout`, pick your workspace, click **Create App**.
3. In the left sidebar choose **Incoming Webhooks**, and switch
   **Activate Incoming Webhooks** to **On**.
4. Click **Add New Webhook to Workspace**.
5. Choose the channel to post in (e.g. `#growing-team`) and click **Allow**.
6. Copy the webhook URL

**Treat that URL like a password.** Anyone who has it can post to that channel.
Do not commit it to a repository — Slack scans public repos and will revoke it.

> A webhook is locked to one channel. That is the right trade here: it is the
> simplest option, with no OAuth flow and no tokens to refresh. If you later want
> the bot to post to several channels or answer slash commands, you would move to
> a bot token and `chat.postMessage`.

---

## 2. Test it before scheduling

```bash
cd slackbot
export SLACK_WEBHOOK_URL='https://hooks.slack.com/services/...'

# Print the message without posting:
node sprout-scout-bot.js --dry-run

# Post it for real:
node sprout-scout-bot.js
```

If the dry run looks right and the real run prints `Posted Sprout Scout brief`,
you are done with setup.

---

## 3. Schedule the daily post

### Option A — cron (Linux/macOS, or any always-on machine)

`crontab -e`, then add:

```cron
# 6:00am every day. Use absolute paths: cron has a minimal environment.
0 6 * * * SLACK_WEBHOOK_URL='https://hooks.slack.com/services/...' /usr/bin/node /full/path/to/slackbot/sprout-scout-bot.js >> /var/log/sprout-scout.log 2>&1
```

### Option B — GitHub Actions (no server to maintain)

Put the repo on GitHub, add the webhook under
**Settings → Secrets and variables → Actions** as `SLACK_WEBHOOK_URL`, and add
`.github/workflows/daily.yml`:

```yaml
name: Sprout Scout daily brief

on:
  schedule:
    - cron: '0 10 * * *'   # 10:00 UTC = 6am Eastern (5am during winter)
  workflow_dispatch:        # lets you trigger it by hand to test

permissions:
  contents: write           # required so the bot can commit watchlist.json

jobs:
  brief:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '24'

      - name: Post the daily brief
        run: node sprout-scout-bot.js
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}

      - name: Save the follow-up watchlist
        run: |
          git config user.name  "sprout-scout-bot"
          git config user.email "bot@users.noreply.github.com"
          git add -A watchlist.json
          git diff --staged --quiet || git commit -m "Update watchlist [skip ci]"
          git push
```

The paths above assume the `.js` files sit at the **root** of your repository.
If you keep them in a `slackbot/` folder instead, prefix both the `node` command
and the `git add` path with `slackbot/`.

You must also enable write access once: **Settings → Actions → General →
Workflow permissions → Read and write permissions**. Without it the save step
fails with a permission error.

Note that GitHub's scheduler runs in UTC and does not adjust for daylight saving,
so the local time shifts by an hour twice a year. Adjust the cron line if that
matters, or run it from a machine that knows your timezone.

### Option C — Windows Task Scheduler

Create a Basic Task → Daily → 6:00am → Start a program:
- Program: `C:\Program Files\nodejs\node.exe`
- Arguments: `C:\path\to\slackbot\sprout-scout-bot.js`
- Set `SLACK_WEBHOOK_URL` as a system environment variable first.

---

## 4. Configuration

All optional except the webhook:

| Variable | Default | Meaning |
|---|---|---|
| `SLACK_WEBHOOK_URL` | *(required)* | Where to post |
| `SITE_LAT` | `40.2341` | Latitude (Ostrander, OH) |
| `SITE_LON` | `-83.1745` | Longitude |
| `SITE_NAME` | `Ostrander, OH` | Shown in the message header |
| `SITE_TZ` | `America/New_York` | Timezone for the forecast |
| `SLACK_MENTION` | `alerts` | Who gets notified (see below) |

### Notifying growers

`SLACK_MENTION` controls the ping at the top of each brief:

| Value | Behaviour |
|---|---|
| `channel` | `@channel` every day. Notifies everyone in the channel, **including people who are offline**. |
| `here` | `@here` every day. Notifies only members currently active. Gentler for a daily post. |
| `alerts` | **Default.** `@channel` only on days with a freeze, frost, cold night, or heat stress. Silent otherwise. |
| `none` | No ping. The message simply appears in the channel. |
| a literal mention | Passed straight through, e.g. `<!subteam^S012ABC>` for a user group like @growers. |

`alerts` is the default because a daily `@channel` is the most common reason
teams start muting a bot. The brief still posts every morning either way; the
setting only controls whether it interrupts anyone. Disease and pest conditions deliberately do **not** trigger the alert
ping, because favourable conditions occur most summer days.

To notify a specific group instead of the whole channel, create a user group in
Slack (paid feature), then use its ID: `SLACK_MENTION='<!subteam^S012ABC|@growers>'`.

---

## 5. Keeping it in sync with the dashboard

If you change a threshold in `sprout-scout.html` (a pest rule, a frost cutoff,
a DLI target), regenerate the shared module:

```bash
node build-shared.js ../sprout-scout.html
```

That re-extracts the rules and overwrites `shared-logic.js`. It fails loudly if
the dashboard structure changed enough that a block cannot be found, rather than
silently producing a stale copy.

---

## Symptom-lag follow-ups

Plants show damage days after the event that caused it, so a warning on its own
is not enough: somebody has to look again once symptoms would be visible.

When the bot flags a disease risk, freeze, or heat-stress day, it records a
follow-up in `watchlist.json` and reminds the channel when that damage would
actually be showing:

> 🔎 **Follow-up: check for disease symptoms now.** On **Thursday, July 23**
> (9 days ago) conditions favored *Botrytis, Downy mildew, Basil downy mildew*
> (foliage stayed wet ~12h at 70°F). Symptoms from that window would be showing
> about now.

The windows come from the same lag model the dashboard uses: about 5-12 days for
disease, 2-14 days for cold or heat injury. Reminders fire once, at the midpoint
of the window, and stay pending until the window closes so a missed or delayed
run does not lose them.

`watchlist.json` is committed back to the repository after each run, which is why
the workflow needs `permissions: contents: write`. It is readable, so you can open
it any time to see what is pending.

## Notes on behaviour

- **Failures are reported, not silent.** Scheduled jobs normally fail with nobody
  noticing. If the weather API is down or malformed, the bot posts a `⚠️` message
  to the same channel instead of simply not appearing.
- **One message per day.** Long automated messages get ignored, so the brief only
  includes lines that are actually relevant; a calm day produces a short message.
- **The caveats travel with the message.** Every brief ends with the reminder that
  these are outdoor conditions, leaf wetness is an estimate, and a disease or pest
  listing means conditions *favor* it, not that it is present.

## What this bot does not do

It does not read your dump log. The Loss Analyzer needs an uploaded file, and this
runs unattended with no access to it. The brief is forecast-driven only. Adding
crop-specific callouts ("your 3-inch basil is exposed today") would mean putting
the log somewhere the scheduled job can read it — a reasonable next step, but a
different piece of work.
