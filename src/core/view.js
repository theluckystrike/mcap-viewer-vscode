'use strict';
// What the webview gets: the summary as JSON (bigint times as strings), pages of decoded messages, and plot series.
// No vscode import.
const R = require('./recording');
const { toPlain, hexPreview } = require('./decode');
const { numericPaths, numberAt } = require('./fields');

const PAGE = 50;
const MAX_PLOT_POINTS = 4000;
const MAX_PLOT_SCAN = 500000;
const MAX_SCHEMA_TEXT = 40000;

function sizeText(n) {
  if (n < 1024) return `${n} bytes`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]}`;
}
function isoOf(ns) {
  const ms = Number(ns / 1000000n);
  if (ms < 315532800000) return ''; // before 1980: a simulated or relative clock
  try { return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, `.${String(ns % 1000000000n).padStart(9, '0')} UTC`); } catch (e) { return ''; }
}

function infoView(rec, name) {
  const dur = rec.messageCount ? R.nsToSec(rec.endNs - rec.startNs) : 0;
  const schemaTopics = new Map();
  for (const ch of rec.channels.values()) {
    if (!schemaTopics.has(ch.schemaId)) schemaTopics.set(ch.schemaId, []);
    schemaTopics.get(ch.schemaId).push(ch.topic);
  }
  const schemas = [...rec.schemas.values()].map((s) => {
    let text = '';
    if (s.encoding === 'protobuf') text = `(a protobuf FileDescriptorSet of ${s.data.byteLength} bytes)`;
    else if (s.data && s.data.byteLength) { text = Buffer.from(s.data.buffer, s.data.byteOffset, s.data.byteLength).toString('utf8'); if (text.length > MAX_SCHEMA_TEXT) text = `${text.slice(0, MAX_SCHEMA_TEXT)}\n... (${text.length} characters)`; }
    return { id: s.id, name: s.name, encoding: s.encoding || '(none)', size: s.data ? s.data.byteLength : 0, topics: [...new Set(schemaTopics.get(s.id) || [])], text };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
  const c = rec.chunks || { count: 0, by: {}, compressedBytes: 0, uncompressedBytes: 0 };
  return {
    name, format: rec.format, formatLabel: rec.formatLabel, profile: rec.profile, library: rec.library, size: rec.size, sizeText: sizeText(rec.size),
    indexed: rec.indexed, startNs: rec.startNs.toString(), endNs: rec.endNs.toString(), start: R.nsText(rec.startNs), end: R.nsText(rec.endNs),
    startIso: isoOf(rec.startNs), endIso: isoOf(rec.endNs), durationSec: dur, messageCount: rec.messageCount,
    topics: rec.topics.map((t) => {
      const d = rec.decoderFor(t.topic);
      return {
        topic: t.topic, type: t.type, schemaEncoding: t.schemaEncoding, messageEncoding: t.messageEncoding, count: t.count, hz: t.hz,
        firstNs: t.firstNs === null ? null : t.firstNs.toString(), lastNs: t.lastNs === null ? null : t.lastNs.toString(),
        channels: t.channelIds.length, decoder: d.kind, decoderError: d.error || '', metadata: t.metadata,
      };
    }),
    chunks: { ...c, compressedText: sizeText(c.compressedBytes), uncompressedText: sizeText(c.uncompressedBytes), ratio: c.compressedBytes ? c.uncompressedBytes / c.compressedBytes : 0 },
    schemas,
    attachments: rec.attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, size: a.size, sizeText: sizeText(a.size), log: R.nsText(a.logNs) })),
    metadata: rec.metadata,
    warnings: rec.warnings,
  };
}

function itemOf(rec, dec, m) {
  const it = { ns: m.logNs.toString(), rel: R.nsToSec(m.logNs - rec.startNs), size: m.data.byteLength, sequence: m.sequence || 0 };
  if (rec.format === 'mcap' && m.publishNs !== m.logNs) it.publish = R.nsText(m.publishNs);
  if (dec.decode) {
    try { it.value = toPlain(dec.decode(m.data)); } catch (e) { it.error = `Could not decode: ${(e && e.message) || e}`; it.hex = hexPreview(m.data); }
  } else { it.hex = hexPreview(m.data); it.error = dec.error; }
  return it;
}

/**
 * One page of messages of a topic. q: { topic, fromNs (string), skip, count, back: true for the page before fromNs }.
 * Returns { topic, items, more, back }.
 */
async function page(rec, q) {
  const count = Math.max(1, Math.min(500, Number(q.count) || PAGE));
  const dec = rec.decoderFor(q.topic);
  const items = [];
  if (q.back) {
    for await (const m of rec.iterate({ topics: [q.topic], beforeNs: BigInt(q.fromNs), reverse: true })) {
      if (items.length >= count + 1) break;
      items.push(m);
    }
    const more = items.length > count;
    const list = items.slice(0, count).reverse();
    return { topic: q.topic, items: list.map((m) => itemOf(rec, dec, m)), more: true, atStart: !more };
  }
  let skip = Math.max(0, Number(q.skip) || 0);
  const from = q.fromNs !== undefined && q.fromNs !== null && q.fromNs !== '' ? BigInt(q.fromNs) : undefined;
  for await (const m of rec.iterate({ topics: [q.topic], startNs: from })) {
    if (skip > 0) { skip--; continue; }
    if (items.length >= count + 1) break;
    items.push(m);
  }
  const more = items.length > count;
  return { topic: q.topic, items: items.slice(0, count).map((m) => itemOf(rec, dec, m)), more, atStart: from === undefined || from <= rec.startNs };
}

/** Numeric field paths of a topic, from its first decodable message. */
async function fieldsOf(rec, topic) {
  const dec = rec.decoderFor(topic);
  if (!dec.decode) return { topic, paths: [], error: dec.error };
  let n = 0;
  for await (const m of rec.iterate({ topics: [topic] })) {
    if (++n > 20) break;
    try { return { topic, paths: numericPaths(dec.decode(m.data)) }; } catch (e) { /* try the next one */ }
  }
  return { topic, paths: [] };
}

/** One numeric field of a topic over time, min/max decimated to about MAX_PLOT_POINTS points. */
async function plotSeries(rec, topic, path, o = {}) {
  const dec = rec.decoderFor(topic);
  if (!dec.decode) return { topic, path, xs: [], ys: [], total: 0, missing: 0, error: dec.error };
  const xs = []; const ys = []; let missing = 0; let scanned = 0;
  const maxScan = o.maxScan || MAX_PLOT_SCAN;
  for await (const m of rec.iterate({ topics: [topic] })) {
    if (++scanned > maxScan) break;
    let v = null;
    try { v = numberAt(dec.decode(m.data), path); } catch (e) { v = null; }
    if (v === null) { missing++; continue; }
    xs.push(R.nsToSec(m.logNs - rec.startNs)); ys.push(v);
  }
  const total = xs.length;
  const max = o.maxPoints || MAX_PLOT_POINTS;
  let outX = xs; let outY = ys;
  if (total > max) {
    const buckets = Math.floor(max / 2); const per = total / buckets;
    outX = []; outY = [];
    for (let b = 0; b < buckets; b++) {
      const s = Math.floor(b * per); const e = Math.min(total, Math.floor((b + 1) * per));
      if (e <= s) continue;
      let lo = s; let hi = s;
      for (let i = s; i < e; i++) { if (ys[i] < ys[lo]) lo = i; if (ys[i] > ys[hi]) hi = i; }
      for (const i of lo <= hi ? [lo, hi] : [hi, lo]) { outX.push(xs[i]); outY.push(ys[i]); if (lo === hi) break; }
    }
  }
  let min = Infinity; let maxV = -Infinity;
  for (const y of ys) { if (y < min) min = y; if (y > maxV) maxV = y; }
  return { topic, path, xs: outX, ys: outY, total, missing, truncated: scanned > maxScan, min: total ? min : null, max: total ? maxV : null };
}

module.exports = { infoView, page, fieldsOf, plotSeries, sizeText, isoOf, PAGE, MAX_PLOT_POINTS };
