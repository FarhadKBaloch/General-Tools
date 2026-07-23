#!/usr/bin/env node
/**
 * Sprout Scout: daily Slack brief
 *
 * Posts one message per morning telling growers what to watch for today:
 * irrigation call, disease/leaf-wetness risk, pest pressure, frost, and light.
 *
 * Uses the SAME thresholds as the Sprout Scout dashboard by importing
 * shared-logic.js, which is extracted from the HTML file. Change a rule there
 * and rerun build-shared.js; you never maintain two copies.
 *
 * Requires Node 18+ (built-in fetch). No npm dependencies.
 */

const L = require('./shared-logic.js');
const W = require('./watchlist.js');

// ---------- config ----------
const CFG = {
  webhook: process.env.SLACK_WEBHOOK_URL,
  lat: parseFloat(process.env.SITE_LAT || '40.2341'),
  lon: parseFloat(process.env.SITE_LON || '-83.1745'),
  site: process.env.SITE_NAME || 'Ostrander, OH',
  tz: process.env.SITE_TZ || 'America/New_York',
  dryRun: process.argv.includes('--dry-run'),
  // Who to notify. Options:
  //   'alerts'   -> DEFAULT. @channel only on freeze/frost/cold-night/heat-stress
  //                 days. The brief still posts daily; it just does not interrupt
  //                 anyone unless there is a same-day decision to make.
  //   'channel'  -> @channel every day, including offline members
  //   'here'     -> @here every day, only members currently active
  //   'none'     -> no mention, the message just appears
  //   '<@U123>'  -> any literal Slack mention, e.g. a user group like <!subteam^S123>
  mention: process.env.SLACK_MENTION || 'alerts',
};

const f0 = n => (n == null ? '-' : Math.round(n));
const f1 = n => (n == null ? '-' : (Math.round(n * 10) / 10).toFixed(1));
const hr12 = h => (h == null ? '-' : h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);

// ---------- fetch ----------
async function getForecast() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${CFG.lat}&longitude=${CFG.lon}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,`
    + `et0_fao_evapotranspiration,wind_speed_10m_max,relative_humidity_2m_mean,shortwave_radiation_sum`
    + `&hourly=relative_humidity_2m,temperature_2m,precipitation`
    + `&forecast_days=2&temperature_unit=fahrenheit&precipitation_unit=inch`
    + `&wind_speed_unit=mph&timezone=${encodeURIComponent(CFG.tz)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather API returned ${res.status}`);
  const j = await res.json();
  if (!j.daily || !j.daily.time || !j.daily.time.length) throw new Error('Weather API returned no daily data');
  return j;
}

// Build today's record, including leaf wetness from the hourly series.
function buildToday(j) {
  const d = j.daily;
  const key = d.time[0];
  const num = (arr, i) => {
    const v = arr && arr[i];
    return v === null || v === undefined || Number.isNaN(v) ? null : v;
  };

  const hrs = [];
  if (j.hourly && j.hourly.time) {
    for (let i = 0; i < j.hourly.time.length; i++) {
      if (!j.hourly.time[i].startsWith(key)) continue;
      hrs.push({
        hour: +j.hourly.time[i].slice(11, 13),
        rh: num(j.hourly.relative_humidity_2m, i),
        temp: num(j.hourly.temperature_2m, i),
        rain: num(j.hourly.precipitation, i),
      });
    }
  }
  const wet = hrs.map(x => (x.rh != null && x.rh >= L.RH_WET) || (x.rain != null && x.rain > 0));
  let run = 0, lwdRun = 0, curStart = null, wetStart = null;
  const wetTemps = [];
  hrs.forEach((x, i) => {
    if (wet[i]) {
      if (run === 0) curStart = x.hour;
      run++;
      if (run > lwdRun) { lwdRun = run; wetStart = curStart; }
      if (x.temp != null) wetTemps.push(x.temp);
    } else run = 0;
  });
  const dry = L.dryingInfo(hrs, wet);
  const wetTemp = wetTemps.length ? wetTemps.reduce((a, b) => a + b, 0) / wetTemps.length : null;

  const et0 = d.et0_fao_evapotranspiration_sum || d.et0_fao_evapotranspiration || [];
  const [y, m, dd] = key.split('-').map(Number);

  return {
    key, date: new Date(y, m - 1, dd),
    tmax: num(d.temperature_2m_max, 0), tmin: num(d.temperature_2m_min, 0),
    rain: num(d.precipitation_sum, 0), pop: num(d.precipitation_probability_max, 0),
    et0: num(et0, 0), wind: num(d.wind_speed_10m_max, 0),
    rh: num(d.relative_humidity_2m_mean, 0), rad: num(d.shortwave_radiation_sum, 0),
    lwdRun, wetStart, wetTemp,
    dryHour: dry.dryHour, staysWet: dry.staysWet, reWets: dry.reWets, rainHours: dry.rainHours,
  };
}

// ---------- guidance (mirrors the dashboard's dayGuidance) ----------
function buildBrief(t, watch) {
  const lines = [];
  const chips = [];

  // irrigation
  const wetSoon = (t.pop != null && t.pop >= 60) || (t.rain != null && t.rain >= 0.15);
  if (wetSoon) {
    lines.push({ icon: '🚱', text: `*Hold off watering.* Rain likely${t.pop != null ? ` (${t.pop}% chance` : ''}${t.rain != null ? `, ${f1(t.rain)}" expected)` : ')'}. Let the weather do the work.` });
    chips.push('Skip watering');
  } else if (t.et0 != null && t.et0 >= 0.22) {
    lines.push({ icon: '💧', text: `*Water early and thoroughly.* High demand (ET₀ ${f1(t.et0)}")${t.wind != null && t.wind >= 15 ? `, and winds to ${f0(t.wind)} mph will pull moisture faster` : ''}.` });
    chips.push('Water early');
  } else {
    lines.push({ icon: '💧', text: `*Normal irrigation.* Demand is moderate (ET₀ ${t.et0 != null ? f1(t.et0) + '"' : 'n/a'}). Water early so foliage dries before evening.` });
  }

  // leaf wetness + disease
  const risks = (t.lwdRun != null && t.wetTemp != null)
    ? L.diseaseRisk({ lwdRun: t.lwdRun, wetTemp: t.wetTemp }) : [];
  const dryPhrase = t.staysWet
    ? ', and with moisture on and off it is unlikely to dry today'
    : t.dryHour != null
      ? (t.reWets ? `, drying briefly around ${hr12(t.dryHour)} before wetting up again` : `, drying near ${hr12(t.dryHour)}`)
      : ', with no reliable drying window';
  if (risks.length) {
    // Remember to re-check when symptoms would actually be visible.
    const dl = L.lagFor('diseased');
    W.schedule(watch, { today: t.date, kind: 'disease',
      label: risks.map(r => r.name).join(', '),
      detail: `foliage stayed wet ~${t.lwdRun}h at ${f0(t.wetTemp)}°F`,
      lagLo: dl.lo, lagHi: dl.hi });
    // Lag must be measured from the FORECAST day, not from whenever this
    // script happens to run, or the date drifts.
    const lagDays = 8;
    const when = new Date(t.date.getFullYear(), t.date.getMonth(), t.date.getDate() + lagDays)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    lines.push({
      icon: '🍄',
      text: `*Disease watch.* Foliage should stay wet ~${t.lwdRun}h at ${f0(t.wetTemp)}°F${dryPhrase}. Favors *${risks.map(r => r.name).join('*, *')}*. `
        + `Scout leaf undersides and keep air moving. Symptoms from an infection today would not show until about ${when}, so this is preventive.`,
    });
    risks.forEach(r => chips.push(r.name.replace(' (gray mold)', '')));
  } else if (t.lwdRun >= 4) {
    lines.push({ icon: '🍃', text: `Foliage wet ~${t.lwdRun}h${dryPhrase}, below infection thresholds, but keep vents and fans running.` });
  }
  if (t.rainHours >= 3) {
    lines.push({ icon: '🌧️', text: `Rain falls about ${t.rainHours}h today, so venting will help more than anything else.` });
  }

  // frost / cold
  const calmClear = (t.wind == null || t.wind <= 8) && (t.rain == null || t.rain < 0.01);
  const openHouse = L.isCovered(t.date) === false;
  const shelter = openHouse
    ? 'The houses are uncovered, so there is no protection: move tender material under cover or plan to re-cover.'
    : 'Check heaters and cover tender material.';
  if (t.tmin != null) {
    if (t.tmin <= 32) {
      const chk = new Date(t.date.getFullYear(), t.date.getMonth(), t.date.getDate() + 3)
        .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      const cl = L.lagFor('dead');
      W.schedule(watch, { today: t.date, kind: 'freeze', label: `Freeze, low ${f0(t.tmin)}°F`,
        detail: openHouse ? 'houses were uncovered' : 'houses covered', lagLo: cl.lo, lagHi: cl.hi });
      lines.push({ icon: '❄️', text: `*Freeze risk.* Low near ${f0(t.tmin)}°F. ${shelter} Cold injury often is not visible for 2 to 14 days, so re-inspect *${chk}* rather than judging tomorrow morning.` });
      chips.push('Freeze');
    } else if (t.tmin <= 36 && calmClear) {
      lines.push({ icon: '❄️', text: `*Frost risk* despite a low of ${f0(t.tmin)}°F. On a clear, calm night foliage radiates heat and can reach freezing even when the air does not. ${shelter}` });
      chips.push('Frost risk');
    } else if (t.tmin <= 38) {
      lines.push({ icon: '🧊', text: `*Cold night.* Low near ${f0(t.tmin)}°F. Hold hardening-off of tender material and verify heat is running.` });
      chips.push('Cold night');
    }
  }

  // heat
  if (t.tmax != null && t.tmax >= 88) {
    const hl = L.lagFor('dead');
    W.schedule(watch, { today: t.date, kind: 'heat', label: `Heat stress, high ${f0(t.tmax)}°F`,
      detail: 'watch newly potted and tender material', lagLo: hl.lo, lagHi: hl.hi });
    lines.push({ icon: '🔥', text: `*Heat stress.* High near ${f0(t.tmax)}°F. Water early, avoid midday transplanting, watch newly potted material for wilt.` });
    chips.push('Heat stress');
  }

  // pests
  const pests = L.pestRisk(t);
  if (pests.length) {
    lines.push({ icon: '🐛', text: `*Pest watch.* Conditions favor *${pests.map(p => p.name).join('*, *')}*. ${pests[0].act}` });
    pests.slice(0, 2).forEach(p => chips.push(p.name.replace('Two-spotted ', '').replace('Spider mites (two-spotted)', 'Spider mites')));
  }

  // light
  if (t.rad != null) {
    const out = L.dliFrom(t.rad);
    const [tLo, tHi] = L.lightTransmitRange(t.date);
    const mid = out * (tLo + tHi) / 2;
    const v = L.dliVerdict(mid);
    if (v && v.lvl === 'low') {
      lines.push({ icon: '🌥️', text: `*Low light.* ~${f1(out)} mol/m²/d${tLo === 1 ? ' at the crop' : ` outdoors (~${f1(out * tLo)} to ${f1(out * tHi)} inside)`}. ${v.note} Hold growth regulators and ease back on feed.` });
      chips.push('Low light');
    } else if (v && v.lvl === 'high') {
      const hiNote = v.note.replace(/^High light\.\s*/, '');
      lines.push({ icon: '☀️', text: `*High light.* ~${f1(out)} mol/m²/d outdoors. ${hiNote} Check shade and watch tender material.` });
      chips.push('High light');
    }
  }

  // --- follow-ups from earlier warnings, now due ---
  const dueNow = W.due(watch, t.date);
  for (const e of dueNow) {
    const flagged = W.parseKey(e.flaggedOn)
      .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const ago = Math.round((t.date - W.parseKey(e.flaggedOn)) / 86400000);
    if (e.kind === 'disease') {
      lines.push({ icon: '🔎', text: `*Follow-up: check for disease symptoms now.* On *${flagged}* (${ago} days ago) conditions favored *${e.label}* (${e.detail}). Symptoms from that window would be showing about now. Inspect those crops before assuming they are clean.` });
    } else if (e.kind === 'freeze') {
      lines.push({ icon: '🔎', text: `*Follow-up: check for cold injury now.* A freeze was flagged on *${flagged}* (${ago} days ago, ${e.detail}). Cold damage blackens and collapses days later, so this is when it becomes visible.` });
    } else if (e.kind === 'heat') {
      lines.push({ icon: '🔎', text: `*Follow-up: check for heat damage now.* Heat stress was flagged on *${flagged}* (${ago} days ago). ${e.detail}.` });
    }
    chips.push('Follow-up');
  }
  W.markReported(watch, dueNow);

  if (!lines.some(l => l.icon !== '💧')) {
    lines.push({ icon: '✅', text: 'Nothing unusual flagged today. Routine scouting and normal irrigation.' });
  }
  return { lines, chips };
}

// ---------- Slack payload ----------
// Decide what mention prefix to use for this message.
function mentionPrefix(brief) {
  const m = String(CFG.mention).toLowerCase();
  if (m === 'none') return '';
  // Only ping for events that need a decision TODAY. Disease and pest chips are
  // deliberately excluded: favourable conditions occur most summer days, so
  // including them would ping almost daily and defeat the purpose.
  const urgent = brief.chips.some(c => /freeze|frost|cold night|heat stress/i.test(c));
  if (m === 'alerts') return urgent ? '<!channel> ' : '';
  if (m === 'here') return '<!here> ';
  if (m === 'channel') return '<!channel> ';
  return `${CFG.mention} `;   // literal mention string passed through
}

function buildPayload(t, brief) {
  const dateStr = t.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const gdd = L.gddFor(t.tmax, t.tmin);
  const summary = [
    `High ${f0(t.tmax)}°F / Low ${f0(t.tmin)}°F`,
    t.pop != null ? `${t.pop}% rain` : null,
    `RH ${f0(t.rh)}%`,
    t.wind != null ? `wind to ${f0(t.wind)} mph` : null,
    gdd != null ? `${f1(gdd)} GDD` : null,
  ].filter(Boolean).join('  ·  ');

  const mention = mentionPrefix(brief);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `🌱 ${dateStr}`, emoji: true } },
  ];
  // A header block cannot render a mention, so the ping goes in a section
  // directly beneath it where Slack will actually link and notify.
  if (mention) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${mention}here is today's brief:` } });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*${CFG.site}*  ·  ${summary}` }] });
  if (brief.chips.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: brief.chips.map(c => `\`${c}\``).join('  ') }] });
  }
  blocks.push({ type: 'divider' });
  for (const l of brief.lines) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${l.icon}  ${l.text}` } });
  }
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '_Outdoor conditions. Greenhouse crops are buffered by your controls. '
        + 'Leaf wetness is an estimate (within 1 to 2 hours) and a disease or pest listing means conditions *favor* it, not that it is present. Scout to confirm._',
    }],
  });

  // text is the notification fallback shown in the sidebar and on mobile
  return { text: `${mention}${dateStr}: ${brief.chips.join(', ') || 'nothing unusual flagged'}`, blocks };
}

async function post(payload) {
  const res = await fetch(CFG.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok || body !== 'ok') throw new Error(`Slack rejected the message (${res.status}): ${body}`);
}

(async () => {
  try {
    const j = await getForecast();
    const today = buildToday(j);
    const watch = W.load();
    const brief = buildBrief(today, watch);   // schedules new entries and marks due ones
    const payload = buildPayload(today, brief);
    // NOTE: the watchlist is saved only AFTER a successful post (below). Saving
    // here would mark reminders as reported even when the post fails, silently
    // losing them. A dry run never saves at all.

    if (CFG.dryRun || !CFG.webhook) {
      if (!CFG.webhook && !CFG.dryRun) {
        console.error('SLACK_WEBHOOK_URL is not set. Showing the message instead of posting.\n');
      }
      console.log(payload.blocks
        .map(b => b.text ? b.text.text : (b.elements ? b.elements.map(e => e.text).join(' ') : '---'))
        .join('\n'));
      process.exit(CFG.webhook || CFG.dryRun ? 0 : 1);
    }
    await post(payload);
    W.save(watch, today.date);   // safe to persist: the message actually went out
    console.log(`Posted Sprout Scout brief for ${today.key}`);
  } catch (err) {
    console.error(`Sprout Scout failed: ${err.message}`);
    // Scheduled jobs fail silently by default, so try to report the failure
    // into Slack rather than leaving growers with no message and no warning.
    if (CFG.webhook && !CFG.dryRun) {
      try {
        await post({ text: `:warning: Sprout Scout could not build today's brief: ${err.message}` });
      } catch (_) { /* nothing more we can do */ }
    }
    process.exit(1);
  }
})();
