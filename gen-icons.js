// Generates icon16.png, icon48.png, icon128.png using only Node.js built-ins.
// Each icon is a minimal valid PNG with the Avenue logo drawn as solid pixels.
import { writeFileSync } from 'fs';
import { createHash } from 'crypto';
import zlib from 'zlib';

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function chunk(type, data) {
  const typeB = Buffer.from(type);
  const len = u32be(data.length);
  const crcVal = crc32(Buffer.concat([typeB, data]));
  return Buffer.concat([len, typeB, data, u32be(crcVal)]);
}

function makePNG(size, drawFn) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);   // width
  ihdr.writeUInt32BE(size, 4);   // height
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Draw pixels — RGBA into rows
  const pixels = new Uint8Array(size * size * 4); // RGBA

  drawFn(pixels, size);

  // Convert to RGB scanlines with filter byte
  const scanlines = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    scanlines[y * (1 + size * 3)] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const srcOff = (y * size + x) * 4;
      const a = pixels[srcOff + 3] / 255;
      // Blend with transparent (assume dark bg for icon)
      const r = Math.round(pixels[srcOff] * a);
      const g = Math.round(pixels[srcOff + 1] * a);
      const b = Math.round(pixels[srcOff + 2] * a);
      const dstOff = y * (1 + size * 3) + 1 + x * 3;
      scanlines[dstOff] = r;
      scanlines[dstOff + 1] = g;
      scanlines[dstOff + 2] = b;
    }
  }

  const idat = zlib.deflateSync(scanlines);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function setPixel(pixels, size, x, y, r, g, b, a = 255) {
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i = (y * size + x) * 4;
  pixels[i] = r; pixels[i+1] = g; pixels[i+2] = b; pixels[i+3] = a;
}

function fillRect(pixels, size, x, y, w, h, r, g, b, a = 255) {
  for (let row = y; row < y + h; row++)
    for (let col = x; col < x + w; col++)
      setPixel(pixels, size, col, row, r, g, b, a);
}

// Draw the Avenue icon: a shelf rail with staggered lanes.
function drawIcon(pixels, size) {
  const s = size;
  const [ar, ag, ab] = [88, 104, 232]; // accent indigo
  const [lr, lg, lb] = [164, 176, 255]; // softer lane tint

  // Left column — ~22% of width
  const colW = Math.max(1, Math.round(s * 0.22));
  fillRect(pixels, s, 0, 0, colW, s, ar, ag, ab);

  // 4 horizontal bars
  const gap = Math.round(s * 0.07);
  const barH = Math.max(1, Math.round(s * 0.14));
  const x0 = colW + Math.round(s * 0.08);
  const widths = [0.62, 0.48, 0.62, 0.42]; // fractions of remaining width
  const totalH = barH * 4 + gap * 3;
  let y0 = Math.round((s - totalH) / 2);

  for (let i = 0; i < 4; i++) {
    const bw = Math.round((s - x0 - Math.round(s * 0.06)) * widths[i]);
    fillRect(pixels, s, x0, y0, bw, barH, lr, lg, lb);
    y0 += barH + gap;
  }
}

for (const size of [16, 48, 128]) {
  const png = makePNG(size, drawIcon);
  writeFileSync(`icons/icon${size}.png`, png);
  console.log(`icons/icon${size}.png written (${png.length} bytes)`);
}
