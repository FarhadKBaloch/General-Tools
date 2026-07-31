/**
 * Checks for qr.js. No dependencies; run with `node qr.test.js`.
 *
 * These verify the encoder's internal invariants and the structure of the
 * symbols it produces. The tables were additionally validated by round-tripping
 * every version and error-correction level through an independent decoder
 * (jsQR) during development; these checks are what runs without a network.
 */
'use strict';

const QR = require('./qr.js');
const { ECC_TABLE, TOTAL_CODEWORDS, dataCapacity } = QR._internal;
const LEVELS = ['L', 'M', 'Q', 'H'];

let pass = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) pass++;
  else failures.push(name + (detail ? ' — ' + detail : ''));
}

// --- Error-correction tables -----------------------------------------------
// A wrong entry here produces a symbol that scanners reject, so the arithmetic
// is checked against the published total-codeword count for every version.
for (const ecc of LEVELS) {
  for (let v = 1; v <= QR.MAX_VERSION; v++) {
    const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = ECC_TABLE[ecc][v - 1];
    const totalBlocks = g1Blocks + g2Blocks;
    const total = g1Blocks * g1Data + g2Blocks * g2Data + totalBlocks * ecPerBlock;

    check(`v${v}/${ecc} codeword total`, total === TOTAL_CODEWORDS[v - 1],
      `got ${total}, expected ${TOTAL_CODEWORDS[v - 1]}`);
    check(`v${v}/${ecc} group 2 block size`,
      g2Blocks === 0 ? g2Data === 0 : g2Data === g1Data + 1);
    check(`v${v}/${ecc} has at least one block`, totalBlocks >= 1);
  }

  // Capacity must never decrease as the symbol grows.
  for (let v = 2; v <= QR.MAX_VERSION; v++) {
    check(`${ecc} capacity increases at v${v}`,
      dataCapacity(v, ecc) > dataCapacity(v - 1, ecc));
  }
}

// Stronger correction always means less room for data.
for (let v = 1; v <= QR.MAX_VERSION; v++) {
  check(`v${v} capacity ordering L>M>Q>H`,
    dataCapacity(v, 'L') > dataCapacity(v, 'M') &&
    dataCapacity(v, 'M') > dataCapacity(v, 'Q') &&
    dataCapacity(v, 'Q') > dataCapacity(v, 'H'));
}

// --- Symbol structure ------------------------------------------------------
function isFinderAt(m, row, col) {
  const want = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1]
  ];
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      if (m[row + r][col + c] !== (want[r][c] === 1)) return false;
    }
  }
  return true;
}

for (const ecc of LEVELS) {
  for (let v = 1; v <= QR.MAX_VERSION; v++) {
    // Fill each symbol to capacity, so placement is exercised across the whole grid.
    const maxBytes = dataCapacity(v, ecc) - 1 - (v < 10 ? 1 : 2);
    const qr = QR.encode('v' + v + '/'.repeat(Math.max(maxBytes - 3, 0)), ecc, v);
    const m = qr.modules;
    const size = qr.size;

    check(`v${v}/${ecc} size`, size === v * 4 + 17, `got ${size}`);
    check(`v${v}/${ecc} version reported`, qr.version === v);
    check(`v${v}/${ecc} matrix is square and complete`,
      m.length === size && m.every(row => row.length === size && row.every(x => typeof x === 'boolean')));

    check(`v${v}/${ecc} top-left finder`, isFinderAt(m, 0, 0));
    check(`v${v}/${ecc} top-right finder`, isFinderAt(m, 0, size - 7));
    check(`v${v}/${ecc} bottom-left finder`, isFinderAt(m, size - 7, 0));

    // Timing patterns alternate, starting dark at the 6th row/column.
    let timingOk = true;
    for (let i = 8; i < size - 8; i++) {
      if (m[6][i] !== (i % 2 === 0) || m[i][6] !== (i % 2 === 0)) timingOk = false;
    }
    check(`v${v}/${ecc} timing patterns`, timingOk);

    check(`v${v}/${ecc} dark module`, m[size - 8][8] === true);

    // Separators: the light ring around each finder must stay light.
    let sepOk = true;
    for (let i = 0; i < 8; i++) {
      if (m[7][i] || m[i][7]) sepOk = false;
      if (m[7][size - 1 - i] || m[i][size - 8]) sepOk = false;
      if (m[size - 8][i] || m[size - 1 - i][7]) sepOk = false;
    }
    check(`v${v}/${ecc} finder separators`, sepOk);

    // The two copies of the format information must agree.
    let formatOk = true;
    for (let i = 0; i < 15; i++) {
      const primary = i < 6 ? m[i][8] : i === 6 ? m[7][8] : i === 7 ? m[8][8] : i === 8 ? m[8][7] : m[8][14 - i];
      const mirror = i < 8 ? m[8][size - 1 - i] : m[size - 15 + i][8];
      if (primary !== mirror) formatOk = false;
    }
    check(`v${v}/${ecc} format info copies agree`, formatOk);

    // Version information appears twice from version 7 up.
    if (v >= 7) {
      let versionOk = true;
      for (let i = 0; i < 18; i++) {
        if (m[Math.floor(i / 3)][size - 11 + (i % 3)] !== m[size - 11 + (i % 3)][Math.floor(i / 3)]) {
          versionOk = false;
        }
      }
      check(`v${v}/${ecc} version info copies agree`, versionOk);
    }
  }
}

// --- Version selection -----------------------------------------------------
for (const ecc of LEVELS) {
  for (let v = 1; v < QR.MAX_VERSION; v++) {
    const countBytes = v < 10 ? 1 : 2;
    const maxBytes = dataCapacity(v, ecc) - 1 - countBytes;
    if (maxBytes < 1) continue;
    check(`${ecc} v${v} holds its stated capacity`,
      QR.encode('a'.repeat(maxBytes), ecc).version <= v);
    check(`${ecc} v${v} overflows to a larger symbol`,
      QR.encode('a'.repeat(maxBytes + 1), ecc).version > v);
  }
}

// --- Content handling ------------------------------------------------------
check('empty string encodes', QR.encode('', 'M').size === 21);
check('unicode is encoded as UTF-8 bytes',
  QR.encode('é', 'M').version === QR.encode('ab', 'M').version);

let threw = false;
try { QR.encode('x'.repeat(10000), 'H'); } catch (e) { threw = /too long/.test(e.message); }
check('over-capacity content throws a clear error', threw);

let badLevel = false;
try { QR.encode('hi', 'Z'); } catch (e) { badLevel = /error-correction/i.test(e.message); }
check('unknown error-correction level throws', badLevel);

// --- SVG output ------------------------------------------------------------
const svg = QR.toSVG(QR.encode('https://example.com', 'Q'), { scale: 4, margin: 2 });
check('SVG is well formed', svg.startsWith('<svg') && svg.trim().endsWith('</svg>'));

// The output claims to be SVG, so it has to be valid XML. An equipment name
// like "Truck & Trailer" used to emit a bare & and break the whole document.
for (const [title, escaped] of [
  ['Truck & Trailer', '&amp;'],
  ['Sprayer <300 gal>', '&lt;'],
  ['He said "go"', '&quot;']
]) {
  const withTitle = QR.toSVG(QR.encode('https://example.com', 'M'), { title });
  const label = /aria-label="([^"]*)"/.exec(withTitle);
  check(`SVG title escapes ${JSON.stringify(title)}`,
    label !== null && label[1].includes(escaped), label && label[1]);
  // No raw markup characters survive outside a character reference.
  check(`SVG title leaves no bare markup for ${JSON.stringify(title)}`,
    !/[<>]/.test(label[1]) && !/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(label[1]), label[1]);
}
check('SVG omits aria-label when no title is given',
  !QR.toSVG(QR.encode('x', 'M')).includes('aria-label'));
check('SVG has a path of dark modules', /<path fill="#000000" d="M/.test(svg));
check('SVG dimensions match the symbol',
  svg.includes('width="' + (QR.encode('https://example.com', 'Q').size + 4) * 4 + '"'));

// --- Result ----------------------------------------------------------------
console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n' + failures.slice(0, 30).join('\n'));
  process.exit(1);
}
