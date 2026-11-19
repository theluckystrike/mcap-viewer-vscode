'use strict';
// Pro tool 3: two recordings compared by topic (type, message count, rate, first and last time) from their summaries.
// A rate counts as changed when it differs by more than RATE_TOLERANCE (relative). No vscode import.
const { nsToSec, nsText } = require('./recording');

const RATE_TOLERANCE = 0.1;

const pct = (a, b) => (a === b ? 0 : !a ? Infinity : ((b - a) / a) * 100);

/** a, b: open recordings. */
function compareRecordings(a, b) {
  const ta = new Map(a.topics.map((t) => [t.topic, t]));
  const tb = new Map(b.topics.map((t) => [t.topic, t]));
  const names = [...new Set([...ta.keys(), ...tb.keys()])].sort();
  const rows = names.map((topic) => {
    const x = ta.get(topic); const y = tb.get(topic);
    const r = {
      topic,
      typeA: x ? x.type : '', typeB: y ? y.type : '',
      countA: x ? x.count : null, countB: y ? y.count : null,
      hzA: x ? x.hz : null, hzB: y ? y.hz : null,
      status: 'same', notes: [],
    };
    if (!x) r.status = 'only in B';
    else if (!y) r.status = 'only in A';
    else {
      if (x.type !== y.type) r.notes.push('type differs');
      if (x.messageEncoding !== y.messageEncoding) r.notes.push('encoding differs');
      if (x.count !== y.count) r.notes.push('count differs');
      const hi = Math.max(x.hz, y.hz);
      if (hi > 0 && Math.abs(x.hz - y.hz) / hi > RATE_TOLERANCE) r.notes.push('rate differs');
      if (r.notes.length) r.status = r.notes[0];
    }
    r.countDiff = r.countA !== null && r.countB !== null ? r.countB - r.countA : null;
    r.countPct = r.countA !== null && r.countB !== null ? pct(r.countA, r.countB) : null;
    return r;
  });
  const sum = (rec) => ({
    format: rec.formatLabel, profile: rec.profile, size: rec.size, messages: rec.messageCount, topics: rec.topics.length,
    durationSec: rec.messageCount ? nsToSec(rec.endNs - rec.startNs) : 0, start: nsText(rec.startNs), end: nsText(rec.endNs),
    chunks: rec.chunks ? rec.chunks.count : 0, compression: rec.chunks ? Object.keys(rec.chunks.by).join(', ') || 'none' : '',
  });
  const counts = { same: 0, onlyA: 0, onlyB: 0, changed: 0 };
  for (const r of rows) {
    if (r.status === 'same') counts.same++;
    else if (r.status === 'only in A') counts.onlyA++;
    else if (r.status === 'only in B') counts.onlyB++;
    else counts.changed++;
  }
  return { a: sum(a), b: sum(b), rows, counts, tolerance: RATE_TOLERANCE };
}

const fmtHz = (v) => (v === null ? '' : v ? v.toFixed(2) : '0');
const fmtPct = (v) => (v === null ? '' : v === Infinity ? 'new' : `${v > 0 ? '+' : ''}${v.toFixed(1)} %`);
const mdCell = (s) => String(s === null || s === undefined ? '' : s).replace(/\|/g, '\\|');

function toMarkdown(r, nameA, nameB) {
  const lines = [`# Recording comparison`, '', `A: ${nameA}`, `B: ${nameB}`, '',
    '| | A | B |', '|---|---|---|',
    `| Format | ${r.a.format} ${r.a.profile} | ${r.b.format} ${r.b.profile} |`,
    `| Messages | ${r.a.messages} | ${r.b.messages} |`,
    `| Topics | ${r.a.topics} | ${r.b.topics} |`,
    `| Duration (s) | ${r.a.durationSec.toFixed(3)} | ${r.b.durationSec.toFixed(3)} |`,
    `| Start time (s) | ${r.a.start} | ${r.b.start} |`,
    `| Chunks | ${r.a.chunks} (${r.a.compression}) | ${r.b.chunks} (${r.b.compression}) |`,
    '', `Topics the same: ${r.counts.same}. Only in A: ${r.counts.onlyA}. Only in B: ${r.counts.onlyB}. Changed: ${r.counts.changed}. A rate counts as changed above ${Math.round(r.tolerance * 100)} %.`, '',
    '| Topic | Status | Type A | Type B | Count A | Count B | Count change | Rate A (Hz) | Rate B (Hz) |', '|---|---|---|---|---|---|---|---|---|'];
  for (const x of r.rows) lines.push(`| ${mdCell(x.topic)} | ${mdCell([x.status, ...x.notes.slice(1)].join(', '))} | ${mdCell(x.typeA)} | ${mdCell(x.typeB)} | ${x.countA ?? ''} | ${x.countB ?? ''} | ${fmtPct(x.countPct)} | ${fmtHz(x.hzA)} | ${fmtHz(x.hzB)} |`);
  return `${lines.join('\n')}\n`;
}

function toCsv(r) {
  const cell = (v) => { const s = String(v === null || v === undefined ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const out = ['topic,status,type_a,type_b,count_a,count_b,count_diff,rate_a_hz,rate_b_hz'];
  for (const x of r.rows) out.push([x.topic, [x.status, ...x.notes.slice(1)].join('; '), x.typeA, x.typeB, x.countA, x.countB, x.countDiff, x.hzA === null ? '' : x.hzA.toFixed(4), x.hzB === null ? '' : x.hzB.toFixed(4)].map(cell).join(','));
  return `${out.join('\n')}\n`;
}

module.exports = { compareRecordings, toMarkdown, toCsv, fmtHz, fmtPct, RATE_TOLERANCE };
