#!/usr/bin/env node
/**
 * Regenerates shared-logic.js from sprout-scout.html.
 *
 * Run this whenever you change a threshold in the dashboard, so the Slack bot
 * stays in sync. Having one source of truth is the whole point: if the bot had
 * its own copy of the pest rules, the two would silently drift apart.
 *
 *   node build-shared.js ../sprout-scout.html
 */
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || path.join(__dirname, '..', 'sprout-scout.html');
if (!fs.existsSync(src)) {
  console.error(`Cannot find ${src}`);
  console.error('Usage: node build-shared.js [path/to/sprout-scout.html]');
  process.exit(1);
}

const html = fs.readFileSync(src, 'utf8');
const scripts = html.match(/<script>([\s\S]*?)<\/script>/g);
if (!scripts) { console.error('No <script> block found.'); process.exit(1); }
const js = scripts[scripts.length - 1];

const WANTED = [
  [/const RH_WET=90;[^\n]*/,                          'RH_WET'],
  [/const DRY_HOLD = 3;[\s\S]*?\nfunction dryingInfo\(hrs, wet\)\{[\s\S]*?\n\}/, 'dryingInfo'],
  [/const DISEASES=\[[\s\S]*?\n\];/,                  'DISEASES'],
  [/function diseaseRisk\(d\)\{[\s\S]*?\n\}/,         'diseaseRisk'],
  [/const GDD_BASE=50;/,                              'GDD_BASE'],
  [/function gddFor\(tmax,tmin\)\{[\s\S]*?\n\}/,      'gddFor'],
  [/const PESTS=\[[\s\S]*?\n\];/,                     'PESTS'],
  [/function pestRisk\(f\)\{[\s\S]*?\n\}/,            'pestRisk'],
  [/const DLI_PER_MJ = 1\.96;/,                       'DLI_PER_MJ'],
  [/const GH_TRANSMIT_LO = [^\n]*/,                   'GH_TRANSMIT'],
  [/function dliFrom\(radMJ\)\{[\s\S]*?\n\}/,         'dliFrom'],
  [/function dliVerdict\(insideMid\)\{[\s\S]*?\n\}/,  'dliVerdict'],
  [/const LAG_MODEL = \{[\s\S]*?\n\};/,               'LAG_MODEL'],
  [/function lagFor\(reason\)\{[\s\S]*?\n\}/,         'lagFor'],
];

const parts = [];
let missing = 0;
for (const [re, label] of WANTED) {
  const m = js.match(re);
  if (!m) { console.error(`  MISSING: ${label}`); missing++; continue; }
  parts.push(m[0]);
  console.log(`  ok: ${label}`);
}
if (missing) {
  console.error(`\n${missing} block(s) missing. The dashboard structure likely changed.`);
  process.exit(1);
}

const out = `// AUTO-EXTRACTED from sprout-scout.html. Do not edit by hand.
// Regenerate with: node build-shared.js
// Keeping these in one place means the Slack bot and the dashboard
// can never disagree about a threshold.

${parts.join('\n\n')}

module.exports = { RH_WET, DRY_HOLD, dryingInfo, DISEASES, diseaseRisk,
  GDD_BASE, gddFor, PESTS, pestRisk, DLI_PER_MJ, GH_TRANSMIT_LO, GH_TRANSMIT_HI,
  dliFrom, dliVerdict, LAG_MODEL, lagFor };
`;

fs.writeFileSync(path.join(__dirname, 'shared-logic.js'), out);
console.log(`\nWrote shared-logic.js (${out.length} bytes)`);
