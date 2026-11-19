'use strict';
// Opens an MCAP file or a ROS 1 bag (format 2.0) through a random-access source and gives one shape for both:
// summary facts (topics, types, counts, rates, time range, schemas, chunks), a message iterator by topic and time,
// and a decoder per topic. Reads only what it needs: an indexed MCAP or a bag is never read in full.
// An MCAP file without a summary section is read in full (up to MAX_UNINDEXED bytes). No vscode import.
const fs = require('fs');
const V = require('../../lib/vendor.js');
const { makeDecoder, utf8 } = require('./decode');

const MCAP_MAGIC = Buffer.from([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]);
const BAG2 = '#ROSBAG V2.0\n';
const MAX_UNINDEXED = 1024 * 1024 * 1024;
const MAX_CHUNK_HEADERS = 5000;

class RecordingError extends Error {
  constructor(message, kind) { super(message); this.kind = kind || 'error'; }
}

// ---------- sources ----------
/** A source over bytes in memory. */
function bufferSource(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { size: b.byteLength, read: async (off, len) => b.subarray(off, Math.min(b.byteLength, off + len)), close: async () => {}, bytes: b };
}
/** A source over a local file: reads ranges with a file handle, never the whole file. */
async function fileSource(fsPath) {
  const fh = await fs.promises.open(fsPath, 'r');
  const st = await fh.stat();
  let closed = false;
  return {
    size: st.size,
    async read(off, len) {
      const n = Math.max(0, Math.min(len, st.size - off));
      const buf = Buffer.allocUnsafe(n);
      let got = 0;
      while (got < n) {
        const r = await fh.read(buf, got, n - got, off + got);
        if (!r.bytesRead) break;
        got += r.bytesRead;
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, got);
    },
    async close() { if (!closed) { closed = true; await fh.close(); } },
  };
}

// ---------- time ----------
const NS = 1000000000n;
const timeToNs = (t) => (t ? BigInt(t.sec) * NS + BigInt(t.nsec !== undefined ? t.nsec : t.nanosec || 0) : 0n);
const nsToTime = (ns) => ({ sec: Number(ns / NS), nsec: Number(ns % NS) });
const nsToSec = (ns) => Number(ns) / 1e9;
/** 1700000000.123456789 */
function nsText(ns) {
  const neg = ns < 0n; const a = neg ? -ns : ns;
  return `${neg ? '-' : ''}${a / NS}.${String(a % NS).padStart(9, '0')}`;
}
/** Parses seconds ("12.5", "1700000000.25") to ns. */
function secToNs(s) {
  const m = /^\s*(-?)(\d*)(?:\.(\d{0,9})\d*)?\s*$/.exec(String(s));
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) return null;
  const v = BigInt(m[2] || '0') * NS + BigInt((m[3] || '').padEnd(9, '0') || '0');
  return m[1] ? -v : v;
}

const decompressHandlers = {
  lz4: (buf, size) => V.lz4Decompress(buf, Number(size)),
  zstd: (buf) => V.zstdDecompress(buf),
};
const bagDecompress = {
  lz4: (buf, size) => V.lz4Decompress(buf, size),
  bz2: (buf, size) => V.bz2Decompress(buf, size),
};

/** 'mcap', 'bag', 'bag12' (old format), or '' from the first bytes. */
function detectFormat(head) {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(MCAP_MAGIC)) return 'mcap';
  const s = b.subarray(0, 13).toString('latin1');
  if (s === BAG2) return 'bag';
  if (/^#ROSBAG V1\.\d/.test(s)) return 'bag12';
  return '';
}

function rate(count, firstNs, lastNs) {
  if (count < 2 || lastNs <= firstNs) return 0;
  const r = (count - 1) / nsToSec(lastNs - firstNs);
  return Number.isFinite(r) ? r : 0;
}

function compressionSummary(list) {
  const by = {};
  let compressed = 0n; let uncompressed = 0n;
  for (const c of list) {
    const k = c.compression || 'none';
    by[k] = (by[k] || 0) + 1;
    compressed += BigInt(c.compressedSize || 0);
    uncompressed += BigInt(c.uncompressedSize || 0);
  }
  return { count: list.length, by, compressedBytes: Number(compressed), uncompressedBytes: Number(uncompressed) };
}

// ---------- MCAP ----------
async function openMcap(src, o) {
  let reader = null;
  let indexError = '';
  try {
    reader = await V.McapIndexedReader.Initialize({
      readable: { size: async () => BigInt(src.size), read: async (off, len) => src.read(Number(off), Number(len)) },
      decompressHandlers,
    });
  } catch (e) { indexError = String((e && e.message) || e); reader = null; }
  // Messages outside chunks, or chunks whose channels are not repeated in the summary: no index to seek with.
  if (reader && reader.chunkIndexes.length === 0 && reader.statistics && reader.statistics.messageCount > 0n) reader = null;
  if (reader && reader.chunkIndexes.length > 0 && reader.channelsById.size === 0) reader = null;
  if (!reader) return openMcapStream(src, o, indexError);

  const schemas = new Map(reader.schemasById);
  const channels = new Map(reader.channelsById);
  const stats = reader.statistics;
  const warnings = [];
  const counts = new Map();
  if (stats) for (const [id, n] of stats.channelMessageCounts) counts.set(id, Number(n));
  else {
    warnings.push('This file has no statistics record, so the messages were counted one by one.');
    for await (const m of reader.readMessages()) counts.set(m.channelId, (counts.get(m.channelId) || 0) + 1);
  }
  const rec = baseMcap({ schemas, channels, header: reader.header, size: src.size, warnings, indexed: true });
  rec.chunks = compressionSummary(reader.chunkIndexes);
  rec.chunkList = reader.chunkIndexes.map((c) => ({ compression: c.compression || 'none', compressedSize: Number(c.compressedSize), uncompressedSize: Number(c.uncompressedSize), startNs: c.messageStartTime, endNs: c.messageEndTime }));
  rec.attachments = reader.attachmentIndexes.map((a) => ({ name: a.name, mediaType: a.mediaType, size: Number(a.dataSize), logNs: a.logTime }));
  rec.metadata = [];
  try { for await (const m of reader.readMetadata()) rec.metadata.push({ name: m.name, entries: Object.fromEntries(m.metadata) }); } catch (e) { warnings.push(`Metadata could not be read: ${e.message}`); }
  rec.iterate = (opt) => mcapIndexedIterate(reader, rec, opt);
  rec.readAttachments = () => reader.readAttachments();
  rec.firstLast = (ids) => mcapFirstLast(src, reader.chunkIndexes, ids);
  await finishTopics(rec, counts, stats ? stats.messageStartTime : null, stats ? stats.messageEndTime : null);
  rec.close = () => src.close();
  return rec;
}

function baseMcap({ schemas, channels, header, size, warnings, indexed }) {
  return {
    format: 'mcap', formatLabel: 'MCAP', profile: (header && header.profile) || '', library: (header && header.library) || '',
    size, warnings, indexed, schemas, channels, topics: [], chunks: { count: 0, by: {}, compressedBytes: 0, uncompressedBytes: 0 },
    chunkList: [], attachments: [], metadata: [], startNs: 0n, endNs: 0n, messageCount: 0,
  };
}

/** Reads one MCAP Message Index record (opcode 0x07): [{ logNs }] without decompressing the chunk. */
async function mcapIndexTimes(src, offset) {
  const head = await src.read(offset, 15);
  if (head.byteLength < 15 || head[0] !== 0x07) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const n = dv.getUint32(11, true);
  if (n > 64 * 1024 * 1024) return null;
  const body = await src.read(offset + 15, n);
  const b = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out = [];
  for (let p = 0; p + 16 <= body.byteLength; p += 16) out.push(b.getBigUint64(p, true));
  return out;
}
/** First and last log time of channels from the chunk indexes and message indexes, or null to read messages. */
async function mcapFirstLast(src, chunkIndexes, ids) {
  const withIdx = chunkIndexes.filter((c) => ids.some((id) => c.messageIndexOffsets.has(id)));
  if (!withIdx.length) return null;
  const byStart = [...withIdx].sort((a, b) => (a.messageStartTime < b.messageStartTime ? -1 : 1));
  const byEnd = [...withIdx].sort((a, b) => (a.messageEndTime > b.messageEndTime ? -1 : 1));
  let first = null; let last = null;
  const scan = async (c) => {
    for (const id of ids) {
      const off = c.messageIndexOffsets.get(id);
      if (off === undefined) continue;
      const times = await mcapIndexTimes(src, Number(off));
      if (!times) return false;
      for (const t of times) { if (first === null || t < first) first = t; if (last === null || t > last) last = t; }
    }
    return true;
  };
  // Chunks can overlap in time: look at every chunk that starts before the first time found (and ends after the last).
  for (const c of byStart) { if (first !== null && c.messageStartTime > first) break; if (!(await scan(c))) return null; }
  for (const c of byEnd) { if (last !== null && c.messageEndTime < last) break; if (!(await scan(c))) return null; }
  return first === null ? null : { first, last };
}

async function* mcapIndexedIterate(reader, rec, opt = {}) {
  const topics = opt.topics && opt.topics.length ? opt.topics : undefined;
  const args = { topics, reverse: !!opt.reverse, validateCrcs: false };
  if (opt.startNs !== undefined && opt.startNs !== null) args.startingAt = BigInt(opt.startNs);
  if (opt.endNs !== undefined && opt.endNs !== null) args.endingAt = BigInt(opt.endNs);
  if (opt.beforeNs !== undefined && opt.beforeNs !== null) { delete args.endingAt; args.endingBefore = BigInt(opt.beforeNs); }
  for await (const m of reader.readMessages(args)) {
    const ch = rec.channels.get(m.channelId);
    yield { topic: ch ? ch.topic : `channel ${m.channelId}`, channelId: m.channelId, sequence: m.sequence, logNs: m.logTime, publishNs: m.publishTime, data: m.data };
  }
}

async function openMcapStream(src, o, indexError) {
  if (src.size > MAX_UNINDEXED) throw new RecordingError(`This MCAP file has no summary section (no index), and at ${Math.round(src.size / 1048576)} MB it is too large to read in full (the limit is 1 GB). Run "mcap recover" on it to add an index.`, 'noindex');
  const bytes = src.bytes || await src.read(0, src.size);
  const r = new V.McapStreamReader({ includeChunks: true, decompressHandlers, validateCrcs: false });
  r.append(bytes);
  const schemas = new Map(); const channels = new Map();
  let header = null; const msgs = []; const chunks = []; const attachments = []; const metadata = [];
  let ended = false;
  try {
    for (let rec; (rec = r.nextRecord());) {
      switch (rec.type) {
        case 'Header': header = rec; break;
        case 'Schema': schemas.set(rec.id, rec); break;
        case 'Channel': channels.set(rec.id, rec); break;
        case 'Message': msgs.push(rec); break;
        case 'Chunk': chunks.push({ compression: rec.compression, compressedSize: rec.records.byteLength, uncompressedSize: Number(rec.uncompressedSize), startNs: rec.messageStartTime, endNs: rec.messageEndTime }); break;
        case 'Attachment': attachments.push({ name: rec.name, mediaType: rec.mediaType, size: rec.data.byteLength, logNs: rec.logTime, data: rec.data, createNs: rec.createTime }); break;
        case 'Metadata': metadata.push({ name: rec.name, entries: Object.fromEntries(rec.metadata) }); break;
        case 'DataEnd': case 'Footer': ended = true; break;
        default:
      }
    }
  } catch (e) {
    if (!msgs.length && !channels.size) throw new RecordingError(`This MCAP file could not be read: ${(e && e.message) || e}`, 'error');
  }
  if (!header && !msgs.length && !channels.size) throw new RecordingError('This MCAP file holds no records.', 'error');
  const warnings = [];
  if (!ended || !r.done()) warnings.push('The file ends early (it looks cut off). The messages before the cut are shown.');
  warnings.push('This file has no summary section (no index), so it was read in full.');
  if (indexError && !/summary|footer|magic/i.test(indexError)) warnings.push(`Index: ${indexError}`);
  msgs.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : 0));
  const rec = baseMcap({ schemas, channels, header, size: src.size, warnings, indexed: false });
  rec.chunks = compressionSummary(chunks);
  rec.chunkList = chunks;
  rec.attachments = attachments.map(({ data, ...a }) => a);
  rec.metadata = metadata;
  rec.readAttachments = async function* () { for (const a of attachments) yield { name: a.name, mediaType: a.mediaType, logTime: a.logNs, createTime: a.createNs, data: a.data }; };
  const counts = new Map();
  for (const m of msgs) counts.set(m.channelId, (counts.get(m.channelId) || 0) + 1);
  rec.iterate = (opt) => memoryIterate(msgs, rec, opt);
  await finishTopics(rec, counts, msgs.length ? msgs[0].logTime : null, msgs.length ? msgs[msgs.length - 1].logTime : null);
  rec.close = () => src.close();
  return rec;
}

/** Messages kept in memory (sorted by log time), filtered like the indexed reader. */
async function* memoryIterate(msgs, rec, opt = {}) {
  const want = opt.topics && opt.topics.length ? new Set(opt.topics) : null;
  const start = opt.startNs !== undefined && opt.startNs !== null ? BigInt(opt.startNs) : null;
  const end = opt.endNs !== undefined && opt.endNs !== null ? BigInt(opt.endNs) : null;
  const before = opt.beforeNs !== undefined && opt.beforeNs !== null ? BigInt(opt.beforeNs) : null;
  const n = msgs.length;
  for (let k = 0; k < n; k++) {
    const m = msgs[opt.reverse ? n - 1 - k : k];
    const ch = rec.channels.get(m.channelId);
    const topic = ch ? ch.topic : `channel ${m.channelId}`;
    if (want && !want.has(topic)) continue;
    if (start !== null && m.logTime < start) continue;
    if (end !== null && m.logTime > end) continue;
    if (before !== null && m.logTime >= before) continue;
    yield { topic, channelId: m.channelId, sequence: m.sequence, logNs: m.logTime, publishNs: m.publishTime, data: m.data };
  }
}

// ---------- ROS 1 bag ----------
/** Reads the compression and sizes from the record header of each chunk (a few bytes per chunk). */
async function bagChunkHeaders(src, chunkInfos) {
  const out = [];
  for (const ci of chunkInfos.slice(0, MAX_CHUNK_HEADERS)) {
    const pos = Number(ci.chunkPosition);
    const head = await src.read(pos, 4096);
    if (head.byteLength < 8) continue;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const hlen = dv.getUint32(0, true);
    if (hlen + 8 > head.byteLength) continue;
    const fields = {};
    for (let p = 4; p < 4 + hlen;) {
      const flen = dv.getUint32(p, true); p += 4;
      const f = Buffer.from(head.buffer, head.byteOffset + p, flen); p += flen;
      const eq = f.indexOf(0x3d);
      if (eq > 0) fields[f.subarray(0, eq).toString('latin1')] = f.subarray(eq + 1);
    }
    const dlen = dv.getUint32(4 + hlen, true);
    ci.zovoIndexPos = pos + 4 + hlen + 4 + dlen;
    out.push({
      compression: fields.compression ? fields.compression.toString('latin1') : 'none',
      uncompressedSize: fields.size && fields.size.length >= 4 ? fields.size.readUInt32LE(0) : 0,
      compressedSize: dlen,
      startNs: timeToNs(ci.startTime), endNs: timeToNs(ci.endTime),
    });
  }
  return out;
}

/** Times of the index data records (op 0x04) that follow a chunk: Map conn -> [ns]. */
async function bagIndexTimes(src, ci) {
  if (ci.zovoIndexTimes) return ci.zovoIndexTimes;
  const out = new Map();
  let pos = ci.zovoIndexPos;
  if (pos === undefined) return null;
  for (let k = 0; k < (ci.connections || []).length; k++) {
    const h = await src.read(pos, 4);
    if (h.byteLength < 4) return null;
    const hlen = new DataView(h.buffer, h.byteOffset, 4).getUint32(0, true);
    const hb = Buffer.from(await src.read(pos + 4, hlen + 4));
    const fields = {};
    for (let p = 0; p + 4 <= hlen;) { const fl = hb.readUInt32LE(p); p += 4; const f = hb.subarray(p, p + fl); p += fl; const eq = f.indexOf(0x3d); if (eq > 0) fields[f.subarray(0, eq).toString('latin1')] = f.subarray(eq + 1); }
    if (!fields.op || fields.op[0] !== 0x04 || !fields.conn) return null;
    const dlen = hb.readUInt32LE(hlen);
    const data = Buffer.from(await src.read(pos + 4 + hlen + 4, dlen));
    const times = [];
    for (let p = 0; p + 12 <= data.length; p += 12) times.push(BigInt(data.readUInt32LE(p)) * NS + BigInt(data.readUInt32LE(p + 4)));
    out.set(fields.conn.readInt32LE(0), times);
    pos += 4 + hlen + 4 + dlen;
  }
  ci.zovoIndexTimes = out;
  return out;
}
async function bagFirstLast(src, chunkInfos, ids) {
  const has = (ci) => (ci.connections || []).some((c) => ids.includes(c.conn));
  const list = chunkInfos.filter(has);
  if (!list.length) return null;
  const byStart = [...list].sort((a, b) => (timeToNs(a.startTime) < timeToNs(b.startTime) ? -1 : 1));
  const byEnd = [...list].sort((a, b) => (timeToNs(a.endTime) > timeToNs(b.endTime) ? -1 : 1));
  let first = null; let last = null;
  const scan = async (ci) => {
    const m = await bagIndexTimes(src, ci);
    if (!m) return false;
    for (const id of ids) for (const t of m.get(id) || []) { if (first === null || t < first) first = t; if (last === null || t > last) last = t; }
    return true;
  };
  for (const ci of byStart) { if (first !== null && timeToNs(ci.startTime) > first) break; if (!(await scan(ci))) return null; }
  for (const ci of byEnd) { if (last !== null && timeToNs(ci.endTime) < last) break; if (!(await scan(ci))) return null; }
  return first === null ? null : { first, last };
}

async function openBag(src) {
  const bag = new V.Bag({ read: (off, len) => src.read(off, len), size: () => src.size }, { decompress: bagDecompress, parse: false });
  try { await bag.open(); } catch (e) {
    throw new RecordingError(`This bag could not be read: ${String((e && e.message) || e).replace(/\.+$/, '')}. It may be cut off or still being recorded (run "rosbag reindex" on it).`, 'error');
  }
  const schemas = new Map(); const channels = new Map();
  for (const [id, c] of bag.connections) {
    schemas.set(id, { id, name: c.type || '', encoding: 'ros1msg', data: Buffer.from(c.messageDefinition || '', 'utf8') });
    const md = new Map();
    if (c.md5sum) md.set('md5sum', c.md5sum);
    if (c.callerid) md.set('callerid', c.callerid);
    if (c.latching) md.set('latching', '1');
    channels.set(id, { id, schemaId: id, topic: c.topic, messageEncoding: 'ros1', metadata: md });
  }
  const counts = new Map();
  for (const ci of bag.chunkInfos) for (const cc of ci.connections || []) counts.set(cc.conn, (counts.get(cc.conn) || 0) + cc.count);
  const warnings = [];
  if (!bag.chunkInfos.length && bag.connections.size) warnings.push('This bag has no chunk index, so no messages can be listed. Run "rosbag reindex" on it.');
  const rec = {
    format: 'bag', formatLabel: 'ROS 1 bag', profile: 'ros1', library: 'rosbag 2.0 format', size: src.size, warnings, indexed: true,
    schemas, channels, topics: [], chunks: null, chunkList: [], attachments: [], metadata: [], startNs: 0n, endNs: 0n, messageCount: 0,
  };
  rec.chunkList = await bagChunkHeaders(src, bag.chunkInfos);
  rec.chunks = compressionSummary(rec.chunkList);
  if (bag.chunkInfos.length > MAX_CHUNK_HEADERS) warnings.push(`Chunk facts cover the first ${MAX_CHUNK_HEADERS} of ${bag.chunkInfos.length} chunks.`);
  rec.iterate = (opt) => bagIterate(bag, rec, opt);
  rec.firstLast = (ids) => bagFirstLast(src, bag.chunkInfos, ids);
  rec.readAttachments = async function* () {};
  await finishTopics(rec, counts, bag.startTime ? timeToNs(bag.startTime) : null, bag.endTime ? timeToNs(bag.endTime) : null);
  rec.close = () => src.close();
  return rec;
}

async function* bagIterate(bag, rec, opt = {}) {
  if (!bag.chunkInfos.length) return;
  const it = bag.messageIterator({
    topics: opt.topics && opt.topics.length ? opt.topics : undefined,
    reverse: !!opt.reverse,
    start: opt.reverse
      ? (opt.endNs !== undefined && opt.endNs !== null ? nsToTime(BigInt(opt.endNs)) : opt.beforeNs !== undefined && opt.beforeNs !== null ? nsToTime(BigInt(opt.beforeNs)) : undefined)
      : (opt.startNs !== undefined && opt.startNs !== null ? nsToTime(BigInt(opt.startNs)) : undefined),
  });
  const start = opt.startNs !== undefined && opt.startNs !== null ? BigInt(opt.startNs) : null;
  const end = opt.endNs !== undefined && opt.endNs !== null ? BigInt(opt.endNs) : null;
  const before = opt.beforeNs !== undefined && opt.beforeNs !== null ? BigInt(opt.beforeNs) : null;
  for await (const m of it) {
    const t = timeToNs(m.timestamp);
    if (opt.reverse) {
      if (start !== null && t < start) return;
      if ((end !== null && t > end) || (before !== null && t >= before)) continue;
    } else {
      if ((end !== null && t > end) || (before !== null && t >= before)) return;
      if (start !== null && t < start) continue;
    }
    yield { topic: m.topic, channelId: m.connectionId, sequence: 0, logNs: t, publishNs: t, data: m.data };
  }
}

// ---------- shared ----------
/** Topic rows (one per topic, channels of the same topic merged), totals and decoders. */
async function finishTopics(rec, counts, startNs, endNs) {
  const byTopic = new Map();
  for (const [id, ch] of rec.channels) {
    const s = rec.schemas.get(ch.schemaId);
    let t = byTopic.get(ch.topic);
    if (!t) {
      t = { topic: ch.topic, type: s ? s.name : '', schemaEncoding: s ? s.encoding : '', messageEncoding: ch.messageEncoding, channelIds: [], count: 0, firstNs: null, lastNs: null, hz: 0, metadata: Object.fromEntries(ch.metadata || []) };
      byTopic.set(ch.topic, t);
    }
    t.channelIds.push(id);
    t.count += counts.get(id) || 0;
  }
  const topics = [...byTopic.values()].sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
  rec.messageCount = topics.reduce((n, t) => n + t.count, 0);
  // First and last message time of each topic (2 small reads each), for the rate.
  for (const [k, t] of topics.entries()) {
    if (!t.count) continue;
    let fl = null;
    if (rec.firstLast) { try { fl = await rec.firstLast(t.channelIds); } catch (e) { fl = null; } }
    if (fl) { t.firstNs = fl.first; t.lastNs = fl.last; t.hz = rate(t.count, fl.first, fl.last); continue; }
    if (k < 400) {
      for await (const m of rec.iterate({ topics: [t.topic] })) { t.firstNs = m.logNs; break; }
      for await (const m of rec.iterate({ topics: [t.topic], reverse: true })) { t.lastNs = m.logNs; break; }
      if (t.firstNs !== null && t.lastNs !== null) t.hz = rate(t.count, t.firstNs, t.lastNs);
    }
  }
  rec.topics = topics;
  const firsts = topics.map((t) => t.firstNs).filter((x) => x !== null);
  const lasts = topics.map((t) => t.lastNs).filter((x) => x !== null);
  rec.startNs = startNs !== null && startNs !== undefined && rec.messageCount ? BigInt(startNs) : (firsts.length ? firsts.reduce((a, b) => (b < a ? b : a)) : 0n);
  rec.endNs = endNs !== null && endNs !== undefined && rec.messageCount ? BigInt(endNs) : (lasts.length ? lasts.reduce((a, b) => (b > a ? b : a)) : 0n);
  const decoders = new Map();
  rec.topicInfo = (topic) => byTopic.get(topic) || null;
  rec.decoderFor = (topic, channelId) => {
    const t = byTopic.get(topic);
    const id = channelId !== undefined && channelId !== null ? channelId : t && t.channelIds[0];
    if (decoders.has(id)) return decoders.get(id);
    const ch = rec.channels.get(id);
    const s = ch && rec.schemas.get(ch.schemaId);
    const d = makeDecoder({ messageEncoding: ch ? ch.messageEncoding : '', schemaEncoding: s ? s.encoding : '', schemaName: s ? s.name : '', schemaData: s ? s.data : null });
    decoders.set(id, d);
    return d;
  };
}

/** Opens a recording from a source. Throws RecordingError with a plain message for files it cannot read. */
async function openRecording(src, o = {}) {
  if (!src.size) throw new RecordingError('This file is empty.', 'empty');
  const head = await src.read(0, Math.min(16, src.size));
  const fmt = detectFormat(head);
  if (fmt === 'mcap') return openMcap(src, o);
  if (fmt === 'bag') return openBag(src, o);
  if (fmt === 'bag12') throw new RecordingError('This is a ROS bag in the old 1.2 format. Run "rosbag fix" on it to write a 2.0 bag, which this viewer opens.', 'old');
  throw new RecordingError('This file is not an MCAP file or a ROS 1 bag: it does not start with the MCAP magic bytes or "#ROSBAG V2.0".', 'notrec');
}

/** Opens a local path (random access) or bytes. */
async function openPath(fsPath) {
  const src = await fileSource(fsPath);
  try { return await openRecording(src); } catch (e) { await src.close(); throw e; }
}

/** The schema text of a topic (empty for binary schemas). */
function schemaText(rec, topic) {
  const t = rec.topicInfo(topic);
  if (!t) return '';
  const ch = rec.channels.get(t.channelIds[0]);
  const s = ch && rec.schemas.get(ch.schemaId);
  if (!s || !s.data || !s.data.byteLength) return '';
  if (s.encoding === 'protobuf') return `(protobuf FileDescriptorSet, ${s.data.byteLength} bytes)`;
  return utf8(s.data);
}

module.exports = {
  openRecording, openPath, bufferSource, fileSource, detectFormat, RecordingError, schemaText,
  timeToNs, nsToTime, nsToSec, nsText, secToNs, rate, MAX_UNINDEXED, NS,
};
