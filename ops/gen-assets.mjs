/**
 * Generates the app icon, adaptive icon, splash mark and favicon as PNGs.
 *
 * Drawn with pure pixel maths + a minimal PNG encoder so the build has no image
 * toolchain dependency and the assets are reproducible from source.
 *
 *   node ops/gen-assets.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'apps/mobile/assets');

const NAVY = [0x0b, 0x1b, 0x33];
const BLUE = [0x3b, 0x7d, 0xff];
const WHITE = [0xff, 0xff, 0xff];
const LIGHT = [0xd8, 0xe4, 0xfb];

/* ------------------------------------------------------------------ *
 * PNG encoder
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode an RGBA Uint8Array as a PNG buffer. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Raw scanlines, each prefixed with filter byte 0.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Shape maths
 * ------------------------------------------------------------------ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Signed-ish test for a rounded rectangle. */
function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Shield silhouette in normalised [0,1] space: rounded shoulders, straight
 * flanks, tapering to a point.
 */
function insideShield(x, y) {
  const top = 0.13;
  const shoulder = 0.34;
  const flankEnd = 0.56;
  const tip = 0.9;
  const halfTop = 0.265;
  const radius = 0.11;

  if (y < top || y > tip) return false;

  if (y <= shoulder) {
    return insideRoundRect(x, y, 0.5 - halfTop, top, 0.5 + halfTop, shoulder + radius, radius);
  }

  if (y <= flankEnd) {
    return Math.abs(x - 0.5) <= halfTop;
  }

  const t = (y - flankEnd) / (tip - flankEnd);
  const half = halfTop * Math.pow(1 - t, 0.62);
  return Math.abs(x - 0.5) <= half;
}

/** Shortest distance from a point to a line segment. */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : clamp01(((px - x1) * dx + (py - y1) * dy) / lenSq);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Checkmark inside the shield — the "validated" emblem. */
function insideCheck(x, y) {
  const stroke = 0.042;
  const a = distToSegment(x, y, 0.355, 0.475, 0.455, 0.585);
  const b = distToSegment(x, y, 0.455, 0.585, 0.65, 0.355);
  return Math.min(a, b) <= stroke;
}

/** Supersampled coverage of a predicate over one pixel. */
function coverage(px, py, size, predicate, samples = 3) {
  let hits = 0;
  const step = 1 / (samples + 1);
  for (let sy = 1; sy <= samples; sy += 1) {
    for (let sx = 1; sx <= samples; sx += 1) {
      const x = (px + sx * step) / size;
      const y = (py + sy * step) / size;
      if (predicate(x, y)) hits += 1;
    }
  }
  return hits / (samples * samples);
}

function blend(dst, offset, colour, alpha) {
  if (alpha <= 0) return;
  const a = clamp01(alpha);
  const inv = 1 - a;
  dst[offset] = Math.round(colour[0] * a + dst[offset] * inv);
  dst[offset + 1] = Math.round(colour[1] * a + dst[offset + 1] * inv);
  dst[offset + 2] = Math.round(colour[2] * a + dst[offset + 2] * inv);
  dst[offset + 3] = Math.round(255 * a + dst[offset + 3] * inv);
}

/* ------------------------------------------------------------------ *
 * Renderers
 * ------------------------------------------------------------------ */

/** Full app icon: navy rounded square + shield + chevron. */
function renderIcon(size, { rounded, background }) {
  const rgba = new Uint8Array(size * size * 4);
  const cornerRadius = rounded ? 0.22 : 0;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;

      if (background) {
        const bgAlpha = rounded
          ? coverage(x, y, size, (nx, ny) => insideRoundRect(nx, ny, 0, 0, 1, 1, cornerRadius))
          : 1;
        blend(rgba, i, background, bgAlpha);
      }

      const shield = coverage(x, y, size, insideShield);
      if (shield > 0) {
        // Subtle vertical gradient on the shield for depth.
        const ny = y / size;
        const tint = [
          Math.round(LIGHT[0] + (WHITE[0] - LIGHT[0]) * (1 - ny)),
          Math.round(LIGHT[1] + (WHITE[1] - LIGHT[1]) * (1 - ny)),
          Math.round(LIGHT[2] + (WHITE[2] - LIGHT[2]) * (1 - ny)),
        ];
        blend(rgba, i, tint, shield);
      }

      const chevron = coverage(x, y, size, insideCheck);
      if (chevron > 0) blend(rgba, i, BLUE, chevron * 0.97);
    }
  }

  return rgba;
}

/** Splash mark: just the shield, transparent background. */
function renderMark(size) {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const shield = coverage(x, y, size, insideShield);
      if (shield > 0) blend(rgba, i, WHITE, shield);
      const chevron = coverage(x, y, size, insideCheck);
      if (chevron > 0) blend(rgba, i, BLUE, chevron * 0.95);
    }
  }
  return rgba;
}

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

mkdirSync(ASSETS, { recursive: true });

const outputs = [
  ['icon.png', 1024, renderIcon(1024, { rounded: true, background: NAVY })],
  ['adaptive-icon.png', 1024, renderIcon(1024, { rounded: false, background: null })],
  ['splash.png', 1024, renderMark(1024)],
  ['favicon.png', 96, renderIcon(96, { rounded: true, background: NAVY })],
  ['notification-icon.png', 96, renderMark(96)],
];

for (const [name, size, rgba] of outputs) {
  const png = encodePng(size, size, rgba);
  writeFileSync(join(ASSETS, name), png);
  console.log(`  ${name.padEnd(24)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

console.log(`\nAssets written to ${ASSETS}`);
