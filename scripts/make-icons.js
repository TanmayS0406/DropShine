'use strict';

/**
 * Generates assets/icon.png and the tray icons (assets/tray-<state>[@1.5x|@2x].png).
 * Dependency-free: shapes are rasterised with 4x4 supersampling and written as PNG via zlib.
 * Run `npm run icons` to regenerate.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'assets');

// ---- PNG encoding ----------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Drawing (coordinates are 0..1) ----------------------------------------

const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const roundedRect = (r) => (x, y) => {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return dx * dx + dy * dy <= r * r;
};
function triangle(ax, ay, bx, by, cx, cy) {
  const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  return (x, y) => {
    const d1 = sign(x, y, ax, ay, bx, by);
    const d2 = sign(x, y, bx, by, cx, cy);
    const d3 = sign(x, y, cx, cy, ax, ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
}

const arrow = [
  rect(0.44, 0.17, 0.56, 0.5),
  triangle(0.29, 0.44, 0.71, 0.44, 0.5, 0.67),
  rect(0.24, 0.76, 0.76, 0.83), // tray floor
  rect(0.24, 0.66, 0.31, 0.83), // tray sides
  rect(0.69, 0.66, 0.76, 0.83),
];
const inArrow = (x, y) => arrow.some((f) => f(x, y));
const tile = roundedRect(0.22);

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const DOT_COLORS = { busy: '#fbbf24', error: '#f87171', offline: '#9aa0b4' };

function render(size, dotColor) {
  const buf = Buffer.alloc(size * size * 4);
  const top = hex('#7c6cff');
  const bottom = hex('#4f8cff');
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          let c = null;
          if (dotColor && circle(0.77, 0.77, 0.27)(x, y)) {
            // dot with a dark ring so it reads on any taskbar colour
            c = circle(0.77, 0.77, 0.2)(x, y) ? hex(dotColor) : [20, 22, 30];
          } else if (tile(x, y)) {
            c = inArrow(x, y) ? [255, 255, 255] : lerp(top, bottom, y);
          }
          if (c) {
            r += c[0]; g += c[1]; b += c[2]; a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const cover = a / 255;
      buf[i] = cover ? Math.round(r / cover) : 0;
      buf[i + 1] = cover ? Math.round(g / cover) : 0;
      buf[i + 2] = cover ? Math.round(b / cover) : 0;
      buf[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.png'), render(256));

const TRAY_SIZES = { '': 16, '@1.5x': 24, '@2x': 32 };
for (const state of ['idle', 'busy', 'error', 'offline']) {
  for (const [suffix, size] of Object.entries(TRAY_SIZES)) {
    fs.writeFileSync(path.join(OUT, `tray-${state}${suffix}.png`), render(size, DOT_COLORS[state]));
  }
}
console.log(`Icons written to ${OUT}`);
