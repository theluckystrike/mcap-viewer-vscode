'use strict';
// Field paths of decoded messages: numeric leaves for the plot, flat columns for the CSV export, JSON-ready values
// for the JSON export. No vscode import.
const { isTyped, typeName } = require('./decode');

const SPREAD_MAX = 64; // arrays up to this length become one column per item in CSV
const JSON_ARRAY_MAX = 4096; // longer arrays are written as { omitted: "uint8[N]" } in JSON and CSV

const isTime = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 && 'sec' in v && ('nsec' in v || 'nanosec' in v);
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

/** Numeric leaf paths of one message ("pose.position.x", "ranges[3]", "header.stamp"), arrays up to `maxIndex` items. */
function numericPaths(msg, maxIndex = 16) {
  const out = [];
  const walk = (v, p, depth) => {
    if (depth > 12 || out.length > 500) return;
    if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') { if (p) out.push(p); return; }
    if (isTime(v)) { out.push(p); return; }
    if (isTyped(v) || Array.isArray(v)) {
      const n = Math.min(v.length, maxIndex);
      for (let i = 0; i < n; i++) walk(v[i], `${p}[${i}]`, depth + 1);
      return;
    }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], p ? `${p}.${k}` : k, depth + 1);
  };
  walk(msg, '', 0);
  return out;
}

/** Splits "a.b[2].c" into ['a', 'b', 2, 'c']. */
function splitPath(p) {
  const parts = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(p))) parts.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  return parts;
}

/** The number at a path (Time as seconds, boolean as 0/1), or null. */
function numberAt(msg, path) {
  let v = msg;
  for (const k of splitPath(path)) { if (v === null || v === undefined) return null; v = v[k]; }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isTime(v)) return Number(v.sec) + Number(v.nsec !== undefined ? v.nsec : v.nanosec) / 1e9;
  return null;
}

/** A JSON-ready copy: bigint as number (string when not exact), long arrays as { omitted }. */
function jsonValue(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v !== 'object') return v;
  if (depth > 40) return null;
  if (isTyped(v)) {
    if (v.length > JSON_ARRAY_MAX) return { omitted: `${typeName(v)}[${v.length}]` };
    return Array.from(v, (x) => (typeof x === 'bigint' ? num(x) : x));
  }
  if (Array.isArray(v)) {
    if (v.length > JSON_ARRAY_MAX) return { omitted: `array[${v.length}]` };
    return v.map((x) => jsonValue(x, depth + 1));
  }
  if (v instanceof Map) return jsonValue(Object.fromEntries(v), depth);
  const o = {};
  for (const k of Object.keys(v)) o[k] = jsonValue(v[k], depth + 1);
  return o;
}

/** Flat columns of one message: { "pose.position.x": 1.5, "ranges[0]": ..., "data": "[...]" }. */
function flatten(msg) {
  const out = {};
  const walk = (v, p, depth) => {
    if (depth > 16) return;
    if (v === null || v === undefined) { out[p] = ''; return; }
    if (typeof v !== 'object') { out[p] = num(v); return; }
    if (isTime(v)) { out[p] = `${v.sec}.${String(v.nsec !== undefined ? v.nsec : v.nanosec).padStart(9, '0')}`; return; }
    if (isTyped(v) || Array.isArray(v)) {
      if (v.length <= SPREAD_MAX && Array.from(v).every((x) => x === null || typeof x !== 'object' || isTime(x) || !Array.isArray(x))) {
        if (!v.length) { out[p] = '[]'; return; }
        for (let i = 0; i < v.length; i++) walk(v[i], `${p}[${i}]`, depth + 1);
        return;
      }
      out[p] = v.length > JSON_ARRAY_MAX ? `${typeName(v)}[${v.length}]` : JSON.stringify(jsonValue(v));
      return;
    }
    if (v instanceof Map) { walk(Object.fromEntries(v), p, depth); return; }
    const keys = Object.keys(v);
    if (!keys.length && p) { out[p] = '{}'; return; }
    for (const k of keys) walk(v[k], p ? `${p}.${k}` : k, depth + 1);
  };
  walk(msg, '', 0);
  return out;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { numericPaths, numberAt, splitPath, flatten, jsonValue, csvCell, isTime, SPREAD_MAX, JSON_ARRAY_MAX };
