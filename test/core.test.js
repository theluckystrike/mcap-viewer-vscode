'use strict';
// Core tests without VS Code: opening MCAP files and ROS 1 bags (indexed, unindexed, compressed, cut off, broken),
// decoders (ROS 1, ROS 2 CDR, JSON, protobuf), pages, fields and plots, and the cores of the three Pro tools.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../src/core/recording');
const D = require('../src/core/decode');
const Fd = require('../src/core/fields');
const Vw = require('../src/core/view');
const { exportTopic } = require('../src/core/export');
const { trimToMcap } = require('../src/core/trim');
const C = require('../src/core/compare');

const ROOT = path.join(__dirname, '..');
const S = (f) => path.join(ROOT, 'samples', f);
const FX = (f) => path.join(__dirname, 'fixtures', f);
const open = (p) => R.openPath(p);
async function collect(it) { const out = []; for await (const x of it) out.push(x); return out; }
async function exportText(rec, o) { let s = ''; const r = await exportTopic(rec, { ...o, write: async (t) => { s += t; } }); return { r, s }; }
async function trimBytes(rec, o) { const parts = []; const r = await trimToMcap(rec, { ...o, write: async (b) => { parts.push(Buffer.from(b)); } }); return { r, bytes: Buffer.concat(parts) }; }

test('format detection: MCAP magic, bag 2.0, old bag 1.2, anything else', () => {
  assert.equal(R.detectFormat(fs.readFileSync(S('demo-rover-ros2.mcap')).subarray(0, 16)), 'mcap');
  assert.equal(R.detectFormat(fs.readFileSync(S('demo-rover-ros1.bag')).subarray(0, 16)), 'bag');
  assert.equal(R.detectFormat(fs.readFileSync(FX('old-format.bag')).subarray(0, 16)), 'bag12');
  assert.equal(R.detectFormat(Buffer.from('hello world, not a recording')), '');
});

test('time helpers: ns text, seconds to ns, rate', () => {
  assert.equal(R.nsText(1793611800000199891n), '1793611800.000199891');
  assert.equal(R.nsText(5n), '0.000000005');
  assert.equal(R.secToNs('12.5'), 12500000000n);
  assert.equal(R.secToNs('0'), 0n);
  assert.equal(R.secToNs('.25'), 250000000n);
  assert.equal(R.secToNs('1.1234567891'), 1123456789n);
  assert.equal(R.secToNs('abc'), null);
  assert.equal(R.secToNs(''), null);
  assert.equal(R.rate(11, 0n, 1000000000n), 10);
  assert.equal(R.rate(1, 0n, 5n), 0);
});

test('ROS 2 MCAP sample: profile, topics, types, counts, rates, range, zstd chunks, metadata and attachment', async () => {
  const rec = await open(S('demo-rover-ros2.mcap'));
  try {
    assert.equal(rec.format, 'mcap');
    assert.equal(rec.profile, 'ros2');
    assert.equal(rec.indexed, true);
    assert.equal(rec.messageCount, 2880);
    const t = Object.fromEntries(rec.topics.map((x) => [x.topic, x]));
    assert.deepEqual(Object.keys(t), ['/battery/voltage', '/cmd_vel', '/imu', '/pose', '/scan']);
    assert.equal(t['/imu'].type, 'sensor_msgs/msg/Imu');
    assert.equal(t['/imu'].count, 1500);
    assert.equal(t['/imu'].messageEncoding, 'cdr');
    assert.equal(t['/imu'].schemaEncoding, 'ros2msg');
    assert.ok(Math.abs(t['/imu'].hz - 50) < 0.01, String(t['/imu'].hz));
    assert.ok(Math.abs(t['/scan'].hz - 10) < 0.01);
    assert.ok(Math.abs(t['/battery/voltage'].hz - 1) < 0.01);
    assert.ok(Math.abs(R.nsToSec(rec.endNs - rec.startNs) - 29.98) < 0.01);
    assert.equal(rec.chunks.count, 4);
    assert.deepEqual(Object.keys(rec.chunks.by), ['zstd']);
    assert.ok(rec.chunks.uncompressedBytes > rec.chunks.compressedBytes * 2);
    assert.deepEqual(rec.metadata.map((m) => m.name), ['rover']);
    assert.equal(rec.metadata[0].entries.name, 'zovo-demo-rover');
    assert.deepEqual(rec.attachments.map((a) => [a.name, a.mediaType]), [['calibration/imu.yaml', 'application/yaml']]);
  } finally { await rec.close(); }
});

test('ROS 2 CDR decode: IMU, laser scan with 121 float32 ranges, Time fields', async () => {
  const rec = await open(S('demo-rover-ros2.mcap'));
  try {
    const [m] = await collect((async function* () { for await (const x of rec.iterate({ topics: ['/imu'] })) { yield x; return; } }()));
    const imu = rec.decoderFor('/imu').decode(m.data);
    assert.equal(imu.header.frame_id, 'imu_link');
    assert.equal(typeof imu.header.stamp.sec, 'number');
    assert.ok(Math.abs(imu.linear_acceleration.z - 9.81) < 0.1);
    assert.equal(imu.orientation_covariance.length, 9);
    for await (const x of rec.iterate({ topics: ['/scan'] })) {
      const scan = rec.decoderFor('/scan').decode(x.data);
      assert.equal(scan.ranges.length, 121);
      assert.ok(scan.ranges.every((r) => r > 0 && r <= 8));
      break;
    }
  } finally { await rec.close(); }
});

test('ROS 1 bag sample: lz4 chunks, connections as topics, md5 and caller id kept, ROS 1 decode', async () => {
  const rec = await open(S('demo-rover-ros1.bag'));
  try {
    assert.equal(rec.format, 'bag');
    assert.equal(rec.formatLabel, 'ROS 1 bag');
    assert.equal(rec.messageCount, 2880);
    assert.ok(rec.chunks.count >= 2);
    assert.deepEqual(Object.keys(rec.chunks.by), ['lz4']);
    const imu = rec.topics.find((t) => t.topic === '/imu');
    assert.equal(imu.type, 'sensor_msgs/Imu');
    assert.equal(imu.messageEncoding, 'ros1');
    assert.match(imu.metadata.md5sum, /^[0-9a-f]{32}$/);
    assert.equal(imu.metadata.callerid, '/rover_driver');
    for await (const m of rec.iterate({ topics: ['/cmd_vel'] })) {
      const v = rec.decoderFor('/cmd_vel').decode(m.data);
      assert.ok(v.linear.x > 1);
      break;
    }
    const hdr = await collect((async function* () { for await (const x of rec.iterate({ topics: ['/pose'] })) { yield rec.decoderFor('/pose').decode(x.data); return; } }()));
    assert.equal(hdr[0].header.seq, 0);
    assert.equal(hdr[0].header.frame_id, 'map');
  } finally { await rec.close(); }
});

test('protobuf and JSON channels decode from the schemas in the file', async () => {
  const rec = await open(S('demo-sensors.mcap'));
  try {
    assert.deepEqual(rec.topics.map((t) => [t.topic, t.messageEncoding, t.count]), [['/gps', 'protobuf', 150], ['/status', 'json', 60]]);
    const gps = rec.decoderFor('/gps');
    assert.equal(gps.kind, 'protobuf');
    for await (const m of rec.iterate({ topics: ['/gps'] })) { const v = gps.decode(m.data); assert.ok(Math.abs(v.latitude - 52.52) < 0.01); assert.equal(v.fix, 'FIX_3D'); break; }
    const st = rec.decoderFor('/status');
    assert.equal(st.kind, 'json');
    const all = [];
    for await (const m of rec.iterate({ topics: ['/status'] })) all.push(st.decode(m.data));
    assert.equal(all.length, 60);
    assert.deepEqual(all[37].errors, ['wheel slip left']);
  } finally { await rec.close(); }
});

test('bz2 bag (third-party fixture) and an MCAP file without chunks or summary', async () => {
  const bag = await open(FX('third-party/noetic-multitopic-bz2.bag'));
  try {
    assert.deepEqual(bag.topics.map((t) => [t.topic, t.count]), [['/chatter', 2], ['/numbers', 1]]);
    assert.deepEqual(Object.keys(bag.chunks.by), ['bz2']);
    const vals = [];
    for await (const m of bag.iterate({})) vals.push(bag.decoderFor(m.topic).decode(m.data));
    assert.deepEqual(vals.map((v) => v.data), ['hello', 42, 'world']);
  } finally { await bag.close(); }
  const ten = await open(FX('third-party/TenMessages.mcap'));
  try {
    assert.equal(ten.indexed, false);
    assert.equal(ten.messageCount, 10);
    assert.equal(ten.decoderFor('example').kind, 'raw');
  } finally { await ten.close(); }
});

test('unindexed and cut-off MCAP files are read in full with a plain warning', async () => {
  const u = await open(FX('unindexed.mcap'));
  try {
    assert.equal(u.indexed, false);
    assert.equal(u.messageCount, 2880);
    assert.ok(u.warnings.some((w) => /no summary section/.test(w)));
    const back = await collect(u.iterate({ topics: ['/scan'], reverse: true }));
    assert.equal(back.length, 300);
    assert.ok(back[0].logNs > back[1].logNs);
  } finally { await u.close(); }
  const c = await open(FX('cut-off.mcap'));
  try {
    assert.ok(c.messageCount > 1000 && c.messageCount < 2880);
    assert.ok(c.warnings.some((w) => /cut off/.test(w)));
  } finally { await c.close(); }
});

test('broken, empty, old, cut-off and wrong files give plain messages', async () => {
  const cases = [['broken.mcap', /could not be read/, 'error'], ['empty.mcap', /empty/, 'empty'], ['old-format.bag', /1\.2 format/, 'old'], ['not-a-bag.bag', /not an MCAP file or a ROS 1 bag/, 'notrec'], ['cut-off.bag', /cut off|reindex/, 'error']];
  for (const [f, re, kind] of cases) {
    await assert.rejects(open(FX(f)), (e) => { assert.match(e.message, re, f); assert.equal(e.kind, kind, f); assert.doesNotMatch(e.message, /\.\./); return true; });
  }
});

test('bufferSource gives the same summary as the file source', async () => {
  const a = await R.openRecording(R.bufferSource(fs.readFileSync(S('demo-rover-ros1.bag'))));
  const b = await open(S('demo-rover-ros1.bag'));
  assert.deepEqual(a.topics.map((t) => [t.topic, t.count, t.hz]), b.topics.map((t) => [t.topic, t.count, t.hz]));
  await a.close(); await b.close();
});

test('iterate by time range and reverse, in log time order', async () => {
  const rec = await open(S('demo-rover-ros2.mcap'));
  try {
    const s = rec.startNs + 10000000000n; const e = rec.startNs + 11000000000n;
    const ms = await collect(rec.iterate({ topics: ['/imu', '/cmd_vel'], startNs: s, endNs: e }));
    assert.ok(ms.length >= 59 && ms.length <= 61, String(ms.length));
    assert.ok(ms.every((m, i) => m.logNs >= s && m.logNs <= e && (i === 0 || m.logNs >= ms[i - 1].logNs)));
    const before = await collect(rec.iterate({ topics: ['/scan'], beforeNs: s, reverse: true }));
    assert.ok(before.length === 100 || before.length === 101, String(before.length));
    assert.ok(before.every((m) => m.logNs < s));
  } finally { await rec.close(); }
});

test('view: summary JSON for the webview has string times, decoders and schema text', async () => {
  const rec = await open(S('demo-rover-ros2.mcap'));
  try {
    const v = Vw.infoView(rec, 'demo-rover-ros2.mcap');
    JSON.stringify(v);
    assert.equal(typeof v.startNs, 'string');
    assert.match(v.startIso, /^2026-11-02 09:30:00\.\d{9} UTC$/);
    assert.equal(v.topics.find((t) => t.topic === '/imu').decoder, 'cdr');
    const imu = v.schemas.find((s) => s.name === 'sensor_msgs/msg/Imu');
    assert.match(imu.text, /geometry_msgs\/Vector3 linear_acceleration/);
    assert.match(imu.text, /MSG: builtin_interfaces\/Time/);
    assert.deepEqual(imu.topics, ['/imu']);
    assert.equal(v.chunks.count, 4);
    assert.ok(v.chunks.ratio > 2);
  } finally { await rec.close(); }
});

test('view: pages forward from a time, the next page skips shown messages, the page before ends where the page started', async () => {
  const rec = await open(S('demo-rover-ros1.bag'));
  try {
    const p1 = await Vw.page(rec, { topic: '/cmd_vel', fromNs: rec.startNs.toString(), count: 50 });
    assert.equal(p1.items.length, 50);
    assert.equal(p1.more, true);
    assert.equal(p1.atStart, true);
    assert.ok(p1.items[0].value.linear);
    const last = p1.items[49].ns;
    const p2 = await Vw.page(rec, { topic: '/cmd_vel', fromNs: last, skip: 1, count: 50 });
    assert.ok(BigInt(p2.items[0].ns) > BigInt(last));
    const back = await Vw.page(rec, { topic: '/cmd_vel', fromNs: p2.items[0].ns, back: true, count: 50 });
    assert.deepEqual(back.items.map((i) => i.ns), p1.items.map((i) => i.ns));
    const mid = rec.startNs + 15000000000n;
    const p3 = await Vw.page(rec, { topic: '/scan', fromNs: mid.toString(), count: 5 });
    assert.ok(Math.abs(p3.items[0].rel - 15) < 0.11);
    assert.equal(p3.items[0].value.ranges.length, 65, 'long arrays are cut to 64 items and a marker');
    assert.equal(p3.items[0].value.ranges[64].__more, 57);
    const end = await Vw.page(rec, { topic: '/scan', fromNs: (rec.endNs + 1n).toString(), count: 5 });
    assert.equal(end.items.length, 0);
  } finally { await rec.close(); }
});

test('view: fields and plot of one number field; min/max decimation keeps the extremes', async () => {
  const rec = await open(S('demo-rover-ros2.mcap'));
  try {
    const f = await Vw.fieldsOf(rec, '/pose');
    assert.ok(f.paths.includes('pose.position.x'));
    assert.ok(f.paths.includes('header.stamp'));
    const p = await Vw.plotSeries(rec, '/pose', 'pose.position.x');
    assert.equal(p.total, 750);
    assert.ok(p.max > 2.9 && p.max <= 3 && p.min < -2.9 && p.min >= -3);
    const small = await Vw.plotSeries(rec, '/pose', 'pose.position.x', { maxPoints: 100 });
    assert.ok(small.xs.length <= 100);
    assert.equal(Math.max(...small.ys), p.max);
    assert.equal(Math.min(...small.ys), p.min);
    const none = await Vw.plotSeries(rec, '/pose', 'pose.nothing');
    assert.equal(none.total, 0);
    assert.equal(none.missing, 750);
  } finally { await rec.close(); }
});

test('fields: numeric paths, number at a path, flatten for CSV, JSON values', () => {
  const msg = { header: { stamp: { sec: 5, nsec: 250000000 }, frame_id: 'a' }, v: { x: 1.5, y: -2 }, ok: true, big: 12n, data: new Uint8Array(5000), ranges: new Float32Array([1, 2, 3]), list: [{ a: 1 }, { a: 2 }] };
  const paths = Fd.numericPaths(msg);
  assert.deepEqual(paths.slice(0, 6), ['header.stamp', 'v.x', 'v.y', 'ok', 'big', 'data[0]']);
  assert.equal(Fd.numberAt(msg, 'header.stamp'), 5.25);
  assert.equal(Fd.numberAt(msg, 'ranges[2]'), 3);
  assert.equal(Fd.numberAt(msg, 'list[1].a'), 2);
  assert.equal(Fd.numberAt(msg, 'ok'), 1);
  assert.equal(Fd.numberAt(msg, 'header.frame_id'), null);
  const flat = Fd.flatten(msg);
  assert.equal(flat['header.stamp'], '5.250000000');
  assert.equal(flat['ranges[1]'], 2);
  assert.equal(flat['list[0].a'], 1);
  assert.equal(flat.data, 'uint8[5000]');
  assert.equal(flat.big, 12);
  const j = Fd.jsonValue(msg);
  assert.deepEqual(j.data, { omitted: 'uint8[5000]' });
  assert.deepEqual(j.ranges, [1, 2, 3]);
  assert.equal(j.big, 12);
  assert.equal(Fd.csvCell('a,"b"'), '"a,""b"""');
});

test('decode: toPlain cuts arrays and strings, bigint to number or string; unknown encodings are raw with a reason', () => {
  const p = D.toPlain({ a: new Float64Array(100), s: 'x'.repeat(3000), b: 2n ** 70n, c: 7n });
  assert.equal(p.a.length, 65);
  assert.equal(p.a[64].__type, 'float64');
  assert.match(p.s, /3000 characters/);
  assert.equal(p.b, (2n ** 70n).toString());
  assert.equal(p.c, 7);
  assert.equal(D.makeDecoder({ messageEncoding: 'flatbuffer', schemaEncoding: 'flatbuffer', schemaName: 'x', schemaData: new Uint8Array(4) }).kind, 'raw');
  assert.match(D.makeDecoder({ messageEncoding: 'cdr', schemaEncoding: 'ros2msg', schemaName: 'pkg/msg/X', schemaData: new Uint8Array(0) }).error, /no schema text/);
  assert.match(D.makeDecoder({ messageEncoding: 'ros1', schemaEncoding: 'ros1msg', schemaName: 'x', schemaData: 'int32 a\nfoo/Bar b' }).error, /could not be read/);
  assert.match(D.hexPreview(new Uint8Array([1, 2, 255])), /^01 02 ff$/);
});

test('Pro core export: CSV of the IMU with one column per field and the log time; JSON and JSON Lines', async () => {
  const rec = await open(S('demo-rover-ros2.mcap'));
  try {
    const { r, s } = await exportText(rec, { topic: '/imu', format: 'csv' });
    const lines = s.trim().split('\n');
    assert.equal(r.rows, 1500);
    assert.equal(lines.length, 1501);
    const head = lines[0].split(',');
    assert.deepEqual(head.slice(0, 4), ['log_time', 'publish_time', 'header.stamp', 'header.frame_id']);
    assert.ok(head.includes('linear_acceleration.z') && head.includes('orientation_covariance[8]'));
    const row = lines[1].split(',');
    assert.match(row[0], /^1793611800\.\d{9}$/);
    assert.ok(Math.abs(Number(row[head.indexOf('linear_acceleration.z')]) - 9.81) < 0.1);
    const j = await exportText(rec, { topic: '/scan', format: 'json' });
    const arr = JSON.parse(j.s);
    assert.equal(arr.length, 300);
    assert.equal(arr[0].topic, '/scan');
    assert.equal(arr[0].message.ranges.length, 121);
    const l = await exportText(rec, { topic: '/battery/voltage', format: 'jsonl' });
    const rows = l.s.trim().split('\n').map((x) => JSON.parse(x));
    assert.equal(rows.length, 30);
    assert.ok(rows[0].message.data > 12.5);
    await assert.rejects(exportTopic(rec, { topic: '/nope', format: 'csv', write: async () => {} }), /not in this recording/);
  } finally { await rec.close(); }
});

test('Pro core export: a bag topic to CSV has no publish_time column; protobuf to CSV keeps enum names', async () => {
  const bag = await open(S('demo-rover-ros1.bag'));
  const { s } = await exportText(bag, { topic: '/cmd_vel', format: 'csv' });
  assert.equal(s.split('\n')[0], 'log_time,linear.x,linear.y,linear.z,angular.x,angular.y,angular.z');
  await bag.close();
  const pb = await open(S('demo-sensors.mcap'));
  const g = await exportText(pb, { topic: '/gps', format: 'csv' });
  assert.match(g.s.split('\n')[0], /latitude,longitude,altitude,satellites,fix/);
  assert.match(g.s.split('\n')[1], /,FIX_3D$/);
  await pb.close();
});

test('Pro core trim: 5 s of 2 topics of the bag become an indexed MCAP (ros1 profile) that reads back exactly', async () => {
  const bag = await open(S('demo-rover-ros1.bag'));
  try {
    const s = bag.startNs + 5000000000n; const e = bag.startNs + 10000000000n;
    const { r, bytes } = await trimBytes(bag, { topics: ['/imu', '/pose'], startNs: s, endNs: e });
    assert.equal(r.topics, 2);
    const want = await collect(bag.iterate({ topics: ['/imu', '/pose'], startNs: s, endNs: e }));
    assert.equal(r.messages, want.length);
    const out = await R.openRecording(R.bufferSource(bytes));
    assert.equal(out.indexed, true);
    assert.equal(out.profile, 'ros1');
    assert.equal(out.library, 'Zovo MCAP Viewer');
    assert.deepEqual(Object.keys(out.chunks.by), ['lz4']);
    assert.deepEqual(out.topics.map((t) => [t.topic, t.type, t.messageEncoding, t.schemaEncoding]), [['/imu', 'sensor_msgs/Imu', 'ros1', 'ros1msg'], ['/pose', 'geometry_msgs/PoseStamped', 'ros1', 'ros1msg']]);
    const got = await collect(out.iterate({}));
    assert.equal(got.length, want.length);
    for (let i = 0; i < got.length; i++) { assert.equal(got[i].logNs, want[i].logNs); assert.deepEqual(Buffer.from(got[i].data), Buffer.from(want[i].data)); }
    assert.ok(got.every((m) => m.logNs >= s && m.logNs <= e));
    const imu = out.decoderFor('/imu').decode(got.find((m) => m.topic === '/imu').data);
    assert.equal(imu.header.frame_id, 'imu_link');
    assert.match(out.topics[0].metadata.md5sum, /^[0-9a-f]{32}$/);
  } finally { await bag.close(); }
});

test('Pro core trim: all topics of the MCAP sample keep metadata and the attachment in range; no compression on request', async () => {
  const rec = await open(S('demo-rover-ros2.mcap'));
  try {
    const { r, bytes } = await trimBytes(rec, { topics: [], startNs: null, endNs: rec.startNs + 3000000000n, compression: 'none' });
    const out = await R.openRecording(R.bufferSource(bytes));
    assert.equal(out.messageCount, r.messages);
    assert.equal(out.topics.length, 5);
    assert.deepEqual(Object.keys(out.chunks.by), ['none']);
    assert.deepEqual(out.metadata, rec.metadata);
    assert.deepEqual(out.attachments.map((a) => a.name), ['calibration/imu.yaml']);
    const late = await trimBytes(rec, { topics: ['/battery/voltage'], startNs: rec.startNs + 20000000000n, endNs: null });
    const o2 = await R.openRecording(R.bufferSource(late.bytes));
    assert.equal(o2.attachments.length, 0);
    assert.equal(o2.messageCount, 10);
  } finally { await rec.close(); }
});

test('Pro core compare: counts, rates, types, only-in-A and only-in-B; Markdown and CSV', async () => {
  const a = await open(S('demo-rover-ros2.mcap'));
  const { bytes } = await trimBytes(a, { topics: ['/imu', '/scan', '/pose'], startNs: null, endNs: a.startNs + 9999000000n });
  const b = await R.openRecording(R.bufferSource(bytes));
  const bag = await open(S('demo-rover-ros1.bag'));
  try {
    const r = C.compareRecordings(a, b);
    const row = Object.fromEntries(r.rows.map((x) => [x.topic, x]));
    assert.equal(row['/cmd_vel'].status, 'only in A');
    assert.equal(row['/battery/voltage'].status, 'only in A');
    assert.equal(row['/imu'].status, 'count differs');
    assert.equal(row['/imu'].countA, 1500);
    assert.equal(row['/imu'].countB, 500);
    assert.ok(Math.abs(row['/imu'].countPct + 66.67) < 0.01);
    assert.deepEqual(r.counts, { same: 0, onlyA: 2, onlyB: 0, changed: 3 });
    const md = C.toMarkdown(r, 'a.mcap', 'b.mcap');
    assert.match(md, /\| \/imu \| count differs \| sensor_msgs\/msg\/Imu \| sensor_msgs\/msg\/Imu \| 1500 \| 500 \| -66\.7 % \| 50\.00 \|/);
    const csv = C.toCsv(r);
    assert.match(csv.split('\n')[0], /^topic,status,type_a,type_b,count_a,count_b,count_diff,rate_a_hz,rate_b_hz$/);
    const r2 = C.compareRecordings(a, bag);
    assert.equal(Object.fromEntries(r2.rows.map((x) => [x.topic, x.status]))['/imu'], 'type differs');
    const same = C.compareRecordings(a, a);
    assert.equal(same.counts.same, 5);
  } finally { await a.close(); await b.close(); await bag.close(); }
});
