// Zero-dependency QR encoder (SVG output), used to draw project submit links in the browser.
/**
 * Riah QR — a QR code generator with no dependencies.
 *
 * Why this exists rather than an npm package or a QR web service:
 * the main use here is Riah Swipe submit links, and those
 * URLs contain a secret access token. Sending one to api.qrserver.com or any hosted
 * generator would hand that token to a third party in a request they log. A local
 * encoder is the only privacy-safe option, so this one is bundled.
 *
 * Scope: byte mode (any UTF-8 text), versions 1–10, all four error-correction levels.
 * Version 10 at level M holds 213 bytes — comfortably more than any link we produce.
 * Output is SVG: crisp at any size, no canvas, works on a server or in a browser.
 *
 *   import { qrSvg } from './qr.mjs'
 *   const svg = qrSvg('https://example.com/submit#t=abc', { scale: 8 })
 *
 * The maths is the standard one (ISO/IEC 18004): Reed–Solomon over GF(256) with the
 * primitive polynomial 0x11D, then the usual placement, masking and format bits.
 */

// ── GF(256) ──────────────────────────────────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    // Multiply by (x + α^i). Index 0 is the HIGHEST-degree coefficient, so the x term
    // keeps its index and the α^i term moves down one. Having these two swapped
    // produced ECC that looked plausible and was completely wrong — caught only by
    // checking against the spec's own worked example.
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                       // × x
      next[j + 1] ^= gfMul(poly[j], EXP[i]);    // × α^i
    }
    poly = next;
  }
  return poly;
}

/** The `degree` ECC codewords for one block of data. */
export function rsEncode(data, degree) {
  const gen = rsGenerator(degree);
  const out = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.copyWithin(0, 1);
    out[degree - 1] = 0;
    for (let i = 0; i < degree; i++) out[i] ^= gfMul(gen[i + 1], factor);
  }
  return out;
}

// ── Capacity tables, versions 1–10 ───────────────────────────────────────────
// [total codewords, [L,M,Q,H] ecc-per-block, [L,M,Q,H] block counts as [g1, g2]]
const VERSIONS = {
  1:  { total: 26,  ecc: [7, 10, 13, 17],  blocks: [[1, 0], [1, 0], [1, 0], [1, 0]] },
  2:  { total: 44,  ecc: [10, 16, 22, 28], blocks: [[1, 0], [1, 0], [1, 0], [1, 0]] },
  3:  { total: 70,  ecc: [15, 26, 18, 22], blocks: [[1, 0], [1, 0], [2, 0], [2, 0]] },
  4:  { total: 100, ecc: [20, 18, 26, 16], blocks: [[1, 0], [2, 0], [2, 0], [4, 0]] },
  5:  { total: 134, ecc: [26, 24, 18, 22], blocks: [[1, 0], [2, 0], [2, 2], [2, 2]] },
  6:  { total: 172, ecc: [18, 16, 24, 28], blocks: [[2, 0], [4, 0], [4, 0], [4, 0]] },
  7:  { total: 196, ecc: [20, 18, 18, 26], blocks: [[2, 0], [4, 0], [2, 4], [4, 1]] },
  8:  { total: 242, ecc: [24, 22, 22, 26], blocks: [[2, 0], [2, 2], [4, 2], [4, 2]] },
  9:  { total: 292, ecc: [30, 22, 20, 24], blocks: [[2, 0], [3, 2], [4, 4], [4, 4]] },
  10: { total: 346, ecc: [18, 26, 24, 28], blocks: [[2, 2], [4, 1], [6, 2], [6, 2]] },
};
const LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const dataCapacity = (version, level) => {
  const v = VERSIONS[version];
  const [g1, g2] = v.blocks[LEVELS[level]];
  return v.total - v.ecc[LEVELS[level]] * (g1 + g2);
};

// ── Bit buffer ───────────────────────────────────────────────────────────────
class Bits {
  constructor() { this.bits = []; }
  push(value, length) { for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1); }
  get length() { return this.bits.length; }
  toBytes() {
    while (this.bits.length % 8) this.bits.push(0);
    const out = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
    return out;
  }
}

// ── Encode ───────────────────────────────────────────────────────────────────
function buildCodewords(text, version, level) {
  const bytes = new TextEncoder().encode(text);
  const capacity = dataCapacity(version, level);
  const bits = new Bits();
  bits.push(0b0100, 4);                               // byte mode
  bits.push(bytes.length, version < 10 ? 8 : 16);     // character count
  for (const b of bytes) bits.push(b, 8);
  // Terminator, then pad alternately with 236/17 as the spec requires.
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.bits.push(0);
  const data = Array.from(bits.toBytes());
  for (let i = 0; data.length < capacity; i++) data.push(i % 2 === 0 ? 0xec : 0x11);

  // Split into blocks, compute ECC, then interleave both.
  const v = VERSIONS[version];
  const eccLen = v.ecc[LEVELS[level]];
  const [g1, g2] = v.blocks[LEVELS[level]];
  const totalBlocks = g1 + g2;
  const shortLen = Math.floor(capacity / totalBlocks);

  const dataBlocks = [];
  const eccBlocks = [];
  let at = 0;
  for (let i = 0; i < totalBlocks; i++) {
    const len = i < g1 ? shortLen : shortLen + 1;
    const block = data.slice(at, at + len);
    at += len;
    dataBlocks.push(block);
    eccBlocks.push(rsEncode(block, eccLen));
  }

  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < eccLen; i++) for (const b of eccBlocks) out.push(b[i]);
  return out;
}

function pickVersion(text, level) {
  const bytes = new TextEncoder().encode(text).length;
  for (let v = 1; v <= 10; v++) {
    const headerBits = 4 + (v < 10 ? 8 : 16);
    if (bytes + Math.ceil(headerBits / 8) <= dataCapacity(v, level)) return v;
  }
  throw new Error(`QR: ${bytes} bytes is beyond version 10 at level ${level}. Shorten the text or use a lower ECC level.`);
}

// ── Matrix ───────────────────────────────────────────────────────────────────
function buildMatrix(version, level, codewords, mask) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inner = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const on = inner && (dr === 0 || dr === 6 || dc === 0 || dc === 6
          || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        m[rr][cc] = on ? 1 : 0;
        reserved[rr][cc] = true;
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {              // timing
    const on = i % 2 === 0 ? 1 : 0;
    m[6][i] = on; reserved[6][i] = true;
    m[i][6] = on; reserved[i][6] = true;
  }

  for (const r of ALIGN[version]) {                  // alignment
    for (const c of ALIGN[version]) {
      if ((r < 9 && c < 9) || (r < 9 && c > size - 10) || (r > size - 10 && c < 9)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          m[r + dr][c + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
          reserved[r + dr][c + dc] = true;
        }
      }
    }
  }

  m[size - 8][8] = 1; reserved[size - 8][8] = true;  // dark module
  for (let i = 0; i < 9; i++) {                      // format areas
    if (!reserved[8][i]) { reserved[8][i] = true; m[8][i] = 0; }
    if (!reserved[i][8]) { reserved[i][8] = true; m[i][8] = 0; }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true; m[8][size - 1 - i] = m[8][size - 1 - i] ?? 0;
    reserved[size - 1 - i][8] = true; m[size - 1 - i][8] = m[size - 1 - i][8] ?? 0;
  }
  if (version >= 7) {                                // version info areas
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      reserved[i][size - 11 + j] = true; m[i][size - 11 + j] = 0;
      reserved[size - 11 + j][i] = true; m[size - 11 + j][i] = 0;
    }
  }

  // Zig-zag data placement, skipping the timing column.
  const maskFn = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ][mask];

  let bit = 0;
  const stream = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) stream.push((cw >> i) & 1);

  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;                            // the timing column is never data
    for (let n = 0; n < size; n++) {
      const row = upward ? size - 1 - n : n;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        let v = bit < stream.length ? stream[bit++] : 0;
        if (maskFn(row, c)) v ^= 1;
        m[row][c] = v;
      }
    }
    upward = !upward;
  }

  // Format information: 5 bits (level + mask) with BCH(15,5), XOR 0x5412.
  const FORMAT_LEVEL = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
  let fmt = (FORMAT_LEVEL[level] << 3) | mask;
  let rem = fmt;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const formatBits = ((fmt << 10) | rem) ^ 0x5412;
  // The 15 bits are written TWICE, in two differently-shaped runs, so a symbol survives
  // damage to one corner. Both copies are indexed [row][col] here; the spec and most
  // reference implementations use (x, y), which is the trap — read one of those as
  // [row][col] and you get a perfectly plausible symbol with copy 1 transposed.
  //
  // Copy 1, wrapping the top-left finder: bits 0–5 go DOWN column 8, bits 9–14 go ALONG
  // row 8, and the three in the middle turn the corner. This was transposed until
  // 2026-07-29 — every scanner still read the codes, because copy 2 was right and
  // decoders fall back to it, so nothing visibly failed while the symbol quietly had
  // half its format redundancy missing.
  for (let i = 0; i < 15; i++) {
    const b = (formatBits >> i) & 1;
    if (i < 6) m[i][8] = b;
    else if (i === 6) m[7][8] = b;
    else if (i === 7) m[8][8] = b;
    else if (i === 8) m[8][7] = b;
    else m[8][14 - i] = b;
    // Copy 2: bits 0–7 ALONG row 8 from the right edge inwards, bits 8–14 DOWN column 8
    // to the bottom edge.
    if (i < 8) m[8][size - 1 - i] = b;
    else m[size - 15 + i][8] = b;
  }
  m[size - 8][8] = 1; // restate the dark module: it is fixed, and nothing may clobber it

  if (version >= 7) {                                // version info: BCH(18,6)
    let vrem = version;
    for (let i = 0; i < 12; i++) vrem = (vrem << 1) ^ ((vrem >> 11) * 0x1f25);
    const vBits = (version << 12) | vrem;
    for (let i = 0; i < 18; i++) {
      const b = (vBits >> i) & 1;
      const r = Math.floor(i / 3), c = size - 11 + (i % 3);
      m[r][c] = b; m[c][r] = b;
    }
  }

  return m;
}

/** Standard penalty score — lower is a more scannable code. */
function penalty(m) {
  const size = m.length;
  let score = 0;
  for (let r = 0; r < size; r++) {
    for (let dir = 0; dir < 2; dir++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        const cur = dir ? m[c][r] : m[r][c];
        const prev = dir ? m[c - 1][r] : m[r][c - 1];
        if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
  }
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** The QR modules as a 2-D array of 0/1. Row-major, no quiet zone. */
export function qrMatrix(text, { level = 'M', version } = {}) {
  if (typeof text !== 'string' || !text) throw new Error('QR: text is required');
  if (!(level in LEVELS)) throw new Error(`QR: level must be L, M, Q or H — got ${level}`);
  const v = version || pickVersion(text, level);
  if (!VERSIONS[v]) throw new Error(`QR: version ${v} is outside the supported range 1–10`);
  const codewords = buildCodewords(text, v, level);
  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = buildMatrix(v, level, codewords, mask);
    const s = penalty(m);
    if (s < bestScore) { bestScore = s; best = m; }
  }
  return best;
}

/**
 * A self-contained SVG string. No external anything, safe to inline or write to disk.
 * `quiet` is the mandatory light margin — scanners need it; 4 modules is the spec.
 */
export function qrSvg(text, { level = 'M', scale = 8, quiet = 4, dark = '#000000', light = '#ffffff', title } = {}) {
  const m = qrMatrix(text, { level });
  const size = m.length;
  const dim = (size + quiet * 2) * scale;
  const parts = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!m[r][c]) { c++; continue; }
      let run = 1;
      while (c + run < size && m[r][c + run]) run++;   // merge runs: far fewer rects
      parts.push(`M${(c + quiet) * scale} ${(r + quiet) * scale}h${run * scale}v${scale}h-${run * scale}z`);
      c += run;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img"${title ? ` aria-label="${String(title).replace(/"/g, '&quot;')}"` : ' aria-hidden="true"'}>`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${parts.join('')}" fill="${dark}"/></svg>`;
}

export const QR_MAX_BYTES = { L: dataCapacity(10, 'L'), M: dataCapacity(10, 'M'), Q: dataCapacity(10, 'Q'), H: dataCapacity(10, 'H') };
