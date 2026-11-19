'use strict';
// Pro tool 1: one topic to CSV, JSON or JSON Lines. Streams through write(text) so large topics never sit in memory.
// CSV takes two passes: the first collects every column (variable-length arrays add columns), the second writes.
const { flatten, jsonValue, csvCell } = require('./fields');
const { nsText } = require('./recording');

const FORMATS = { csv: 'CSV', json: 'JSON', jsonl: 'JSON Lines' };

/**
 * rec: an open recording; o: { topic, format: 'csv'|'json'|'jsonl', write: async (text) => void, startNs?, endNs?,
 * onProgress?(n) }. Returns { rows, columns, errors }.
 */
async function exportTopic(rec, o) {
  const t = rec.topicInfo(o.topic);
  if (!t) throw new Error(`The topic ${o.topic} is not in this recording.`);
  const dec = rec.decoderFor(o.topic);
  if (!dec.decode) throw new Error(`${o.topic} cannot be decoded: ${dec.error}`);
  const range = { topics: [o.topic], startNs: o.startNs, endNs: o.endNs };
  const withPublish = rec.format === 'mcap';
  let rows = 0; let errors = 0;
  const buf = [];
  let size = 0;
  const flush = async (force) => { if (buf.length && (force || size > 1 << 20)) { const s = buf.join(''); buf.length = 0; size = 0; await o.write(s); } };
  const push = async (s) => { buf.push(s); size += s.length; await flush(false); };

  if (o.format === 'csv') {
    const cols = new Map();
    for await (const m of rec.iterate(range)) {
      let v; try { v = dec.decode(m.data); } catch (e) { continue; }
      for (const k of Object.keys(flatten(v))) if (!cols.has(k)) cols.set(k, cols.size);
    }
    const names = [...cols.keys()];
    await push(`${['log_time', ...(withPublish ? ['publish_time'] : []), ...names].map(csvCell).join(',')}\n`);
    for await (const m of rec.iterate(range)) {
      let v; try { v = dec.decode(m.data); } catch (e) { errors++; continue; }
      const f = flatten(v);
      const line = [nsText(m.logNs), ...(withPublish ? [nsText(m.publishNs)] : []), ...names.map((k) => (k in f ? f[k] : ''))];
      await push(`${line.map(csvCell).join(',')}\n`);
      rows++;
      if (o.onProgress && rows % 5000 === 0) o.onProgress(rows);
    }
    await flush(true);
    return { rows, columns: names.length + (withPublish ? 2 : 1), errors };
  }

  const json = o.format === 'json';
  if (json) await push('[\n');
  for await (const m of rec.iterate(range)) {
    let v; try { v = dec.decode(m.data); } catch (e) { errors++; continue; }
    const row = { topic: o.topic, log_time: nsText(m.logNs), ...(withPublish ? { publish_time: nsText(m.publishNs) } : {}), message: jsonValue(v) };
    await push(`${json && rows ? ',\n' : ''}${JSON.stringify(row)}${json ? '' : '\n'}`);
    rows++;
    if (o.onProgress && rows % 5000 === 0) o.onProgress(rows);
  }
  if (json) await push(rows ? '\n]\n' : ']\n');
  await flush(true);
  return { rows, columns: 0, errors };
}

module.exports = { exportTopic, FORMATS };
