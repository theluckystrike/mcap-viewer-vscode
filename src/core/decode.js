'use strict';
// Message decoders from the schema stored in the recording itself: ROS 1 (ros1msg), ROS 2 CDR (ros2msg and ros2idl),
// JSON and protobuf (a FileDescriptorSet in the schema). Anything else is shown as raw bytes. No vscode import.
const V = require('../../lib/vendor.js');

const utf8 = (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('utf8');

/**
 * s: { messageEncoding, schemaEncoding, schemaName, schemaData (Uint8Array or string) }
 * Returns { kind, decode(data) } or { kind: 'raw', error } when the encoding has no decoder here.
 */
function makeDecoder(s) {
  const me = String(s.messageEncoding || '').toLowerCase();
  const se = String(s.schemaEncoding || '').toLowerCase();
  const text = () => (typeof s.schemaData === 'string' ? s.schemaData : utf8(s.schemaData || new Uint8Array()));
  const empty = typeof s.schemaData === 'string' ? !s.schemaData.trim() : !s.schemaData || !s.schemaData.byteLength;
  if ((me === 'ros1' || me === 'cdr' || me === 'protobuf') && empty) return { kind: 'raw', error: `The file holds no schema text for ${s.schemaName || 'this channel'}, so the bytes are shown.` };
  try {
    if (me === 'ros1') {
      const defs = V.parseRosMsg(text());
      const r = new V.Ros1Reader(defs);
      return { kind: 'ros1', decode: (d) => r.readMessage(d) };
    }
    if (me === 'cdr') {
      let defs;
      if (se === 'ros2idl') defs = V.parseRos2idl(text());
      else if (se === 'ros2msg' || se === '') defs = V.parseRosMsg(text(), { ros2: true });
      else return { kind: 'raw', error: `CDR messages with a ${s.schemaEncoding} schema are shown as bytes.` };
      const r = new V.CdrReader(defs);
      return { kind: 'cdr', decode: (d) => r.readMessage(d) };
    }
    if (me === 'json') {
      return { kind: 'json', decode: (d) => JSON.parse(utf8(d)) };
    }
    if (me === 'protobuf') {
      if (se !== 'protobuf' || !s.schemaData || !s.schemaData.byteLength) return { kind: 'raw', error: 'This protobuf channel has no FileDescriptorSet schema.' };
      const set = V.FileDescriptorSet.decode(s.schemaData);
      const root = V.protobuf.Root.fromDescriptor(set);
      const type = root.lookupType(String(s.schemaName || '').replace(/^\./, ''));
      return {
        kind: 'protobuf',
        decode: (d) => type.toObject(type.decode(d), { longs: Number, enums: String, bytes: Uint8Array, defaults: true, arrays: true }),
      };
    }
  } catch (e) {
    return { kind: 'raw', error: `The ${s.schemaEncoding || s.messageEncoding} schema "${s.schemaName || ''}" could not be read: ${(e && e.message) || e}` };
  }
  return { kind: 'raw', error: me ? `No decoder for the ${s.messageEncoding} message encoding; the bytes are shown.` : 'This channel has no message encoding; the bytes are shown.' };
}

const isTyped = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView);
const typeName = (v) => (v && v.constructor && v.constructor.name ? v.constructor.name.replace(/Array$/, '').toLowerCase() : 'value');

/**
 * A JSON-safe copy of a decoded message for the webview: bigint as number (string when not safe), long arrays cut
 * to `maxArray` items with a { __more } marker, long strings cut, Time objects kept as { sec, nsec }.
 */
function toPlain(v, o = {}, depth = 0) {
  const maxArray = o.maxArray || 64;
  const maxString = o.maxString || 2000;
  if (v === null || v === undefined) return v === undefined ? null : v;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'string') return v.length > maxString ? `${v.slice(0, maxString)}... (${v.length} characters)` : v;
  if (typeof v === 'boolean') return v;
  if (depth > 32) return '...';
  if (isTyped(v)) {
    const n = v.length;
    const head = Array.from(v.subarray(0, Math.min(n, maxArray)), (x) => (typeof x === 'bigint' ? Number(x) : x));
    if (n > maxArray) head.push({ __more: n - maxArray, __type: typeName(v), __length: n });
    return head;
  }
  if (Array.isArray(v)) {
    const out = v.slice(0, maxArray).map((x) => toPlain(x, o, depth + 1));
    if (v.length > maxArray) out.push({ __more: v.length - maxArray, __length: v.length });
    return out;
  }
  if (v instanceof Map) return toPlain(Object.fromEntries(v), o, depth);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = toPlain(v[k], o, depth + 1);
    return out;
  }
  return String(v);
}

/** First bytes as hex for channels without a decoder. */
function hexPreview(d, n = 256) {
  const b = d.subarray(0, n);
  const rows = [];
  for (let i = 0; i < b.length; i += 16) rows.push(Array.from(b.subarray(i, i + 16), (x) => x.toString(16).padStart(2, '0')).join(' '));
  return rows.join('\n') + (d.length > n ? `\n... ${d.length - n} more bytes` : '');
}

module.exports = { makeDecoder, toPlain, hexPreview, isTyped, typeName, utf8 };
