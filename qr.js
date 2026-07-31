/**
 * qr.js — a dependency-free QR code encoder (byte mode, versions 1-20).
 *
 * Produces a boolean matrix; rendering is left to the caller so the same
 * module can draw to SVG in a browser or to text in a terminal.
 *
 *   QR.encode('https://example.com', 'Q')  ->  { size, modules, version, ecc }
 *
 * Loads as a plain <script> in the browser (attaches window.QR) and as a
 * CommonJS module in Node, so the label tool and the tests share one encoder.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Total codewords (data + error correction) for versions 1-20.
  var TOTAL_CODEWORDS = [
    26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
    404, 466, 532, 581, 655, 733, 815, 901, 991, 1085
  ];

  // Error-correction block layout, indexed [version-1][ecc], where each entry is
  // [ecCodewordsPerBlock, blocksInGroup1, dataCodewordsPerGroup1Block,
  //  blocksInGroup2, dataCodewordsPerGroup2Block].
  // Group 2 blocks always hold exactly one more data codeword than group 1.
  var ECC_TABLE = {
    L: [
      [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
      [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
      [30, 2, 116, 0, 0], [18, 2, 68, 2, 69], [20, 4, 81, 0, 0], [24, 2, 92, 2, 93],
      [26, 4, 107, 0, 0], [30, 3, 115, 1, 116], [22, 5, 87, 1, 88], [24, 5, 98, 1, 99],
      [28, 1, 107, 5, 108], [30, 5, 120, 1, 121], [28, 3, 113, 4, 114], [28, 3, 107, 5, 108]
    ],
    M: [
      [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
      [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
      [22, 3, 36, 2, 37], [26, 4, 43, 1, 44], [30, 1, 50, 4, 51], [22, 6, 36, 2, 37],
      [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42], [28, 7, 45, 3, 46],
      [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42]
    ],
    Q: [
      [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
      [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
      [20, 4, 16, 4, 17], [24, 6, 19, 2, 20], [28, 4, 22, 4, 23], [26, 4, 20, 6, 21],
      [24, 8, 20, 4, 21], [20, 11, 16, 5, 17], [30, 5, 24, 7, 25], [24, 15, 19, 2, 20],
      [28, 1, 22, 15, 23], [28, 17, 22, 1, 23], [26, 17, 21, 4, 22], [30, 15, 24, 5, 25]
    ],
    H: [
      [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
      [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
      [24, 4, 12, 4, 13], [28, 6, 15, 2, 16], [24, 3, 12, 8, 13], [28, 7, 14, 4, 15],
      [22, 12, 11, 4, 12], [24, 11, 12, 5, 13], [24, 11, 12, 7, 13], [30, 3, 15, 13, 16],
      [28, 2, 14, 17, 15], [28, 2, 14, 19, 15], [26, 9, 13, 16, 14], [28, 15, 15, 10, 16]
    ]
  };

  // Row/column centres of the alignment patterns, per version.
  var ALIGNMENT = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
    [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
    [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
    [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]
  ];

  var ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  var MAX_VERSION = 20;

  // ---------------------------------------------------------------- GF(256)

  // Galois field tables for Reed-Solomon, primitive polynomial 0x11D.
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function buildTables() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // Cached by degree: a symbol has up to 15 blocks that all share one
  // generator polynomial, and a sheet of labels re-encodes at the same level.
  var GENERATORS = {};

  /** Generator polynomial for `degree` error-correction codewords. */
  function generatorPoly(degree) {
    if (GENERATORS[degree]) return GENERATORS[degree];
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var i = 0; i < poly.length; i++) {
        next[i] ^= poly[i];
        next[i + 1] ^= gfMul(poly[i], EXP[d]);
      }
      poly = next;
    }
    GENERATORS[degree] = poly;
    return poly;
  }

  /** Remainder of `data` divided by the generator polynomial — the EC codewords. */
  function reedSolomon(data, ecLength) {
    var gen = generatorPoly(ecLength);
    var rem = new Array(ecLength).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      rem.shift();
      rem.push(0);
      for (var j = 0; j < ecLength; j++) rem[j] ^= gfMul(gen[j + 1], factor);
    }
    return rem;
  }

  // ------------------------------------------------------------- bit stream

  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    return Array.from(Buffer.from(text, 'utf8'));
  }

  // -------------------------------------------------------------- placement

  function makeMatrix(size) {
    var m = new Array(size);
    for (var r = 0; r < size; r++) m[r] = new Array(size).fill(null);
    return m;
  }

  function placeFinder(m, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue;
        var inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                     (c >= 0 && c <= 6 && (r === 0 || r === 6));
        var inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = inRing || inCore;
      }
    }
  }

  function placeAlignment(m, version) {
    var centres = ALIGNMENT[version - 1];
    var size = m.length;
    for (var i = 0; i < centres.length; i++) {
      for (var j = 0; j < centres.length; j++) {
        var row = centres[i], col = centres[j];
        // Skip the three corners already occupied by finder patterns.
        if ((row <= 8 && col <= 8) ||
            (row <= 8 && col >= size - 9) ||
            (row >= size - 9 && col <= 8)) continue;
        for (var r = -2; r <= 2; r++) {
          for (var c = -2; c <= 2; c++) {
            var ring = Math.max(Math.abs(r), Math.abs(c));
            m[row + r][col + c] = ring !== 1;
          }
        }
      }
    }
  }

  function placeFunctionPatterns(m, version) {
    var size = m.length;
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);

    // Timing patterns.
    for (var i = 8; i < size - 8; i++) {
      m[6][i] = i % 2 === 0;
      m[i][6] = i % 2 === 0;
    }

    placeAlignment(m, version);

    // The dark module, always set, just above the bottom-left finder.
    m[size - 8][8] = true;

    // Reserve the format-information areas so data placement skips them.
    for (var k = 0; k <= 8; k++) {
      if (m[8][k] === null) m[8][k] = false;
      if (m[k][8] === null) m[k][8] = false;
    }
    for (var n = 0; n < 8; n++) {
      if (m[8][size - 1 - n] === null) m[8][size - 1 - n] = false;
      if (m[size - 1 - n][8] === null) m[size - 1 - n][8] = false;
    }

    // Version information (versions 7 and up).
    if (version >= 7) {
      for (var v = 0; v < 18; v++) {
        var row = Math.floor(v / 3);
        var col = size - 11 + (v % 3);
        m[row][col] = false;
        m[col][row] = false;
      }
    }
  }

  /** Copy of the matrix marking which cells are function patterns (unavailable). */
  function reservedMap(version, size) {
    var probe = makeMatrix(size);
    placeFunctionPatterns(probe, version);
    var map = new Array(size);
    for (var r = 0; r < size; r++) {
      map[r] = new Array(size);
      for (var c = 0; c < size; c++) map[r][c] = probe[r][c] !== null;
    }
    return map;
  }

  function placeData(m, reserved, bits) {
    var size = m.length;
    var index = 0;
    var upward = true;
    for (var right = size - 1; right > 0; right -= 2) {
      if (right === 6) right--; // column 6 is the vertical timing pattern
      for (var step = 0; step < size; step++) {
        var row = upward ? size - 1 - step : step;
        for (var c = 0; c < 2; c++) {
          var col = right - c;
          if (reserved[row][col]) continue;
          m[row][col] = index < bits.length ? bits[index] === 1 : false;
          index++;
        }
      }
      upward = !upward;
    }
  }

  // ------------------------------------------------------------------ masks

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
  ];

  function applyMask(m, reserved, maskIndex) {
    var fn = MASKS[maskIndex];
    var out = m.map(function (row) { return row.slice(); });
    for (var r = 0; r < out.length; r++) {
      for (var c = 0; c < out.length; c++) {
        if (!reserved[r][c] && fn(r, c)) out[r][c] = !out[r][c];
      }
    }
    return out;
  }

  /** The four ISO 18004 penalty rules; lower is better. */
  function penalty(m) {
    var size = m.length;
    var score = 0;
    var r, c, run, dark = 0;

    // Rule 1: runs of five or more same-coloured modules in a row or column.
    for (r = 0; r < size; r++) {
      run = 1;
      for (c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
    for (c = 0; c < size; c++) {
      run = 1;
      for (r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }

    // Rule 2: 2x2 blocks of one colour.
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules beside them.
    var a = [true, false, true, true, true, false, true];
    var pre = [false, false, false, false];
    function matches(line, start) {
      for (var i = 0; i < 7; i++) if (line[start + i] !== a[i]) return false;
      return true;
    }
    function quiet(line, start) {
      for (var i = 0; i < 4; i++) if (line[start + i] !== pre[i]) return false;
      return true;
    }
    for (r = 0; r < size; r++) {
      var rowLine = m[r];
      var colLine = [];
      for (c = 0; c < size; c++) colLine.push(m[c][r]);
      [rowLine, colLine].forEach(function (line) {
        for (var i = 0; i + 7 <= size; i++) {
          if (!matches(line, i)) continue;
          var before = i >= 4 && quiet(line, i - 4);
          var after = i + 11 <= size && quiet(line, i + 7);
          if (before || after) score += 40;
        }
      });
    }

    // Rule 4: deviation from a 50/50 balance of dark and light.
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (m[r][c]) dark++;
    var percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }

  // ------------------------------------------------------- format / version

  function formatBits(ecc, mask) {
    var data = (ECC_BITS[ecc] << 3) | mask;
    var rem = data << 10;
    for (var i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionBits(version) {
    var rem = version << 12;
    for (var i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
    return (version << 12) | rem;
  }

  function writeFormat(m, ecc, mask) {
    var size = m.length;
    var bits = formatBits(ecc, mask);
    for (var i = 0; i < 15; i++) {
      var bit = ((bits >>> i) & 1) === 1;
      // Copy around the top-left finder.
      if (i < 6) m[i][8] = bit;
      else if (i === 6) m[7][8] = bit;
      else if (i === 7) m[8][8] = bit;
      else if (i === 8) m[8][7] = bit;
      else m[8][14 - i] = bit;
      // Mirrored copy along the top-right and bottom-left finders.
      if (i < 8) m[8][size - 1 - i] = bit;
      else m[size - 15 + i][8] = bit;
    }
    m[size - 8][8] = true; // dark module
  }

  function writeVersion(m, version) {
    if (version < 7) return;
    var size = m.length;
    var bits = versionBits(version);
    for (var i = 0; i < 18; i++) {
      var bit = ((bits >>> i) & 1) === 1;
      var row = Math.floor(i / 3);
      var col = size - 11 + (i % 3);
      m[row][col] = bit;
      m[col][row] = bit;
    }
  }

  // ----------------------------------------------------------------- encode

  function dataCapacity(version, ecc) {
    var t = ECC_TABLE[ecc][version - 1];
    return t[1] * t[2] + t[3] * t[4];
  }

  function chooseVersion(byteLength, ecc) {
    for (var v = 1; v <= MAX_VERSION; v++) {
      var countBits = v < 10 ? 8 : 16;
      var needed = Math.ceil((4 + countBits + byteLength * 8) / 8);
      if (needed <= dataCapacity(v, ecc)) return v;
    }
    return null;
  }

  function buildCodewords(bytes, version, ecc) {
    var countBits = version < 10 ? 8 : 16;
    var capacity = dataCapacity(version, ecc);
    var buf = new BitBuffer();
    buf.put(0b0100, 4);            // byte mode
    buf.put(bytes.length, countBits);
    for (var i = 0; i < bytes.length; i++) buf.put(bytes[i], 8);

    // Terminator, then pad to a whole number of codewords.
    var capacityBits = capacity * 8;
    var terminator = Math.min(4, capacityBits - buf.bits.length);
    buf.put(0, terminator);
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);

    var codewords = [];
    for (var b = 0; b < buf.bits.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | buf.bits[b + k];
      codewords.push(byte);
    }
    var padBytes = [0xec, 0x11];
    for (var p = 0; codewords.length < capacity; p++) codewords.push(padBytes[p % 2]);
    return codewords;
  }

  /** Split into blocks, add error correction, then interleave per the spec. */
  function interleave(codewords, version, ecc) {
    var t = ECC_TABLE[ecc][version - 1];
    var ecLength = t[0];
    var groups = [[t[1], t[2]], [t[3], t[4]]];
    var dataBlocks = [];
    var ecBlocks = [];
    var offset = 0;

    groups.forEach(function (g) {
      for (var b = 0; b < g[0]; b++) {
        var block = codewords.slice(offset, offset + g[1]);
        offset += g[1];
        dataBlocks.push(block);
        ecBlocks.push(reedSolomon(block, ecLength));
      }
    });

    var out = [];
    var maxData = Math.max.apply(null, dataBlocks.map(function (b) { return b.length; }));
    for (var i = 0; i < maxData; i++) {
      for (var d = 0; d < dataBlocks.length; d++) {
        if (i < dataBlocks[d].length) out.push(dataBlocks[d][i]);
      }
    }
    for (var j = 0; j < ecLength; j++) {
      for (var e = 0; e < ecBlocks.length; e++) out.push(ecBlocks[e][j]);
    }
    return out;
  }

  /**
   * Encode `text` as a QR code.
   *
   * @param {string} text            Content, encoded as UTF-8 in byte mode.
   * @param {string} [ecc='M']       Error-correction level: L, M, Q or H.
   * @param {number} [minVersion=1]  Force at least this version (bigger symbol).
   * @returns {{size:number, modules:boolean[][], version:number, ecc:string}}
   */
  function encode(text, ecc, minVersion) {
    ecc = (ecc || 'M').toUpperCase();
    if (!ECC_TABLE[ecc]) throw new Error('Unknown error-correction level: ' + ecc);

    var bytes = utf8Bytes(String(text));
    var version = chooseVersion(bytes.length, ecc);
    if (version === null) {
      throw new Error(
        'Content is too long for a version-' + MAX_VERSION + ' QR code at level ' +
        ecc + ' (' + bytes.length + ' bytes). Shorten the URL or use a lower level.'
      );
    }
    if (minVersion && minVersion > version) {
      if (minVersion > MAX_VERSION) throw new Error('minVersion above ' + MAX_VERSION);
      version = minVersion;
    }

    var codewords = buildCodewords(bytes, version, ecc);
    var finalWords = interleave(codewords, version, ecc);

    var bits = [];
    finalWords.forEach(function (w) {
      for (var i = 7; i >= 0; i--) bits.push((w >>> i) & 1);
    });

    var size = version * 4 + 17;
    var reserved = reservedMap(version, size);
    var base = makeMatrix(size);
    placeFunctionPatterns(base, version);
    placeData(base, reserved, bits);

    // Pick the mask with the lowest penalty score.
    var best = null;
    var bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var candidate = applyMask(base, reserved, mask);
      writeFormat(candidate, ecc, mask);
      writeVersion(candidate, version);
      var score = penalty(candidate);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return { size: size, modules: best, version: version, ecc: ecc };
  }

  /**
   * Escape text for an XML attribute. The output claims to be SVG, so it has
   * to be well-formed XML: an unescaped "&" in a name like "Truck & Trailer"
   * makes the whole document fail to parse when it is loaded as an image.
   */
  function escapeXml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Render an encoded QR code as a standalone SVG string.
   *
   * @param {object} qr      Result of encode().
   * @param {object} [opts]  { scale, margin, dark, light, title }
   */
  function toSVG(qr, opts) {
    opts = opts || {};
    var scale = opts.scale || 4;
    var margin = opts.margin === undefined ? 4 : opts.margin;
    var dark = opts.dark || '#000000';
    var light = opts.light || '#ffffff';
    var dim = (qr.size + margin * 2) * scale;

    var path = [];
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (!qr.modules[r][c]) continue;
        path.push('M' + (c + margin) * scale + ' ' + (r + margin) * scale +
                  'h' + scale + 'v' + scale + 'h-' + scale + 'z');
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
      '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img"' +
      (opts.title ? ' aria-label="' + escapeXml(opts.title) + '"' : '') +
      '><rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
      '<path fill="' + dark + '" d="' + path.join('') + '"/></svg>';
  }

  return {
    encode: encode,
    toSVG: toSVG,
    MAX_VERSION: MAX_VERSION,
    _internal: { ECC_TABLE: ECC_TABLE, TOTAL_CODEWORDS: TOTAL_CODEWORDS, dataCapacity: dataCapacity }
  };
});
