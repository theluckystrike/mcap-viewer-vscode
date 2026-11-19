'use strict';
// Pro tool 2: a time range and a set of topics saved as a new MCAP file. Messages are copied byte for byte with their
// schema and channel; a ROS 1 bag becomes an MCAP file with the ros1 profile (ros1msg schemas, ros1 messages).
// MCAP metadata records are copied; attachments are copied when their log time is in the range.
// Chunks are LZ4 compressed (or not compressed). No vscode import.
const V = require('../../lib/vendor.js');

const LIBRARY = 'Zovo MCAP Viewer';

/** A writable for McapWriter over write(bytes). */
function writableOf(write) {
  let pos = 0n;
  return { position: () => pos, write: async (b) => { await write(b); pos += BigInt(b.byteLength); } };
}

/**
 * rec: an open recording; o: { topics: string[] (empty = all), startNs, endNs (inclusive, bigint or null),
 * compression: 'lz4' | 'none', write: async (Uint8Array) => void }. Returns { messages, topics, channels, startNs, endNs, bytes }.
 */
async function trimToMcap(rec, o) {
  let bytes = 0;
  const writable = writableOf(async (b) => { bytes += b.byteLength; await o.write(b); });
  const compress = o.compression === 'none' ? undefined : (data) => ({ compression: 'lz4', compressedData: V.lz4Compress(data) });
  const w = new V.McapWriter({ writable, chunkSize: 1 << 20, compressChunk: compress, useStatistics: true, useSummaryOffsets: true, useChunkIndex: true, useMessageIndex: true, repeatSchemas: true, repeatChannels: true });
  await w.start({ profile: rec.profile || (rec.format === 'bag' ? 'ros1' : ''), library: LIBRARY });
  const want = o.topics && o.topics.length ? new Set(o.topics) : null;
  const schemaIds = new Map();
  const channelIds = new Map();
  const usedTopics = new Set();
  let messages = 0; let first = null; let last = null;
  async function channelFor(srcId) {
    if (channelIds.has(srcId)) return channelIds.get(srcId);
    const ch = rec.channels.get(srcId);
    const s = ch && rec.schemas.get(ch.schemaId);
    let schemaId = 0;
    if (s) {
      if (!schemaIds.has(s.id)) schemaIds.set(s.id, await w.registerSchema({ name: s.name, encoding: s.encoding, data: s.data }));
      schemaId = schemaIds.get(s.id);
    }
    const id = await w.registerChannel({ topic: ch.topic, messageEncoding: ch.messageEncoding, schemaId, metadata: new Map(ch.metadata || []) });
    channelIds.set(srcId, id);
    return id;
  }
  // Every chosen topic keeps its channel, even when no message falls in the range.
  for (const t of rec.topics) if (!want || want.has(t.topic)) for (const id of t.channelIds) await channelFor(id);
  for await (const m of rec.iterate({ topics: want ? [...want] : undefined, startNs: o.startNs, endNs: o.endNs })) {
    const channelId = await channelFor(m.channelId);
    await w.addMessage({ channelId, sequence: m.sequence || 0, logTime: m.logNs, publishTime: m.publishNs, data: m.data });
    usedTopics.add(m.topic);
    messages++;
    if (first === null) first = m.logNs;
    last = m.logNs;
  }
  for (const md of rec.metadata || []) await w.addMetadata({ name: md.name, metadata: new Map(Object.entries(md.entries || {})) });
  if (rec.readAttachments) {
    for await (const a of rec.readAttachments()) {
      if (o.startNs !== null && o.startNs !== undefined && a.logTime < BigInt(o.startNs)) continue;
      if (o.endNs !== null && o.endNs !== undefined && a.logTime > BigInt(o.endNs)) continue;
      await w.addAttachment({ name: a.name, logTime: a.logTime, createTime: a.createTime, mediaType: a.mediaType, data: a.data });
    }
  }
  await w.end();
  return { messages, topics: usedTopics.size, channels: channelIds.size, startNs: first, endNs: last, bytes };
}

module.exports = { trimToMcap, LIBRARY };
