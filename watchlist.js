/**
 * Watchlist: remembers what to re-check, and when.
 *
 * Plants show damage days after the event that caused it, so a warning issued
 * today is useless unless someone looks again once symptoms would actually be
 * visible. This module writes those follow-ups to watchlist.json, which the
 * workflow commits back to the repository so it survives between runs.
 *
 * Why a committed file rather than Actions cache: caches expire after 7 days,
 * but a symptom window can run 42 days. The repo is permanent, and the file
 * doubles as a readable history of what was flagged.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'watchlist.json');
const MAX_AGE_DAYS = 120;   // prune anything older than this so the file stays small

function todayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j.entries) ? j.entries : [];
  } catch (err) {
    return [];   // first run, or the file was removed
  }
}

function save(entries, today) {
  // Drop entries whose check window closed well in the past.
  const cutoff = addDays(today, -MAX_AGE_DAYS);
  const kept = entries.filter(e => parseKey(e.checkOn) >= cutoff);
  const out = {
    note: 'Written by sprout-scout-bot. Each entry is a symptom-lag follow-up: something flagged on `flaggedOn` that should be visible around `checkOn`.',
    updated: todayKey(today),
    entries: kept.sort((a, b) => a.checkOn.localeCompare(b.checkOn)),
  };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n');
  return kept;
}

/**
 * Record a follow-up. `lagLo`/`lagHi` bound the window symptoms may appear in;
 * we schedule the reminder at the midpoint and show the range.
 */
function schedule(entries, { today, kind, label, detail, lagLo, lagHi }) {
  const mid = Math.round((lagLo + lagHi) / 2);
  const checkOn = todayKey(addDays(today, mid));
  const flaggedOn = todayKey(today);
  // Don't stack duplicates: the same kind flagged on the same day is one entry.
  if (entries.some(e => e.flaggedOn === flaggedOn && e.kind === kind && e.label === label)) return entries;
  entries.push({ flaggedOn, checkOn, kind, label, detail, lagLo, lagHi, windowEnd: todayKey(addDays(today, lagHi)) });
  return entries;
}

/**
 * Anything due today. We use a small tolerance so a missed or delayed run does
 * not silently drop a reminder: an entry stays due until its window closes.
 */
function due(entries, today) {
  const k = todayKey(today);
  return entries.filter(e => e.checkOn <= k && e.windowEnd >= k && !e.reported);
}

/** Mark reminders as reported so they are not repeated every day of the window. */
function markReported(entries, reported) {
  const ids = new Set(reported.map(r => r.flaggedOn + '|' + r.kind + '|' + r.label));
  for (const e of entries) {
    if (ids.has(e.flaggedOn + '|' + e.kind + '|' + e.label)) e.reported = true;
  }
  return entries;
}

module.exports = { FILE, load, save, schedule, due, markReported, todayKey, addDays, parseKey };
