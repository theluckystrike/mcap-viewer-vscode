'use strict';
// Writes our own sample recordings (samples/) and the unit-test fixtures (test/fixtures/). A small rover drives a
// figure eight in a 10 m x 6 m room for 30 seconds: IMU, pose, velocity command, laser scan and battery voltage.
//   samples/demo-rover-ros2.mcap   ROS 2 profile, CDR messages, ros2msg schemas, zstd chunks, metadata, 1 attachment
//   samples/demo-rover-ros1.bag    ROS 1 bag 2.0, the same drive with ROS 1 types, lz4 chunks
//   samples/demo-sensors.mcap      protobuf GPS fixes and JSON status messages, lz4 chunks
// Run: node scripts/make-samples.js (needs the packages of scripts/vendor for the ROS 1 md5 sums, and Node 22.15+ for zstd).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const V = require('../lib/vendor.js');
const { md5 } = require('./vendor/node_modules/@foxglove/rosmsg');
const { writeBag } = require('./bagwrite');

const root = path.join(__dirname, '..');
const SEP = '================================================================================';
const T0 = BigInt(Date.UTC(2026, 10, 2, 9, 30, 0)) * 1000000n; // 2 Nov 2026 09:30 UTC
const DUR = 30;

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const noise = (a) => (rnd() - 0.5) * 2 * a;

// ---------- definitions ----------
const ROS1 = {
  'std_msgs/Header': 'uint32 seq\ntime stamp\nstring frame_id',
  'geometry_msgs/Vector3': 'float64 x\nfloat64 y\nfloat64 z',
  'geometry_msgs/Quaternion': 'float64 x\nfloat64 y\nfloat64 z\nfloat64 w',
  'geometry_msgs/Point': 'float64 x\nfloat64 y\nfloat64 z',
  'geometry_msgs/Pose': 'geometry_msgs/Point position\ngeometry_msgs/Quaternion orientation',
  'sensor_msgs/Imu': 'std_msgs/Header header\ngeometry_msgs/Quaternion orientation\nfloat64[9] orientation_covariance\ngeometry_msgs/Vector3 angular_velocity\nfloat64[9] angular_velocity_covariance\ngeometry_msgs/Vector3 linear_acceleration\nfloat64[9] linear_acceleration_covariance',
  'geometry_msgs/PoseStamped': 'std_msgs/Header header\ngeometry_msgs/Pose pose',
  'geometry_msgs/Twist': 'geometry_msgs/Vector3 linear\ngeometry_msgs/Vector3 angular',
  'sensor_msgs/LaserScan': 'std_msgs/Header header\nfloat32 angle_min\nfloat32 angle_max\nfloat32 angle_increment\nfloat32 time_increment\nfloat32 scan_time\nfloat32 range_min\nfloat32 range_max\nfloat32[] ranges\nfloat32[] intensities',
  'std_msgs/Float32': 'float32 data',
};
const ROS2 = {
  'builtin_interfaces/Time': 'int32 sec\nuint32 nanosec',
  'std_msgs/Header': 'builtin_interfaces/Time stamp\nstring frame_id',
  'geometry_msgs/Vector3': ROS1['geometry_msgs/Vector3'],
  'geometry_msgs/Quaternion': 'float64 x 0\nfloat64 y 0\nfloat64 z 0\nfloat64 w 1',
  'geometry_msgs/Point': ROS1['geometry_msgs/Point'],
  'geometry_msgs/Pose': ROS1['geometry_msgs/Pose'],
  'sensor_msgs/Imu': ROS1['sensor_msgs/Imu'],
  'geometry_msgs/PoseStamped': ROS1['geometry_msgs/PoseStamped'],
  'geometry_msgs/Twist': ROS1['geometry_msgs/Twist'],
  'sensor_msgs/LaserScan': ROS1['sensor_msgs/LaserScan'],
  'std_msgs/Float32': ROS1['std_msgs/Float32'],
};
const DEPS = {
  'sensor_msgs/Imu': ['std_msgs/Header', 'geometry_msgs/Quaternion', 'geometry_msgs/Vector3'],
  'geometry_msgs/PoseStamped': ['std_msgs/Header', 'geometry_msgs/Pose', 'geometry_msgs/Point', 'geometry_msgs/Quaternion'],
  'geometry_msgs/Twist': ['geometry_msgs/Vector3'],
  'sensor_msgs/LaserScan': ['std_msgs/Header'],
  'std_msgs/Float32': [],
};
function fullDef(type, ros2) {
  const lib = ros2 ? ROS2 : ROS1;
  let deps = DEPS[type];
  if (ros2 && deps.includes('std_msgs/Header')) deps = [...deps, 'builtin_interfaces/Time'];
  return [lib[type], ...deps.map((d) => `${SEP}\nMSG: ${d}\n${lib[d]}`)].join('\n');
}
const ros2Name = (t) => t.replace('/', '/msg/');

// ---------- the drive ----------
const W = (2 * Math.PI) / 15;
function state(t) {
  const x = 3 * Math.sin(W * t); const y = 1.5 * Math.sin(2 * W * t);
  const dx = 3 * W * Math.cos(W * t); const dy = 3 * W * Math.cos(2 * W * t);
  const ddx = -3 * W * W * Math.sin(W * t); const ddy = -6 * W * W * Math.sin(2 * W * t);
  const yaw = Math.atan2(dy, dx);
  const v = Math.hypot(dx, dy);
  const yawRate = (dx * ddy - dy * ddx) / (dx * dx + dy * dy);
  const along = (dx * ddx + dy * ddy) / v;
  return { x, y, yaw, v, yawRate, ax: along, ay: v * yawRate };
}
const quat = (yaw) => ({ x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) });
function scanRanges(s, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = s.yaw - Math.PI / 2 + (Math.PI * i) / (n - 1);
    const cx = Math.cos(a); const cy = Math.sin(a);
    let d = Infinity;
    if (cx > 1e-9) d = Math.min(d, (5 - s.x) / cx); if (cx < -1e-9) d = Math.min(d, (-5 - s.x) / cx);
    if (cy > 1e-9) d = Math.min(d, (3 - s.y) / cy); if (cy < -1e-9) d = Math.min(d, (-3 - s.y) / cy);
    // a round pillar at (0, 2.4), radius 0.3
    const px = 0 - s.x; const py = 2.4 - s.y; const b = px * cx + py * cy; const c = px * px + py * py - 0.09; const disc = b * b - c;
    if (disc > 0 && b - Math.sqrt(disc) > 0) d = Math.min(d, b - Math.sqrt(disc));
    out[i] = Math.min(8, d + noise(0.01));
  }
  return out;
}

/** Events in time order: [{ topic, type, tNs, msg(ros2) }] */
function drive() {
  const ev = [];
  const add = (topic, type, hz, fn) => { for (let k = 0; k < DUR * hz; k++) { const t = k / hz; ev.push({ topic, type, t, tNs: T0 + BigInt(Math.round(t * 1e9)) + BigInt(Math.floor(rnd() * 200000)), fn, k }); } };
  add('/imu', 'sensor_msgs/Imu', 50, (s, k, ros2, stamp) => ({
    header: hdr(k, stamp, 'imu_link', ros2), orientation: quat(s.yaw), orientation_covariance: cov(0.001),
    angular_velocity: { x: noise(0.01), y: noise(0.01), z: s.yawRate + noise(0.02) }, angular_velocity_covariance: cov(0.0004),
    linear_acceleration: { x: s.ax + noise(0.08), y: s.ay + noise(0.08), z: 9.81 + noise(0.05) }, linear_acceleration_covariance: cov(0.01),
  }));
  add('/pose', 'geometry_msgs/PoseStamped', 25, (s, k, ros2, stamp) => ({ header: hdr(k, stamp, 'map', ros2), pose: { position: { x: s.x, y: s.y, z: 0 }, orientation: quat(s.yaw) } }));
  add('/cmd_vel', 'geometry_msgs/Twist', 10, (s) => ({ linear: { x: Number(s.v.toFixed(3)), y: 0, z: 0 }, angular: { x: 0, y: 0, z: Number(s.yawRate.toFixed(3)) } }));
  add('/scan', 'sensor_msgs/LaserScan', 10, (s, k, ros2, stamp) => {
    const n = 121;
    const ranges = scanRanges(s, n);
    return { header: hdr(k, stamp, 'laser', ros2), angle_min: -Math.PI / 2, angle_max: Math.PI / 2, angle_increment: Math.PI / (n - 1), time_increment: 0, scan_time: 0.1, range_min: 0.05, range_max: 8, ranges, intensities: new Float32Array(n).map(() => 100 + Math.round(rnd() * 20)) };
  });
  add('/battery/voltage', 'std_msgs/Float32', 1, (s, k) => ({ data: 12.6 - 0.01 * k + noise(0.005) }));
  ev.sort((a, b) => (a.tNs < b.tNs ? -1 : a.tNs > b.tNs ? 1 : 0));
  return ev;
}
function hdr(seq, ns, frame, ros2) {
  const sec = Number(ns / 1000000000n); const nsec = Number(ns % 1000000000n);
  return ros2 ? { stamp: { sec, nanosec: nsec }, frame_id: frame } : { seq, stamp: { sec, nsec }, frame_id: frame };
}
function cov(d) { const c = new Array(9).fill(0); c[0] = d; c[4] = d; c[8] = d; return c; }

function memWritable() {
  const parts = []; let pos = 0n;
  return { parts, position: () => pos, write: async (b) => { parts.push(Buffer.from(b)); pos += BigInt(b.byteLength); }, bytes: () => Buffer.concat(parts) };
}
const zstd = (data) => ({ compression: 'zstd', compressedData: zlib.zstdCompressSync(data) });
const lz4 = (data) => ({ compression: 'lz4', compressedData: V.lz4Compress(data) });

async function writeRos2Mcap(file, o = {}) {
  const w = memWritable();
  const mw = new V.McapWriter({ writable: w, compressChunk: o.compress === undefined ? zstd : o.compress, chunkSize: o.chunkSize || 256 * 1024, ...(o.writer || {}) });
  await mw.start({ profile: 'ros2', library: 'zovo make-samples' });
  const chans = new Map(); const writers = new Map();
  const events = drive();
  for (const e of events) {
    if (!chans.has(e.topic)) {
      const sid = await mw.registerSchema({ name: ros2Name(e.type), encoding: 'ros2msg', data: Buffer.from(fullDef(e.type, true)) });
      chans.set(e.topic, await mw.registerChannel({ topic: e.topic, messageEncoding: 'cdr', schemaId: sid, metadata: new Map([['offered_qos_profiles', '']]) }));
      writers.set(e.topic, new V.CdrWriter(V.parseRosMsg(fullDef(e.type, true), { ros2: true })));
    }
  }
  let seq = 0;
  for (const e of events) {
    const msg = e.fn(state(e.t), e.k, true, e.tNs);
    await mw.addMessage({ channelId: chans.get(e.topic), sequence: seq++, logTime: e.tNs + 150000n, publishTime: e.tNs, data: writers.get(e.topic).writeMessage(msg) });
  }
  if (!o.bare) {
    await mw.addMetadata({ name: 'rover', metadata: new Map([['name', 'zovo-demo-rover'], ['site', 'test room 10 m x 6 m'], ['driver', 'figure eight, 15 s per loop']]) });
    await mw.addAttachment({ name: 'calibration/imu.yaml', logTime: T0 + 1000000000n, createTime: T0, mediaType: 'application/yaml', data: Buffer.from('imu_link:\n  gyro_bias: [0.001, -0.002, 0.0005]\n  accel_scale: [1.0, 1.0, 0.998]\n') });
  }
  await mw.end();
  const bytes = w.bytes();
  if (file) fs.writeFileSync(file, bytes);
  return bytes;
}

function writeRos1Bag(file, o = {}) {
  const events = drive();
  const conns = []; const ids = new Map(); const writers = new Map();
  for (const e of events) {
    if (ids.has(e.topic)) continue;
    const def = fullDef(e.type, false);
    const id = conns.length;
    conns.push({ id, topic: e.topic, type: e.type, md5sum: md5(V.parseRosMsg(def)), definition: def, callerid: '/rover_driver' });
    ids.set(e.topic, id); writers.set(e.topic, new V.Ros1Writer(V.parseRosMsg(def)));
  }
  const msgs = events.map((e) => ({ conn: ids.get(e.topic), time: { sec: Number(e.tNs / 1000000000n), nsec: Number(e.tNs % 1000000000n) }, data: writers.get(e.topic).writeMessage(e.fn(state(e.t), e.k, false, e.tNs)) }));
  const bytes = writeBag(conns, msgs, { compression: o.compression || 'lz4', chunkSize: o.chunkSize || 128 * 1024, truncateAt: o.truncateAt });
  if (file) fs.writeFileSync(file, bytes);
  return bytes;
}

async function writeSensorsMcap(file) {
  const root = V.protobuf.Root.fromJSON({
    nested: { zovo: { nested: { demo: { nested: {
      GpsFix: { fields: { time_ns: { type: 'int64', id: 1 }, latitude: { type: 'double', id: 2 }, longitude: { type: 'double', id: 3 }, altitude: { type: 'float', id: 4 }, satellites: { type: 'uint32', id: 5 }, fix: { type: 'FixType', id: 6 } } },
      FixType: { values: { NO_FIX: 0, FIX_2D: 1, FIX_3D: 2, RTK: 3 } },
    } } } } },
  });
  const desc = root.toDescriptor('proto3');
  const set = V.FileDescriptorSet.encode(desc).finish();
  const Gps = root.lookupType('zovo.demo.GpsFix');
  const w = memWritable();
  const mw = new V.McapWriter({ writable: w, compressChunk: lz4, chunkSize: 64 * 1024 });
  await mw.start({ profile: '', library: 'zovo make-samples' });
  const gpsSchema = await mw.registerSchema({ name: 'zovo.demo.GpsFix', encoding: 'protobuf', data: set });
  const gps = await mw.registerChannel({ topic: '/gps', messageEncoding: 'protobuf', schemaId: gpsSchema, metadata: new Map() });
  const statusSchema = await mw.registerSchema({ name: 'RoverStatus', encoding: 'jsonschema', data: Buffer.from(JSON.stringify({ type: 'object', properties: { mode: { type: 'string' }, battery_pct: { type: 'number' }, temperature_c: { type: 'number' }, motors_on: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } } } })) });
  const status = await mw.registerChannel({ topic: '/status', messageEncoding: 'json', schemaId: statusSchema, metadata: new Map() });
  const ev = [];
  for (let k = 0; k < DUR * 5; k++) ev.push({ ch: gps, t: T0 + BigInt(k) * 200000000n, k });
  for (let k = 0; k < DUR * 2; k++) ev.push({ ch: status, t: T0 + BigInt(k) * 500000000n + 1000n, k });
  ev.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  let seq = 0;
  for (const e of ev) {
    const s = state(Number(e.t - T0) / 1e9);
    let data;
    if (e.ch === gps) data = Gps.encode(Gps.create({ time_ns: Number(e.t), latitude: 52.5200 + s.y / 111320, longitude: 13.4050 + s.x / 67800, altitude: 34.2 + noise(0.3), satellites: 9 + Math.floor(rnd() * 4), fix: e.k < 10 ? 2 : 3 })).finish();
    else data = Buffer.from(JSON.stringify({ mode: e.k < 4 ? 'starting' : 'driving', battery_pct: Number((98 - e.k * 0.05).toFixed(2)), temperature_c: Number((31 + e.k * 0.04 + noise(0.2)).toFixed(2)), motors_on: e.k >= 2, errors: e.k === 37 ? ['wheel slip left'] : [] }));
    await mw.addMessage({ channelId: e.ch, sequence: seq++, logTime: e.t, publishTime: e.t, data });
  }
  await mw.end();
  fs.writeFileSync(file, w.bytes());
}

async function main() {
  const S = path.join(root, 'samples'); const F = path.join(root, 'test', 'fixtures');
  fs.mkdirSync(S, { recursive: true }); fs.mkdirSync(F, { recursive: true });
  const ros2 = await writeRos2Mcap(path.join(S, 'demo-rover-ros2.mcap'));
  writeRos1Bag(path.join(S, 'demo-rover-ros1.bag'));
  await writeSensorsMcap(path.join(S, 'demo-sensors.mcap'));
  // fixtures
  await writeRos2Mcap(path.join(F, 'unindexed.mcap'), { bare: true, writer: { useStatistics: false, useSummaryOffsets: false, useChunkIndex: false, useMessageIndex: false, repeatSchemas: false, repeatChannels: false, useAttachmentIndex: false, useMetadataIndex: false } });
  fs.writeFileSync(path.join(F, 'cut-off.mcap'), ros2.subarray(0, Math.floor(ros2.length * 0.6)));
  fs.writeFileSync(path.join(F, 'cut-off.bag'), writeRos1Bag(null, { compression: 'none', truncateAt: 150000 }));
  const bad = Buffer.alloc(600, 0x41); Buffer.from([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]).copy(bad, 0);
  fs.writeFileSync(path.join(F, 'broken.mcap'), bad);
  fs.writeFileSync(path.join(F, 'not-a-bag.bag'), 'This is a text file with a .bag name.\n');
  fs.writeFileSync(path.join(F, 'empty.mcap'), Buffer.alloc(0));
  fs.writeFileSync(path.join(F, 'old-format.bag'), Buffer.concat([Buffer.from('#ROSBAG V1.2\n'), Buffer.alloc(200)]));
  for (const d of [S, F]) for (const f of fs.readdirSync(d)) { const st = fs.statSync(path.join(d, f)); if (st.isFile()) console.log(`${path.relative(root, path.join(d, f))} ${st.size}`); }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { writeRos2Mcap, writeRos1Bag, fullDef, drive };
