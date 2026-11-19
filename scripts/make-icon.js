'use strict';
// Draws icon.png (128 x 128), our own design: three topic lanes of message ticks on a dark tile, a signal curve and a
// time cursor over them. 4x4 supersampling, written as a plain RGBA PNG with zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const N = 128; const SS = 4; const W = N * SS;
const acc = new Float32Array(W * W * 4);
function put(x, y, c) { if (x < 0 || y < 0 || x >= W || y >= W) return; const i = (y * W + x) * 4; const a = c[3] / 255; for (let k = 0; k < 3; k++) acc[i + k] = acc[i + k] * (1 - a) + c[k] * a; acc[i + 3] = Math.max(acc[i + 3], c[3]); }
function rrect(x0, y0, x1, y1, r, c) {
  for (let y = Math.floor(y0 * SS); y < Math.ceil(y1 * SS); y++) for (let x = Math.floor(x0 * SS); x < Math.ceil(x1 * SS); x++) {
    const px = (x + 0.5) / SS; const py = (y + 0.5) / SS;
    const dx = Math.max(x0 + r - px, 0, px - (x1 - r)); const dy = Math.max(y0 + r - py, 0, py - (y1 - r));
    if (dx * dx + dy * dy <= r * r) put(x, y, c);
  }
}
function disc(cx, cy, r, c) { for (let y = Math.floor((cy - r) * SS); y <= Math.ceil((cy + r) * SS); y++) for (let x = Math.floor((cx - r) * SS); x <= Math.ceil((cx + r) * SS); x++) { const px = (x + 0.5) / SS - cx; const py = (y + 0.5) / SS - cy; if (px * px + py * py <= r * r) put(x, y, c); } }
function line(pts, w, c) { for (let i = 1; i < pts.length; i++) { const [a, b] = [pts[i - 1], pts[i]]; const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 4) + 1; for (let k = 0; k <= n; k++) { const t = k / n; disc(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, w / 2, c); } } }
function tri(p, c) { const [A, B, C] = p; const ar = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]); for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const px = (x + 0.5) / SS; const py = (y + 0.5) / SS; const w0 = ((B[0] - px) * (C[1] - py) - (C[0] - px) * (B[1] - py)) / ar; const w1 = ((C[0] - px) * (A[1] - py) - (A[0] - px) * (C[1] - py)) / ar; if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) put(x, y, c); } }

rrect(4, 4, 124, 124, 22, [22, 36, 46, 255]);
for (const [y, col, step] of [[30, [86, 196, 214, 255], 5], [52, [245, 178, 66, 255], 9], [74, [140, 206, 120, 255], 14]]) {
  rrect(16, y - 1, 112, y + 1, 1, [48, 66, 78, 255]);
  for (let x = 18; x <= 110; x += step) rrect(x - 1.5, y - 6, x + 1.5, y + 6, 1, col);
}
const pts = [];
for (let i = 0; i <= 96; i++) { const v = Math.sin((i / 96) * 2 * Math.PI * 1.5) * 0.6 + Math.sin((i / 96) * 2 * Math.PI * 4.2) * 0.25; pts.push([16 + i, 100 - v * 10]); }
line(pts, 4, [235, 240, 245, 255]);
line([[78, 20], [78, 114]], 3, [255, 110, 90, 255]);
tri([[71, 13], [85, 13], [78, 22]], [255, 110, 90, 255]);

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const s = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) { const i = ((y * SS + sy) * W + x * SS + sx) * 4; const a = acc[i + 3] / 255; s[0] += acc[i] * a; s[1] += acc[i + 1] * a; s[2] += acc[i + 2] * a; s[3] += a; }
    const o = y * (N * 4 + 1) + 1 + x * 4; const a = s[3] / (SS * SS);
    raw[o] = s[3] ? Math.round(s[0] / s[3]) : 0; raw[o + 1] = s[3] ? Math.round(s[1] / s[3]) : 0; raw[o + 2] = s[3] ? Math.round(s[2] / s[3]) : 0; raw[o + 3] = Math.round(a * 255);
  }
}
const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(path.join(__dirname, '..', 'icon.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote icon.png');
