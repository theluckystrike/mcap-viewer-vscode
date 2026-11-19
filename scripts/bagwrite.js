'use strict';
// A small ROS 1 bag (format 2.0) writer for our samples and test fixtures. Not shipped (scripts/ is excluded).
// Layout: magic, bag header record (padded to 4096 bytes), chunks (each followed by its index data records),
// then the connection records and chunk info records the bag header points to.
const V = require('../lib/vendor.js');

function field(name, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const n = Buffer.from(`${name}=`, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32LE(n.length + v.length, 0);
  return Buffer.concat([len, n, v]);
}
const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32LE(x >>> 0, 0); return b; };
const i32 = (x) => { const b = Buffer.alloc(4); b.writeInt32LE(x, 0); return b; };
const u64 = (x) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(x), 0); return b; };
const time = (t) => Buffer.concat([u32(t.sec), u32(t.nsec)]);
const op = (n) => Buffer.from([n]);
function record(fields, data) {
  const h = Buffer.concat(fields);
  return Buffer.concat([u32(h.length), h, u32(data.length), data]);
}

/**
 * conns: [{ id, topic, type, md5sum, definition, callerid?, latching? }]
 * msgs: [{ conn, time: { sec, nsec }, data: Uint8Array }] in time order. o: { chunkSize, compression: 'none'|'lz4', truncateAt? }
 */
function writeBag(conns, msgs, o = {}) {
  const chunkSize = o.chunkSize || 256 * 1024;
  const compression = o.compression || 'none';
  const connRecord = (c) => record(
    [field('op', op(0x07)), field('conn', i32(c.id)), field('topic', c.topic)],
    Buffer.concat([field('topic', c.topic), field('type', c.type), field('md5sum', c.md5sum), field('message_definition', c.definition),
      ...(c.callerid ? [field('callerid', c.callerid)] : []), ...(c.latching ? [field('latching', '1')] : [])]),
  );
  const parts = []; let pos = 13 + 4096;
  const chunkInfos = [];
  let i = 0;
  while (i < msgs.length) {
    const body = []; let size = 0; const index = new Map(); const seenConn = new Set();
    let start = null; let end = null;
    while (i < msgs.length && size < chunkSize) {
      const m = msgs[i++];
      if (!seenConn.has(m.conn)) { seenConn.add(m.conn); const r = connRecord(conns.find((c) => c.id === m.conn)); body.push(r); size += r.length; }
      const offset = size;
      const r = record([field('op', op(0x02)), field('conn', i32(m.conn)), field('time', time(m.time))], Buffer.from(m.data));
      body.push(r); size += r.length;
      if (!index.has(m.conn)) index.set(m.conn, []);
      index.get(m.conn).push({ time: m.time, offset });
      if (!start) start = m.time;
      end = m.time;
    }
    const raw = Buffer.concat(body);
    const data = compression === 'lz4' ? Buffer.from(V.lz4Compress(raw)) : raw;
    const chunk = record([field('op', op(0x05)), field('compression', compression), field('size', u32(raw.length))], data);
    chunkInfos.push({ pos, start, end, counts: [...index].map(([c, l]) => [c, l.length]) });
    parts.push(chunk); pos += chunk.length;
    for (const [c, list] of index) {
      const d = Buffer.concat(list.map((e) => Buffer.concat([time(e.time), u32(e.offset)])));
      const r = record([field('op', op(0x04)), field('ver', i32(1)), field('conn', i32(c)), field('count', i32(list.length))], d);
      parts.push(r); pos += r.length;
    }
  }
  const indexPos = pos;
  for (const c of conns) parts.push(connRecord(c));
  for (const ci of chunkInfos) {
    parts.push(record(
      [field('op', op(0x06)), field('ver', i32(1)), field('chunk_pos', u64(ci.pos)), field('start_time', time(ci.start)), field('end_time', time(ci.end)), field('count', i32(ci.counts.length))],
      Buffer.concat(ci.counts.map(([c, n]) => Buffer.concat([i32(c), i32(n)]))),
    ));
  }
  const hdrFields = [field('op', op(0x03)), field('index_pos', u64(indexPos)), field('conn_count', i32(conns.length)), field('chunk_count', i32(chunkInfos.length))];
  const hlen = Buffer.concat(hdrFields).length;
  const header = record(hdrFields, Buffer.alloc(4096 - 4 - hlen - 4, 0x20));
  const out = Buffer.concat([Buffer.from('#ROSBAG V2.0\n', 'latin1'), header, ...parts]);
  return o.truncateAt ? out.subarray(0, o.truncateAt) : out;
}

module.exports = { writeBag };
