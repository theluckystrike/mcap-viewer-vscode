'use strict';
// The three Zovo Pro tools: Export a topic to CSV or JSON, Trim to a new MCAP file, Compare two recordings. Each asks
// pro.allowed() on every click and calls pro.produced() only after its result is there (the export or MCAP file
// written, the comparison drawn in its panel), so Escape, Cancel or an error never uses a free try. Everything runs
// on this computer.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const R = require('./core/recording');
const { exportTopic: exportCore, FORMATS } = require('./core/export');
const { trimToMcap } = require('./core/trim');
const C = require('./core/compare');
const { sizeText } = require('./core/view');
const { openUri, VIEW, REC_RE } = require('./editor');
const { panelHtml } = require('./html');
const support = require('./support');

const PREFIX = 'mcapViewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = (uri) => path.posix.basename(uri.path);
const stem = (uri) => base(uri).replace(/\.[^.]+$/, '');
const FILTERS = { 'Recordings': ['mcap', 'bag'], 'All files': ['*'] };
const OPEN_MAX = 5 * 1024 * 1024;
const fmtN = (n) => Number(n).toLocaleString('en-US');

function sibling(uri, name) { return vscode.Uri.joinPath(uri, '..', name); }
const sameFile = (a, b) => a && b && a.toString() === b.toString();
const slug = (topic) => topic.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+$/, '') || 'topic';

/** A file writer: a file handle for local files, else the bytes go through VS Code at the end. */
async function openWriter(dest) {
  if (dest.scheme === 'file') {
    const fh = await fs.promises.open(dest.fsPath, 'w');
    let size = 0;
    return {
      write: async (x) => { const b = typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.buffer, x.byteOffset, x.byteLength); await fh.write(b, 0, b.length); size += b.length; },
      close: async () => { await fh.close(); return size; },
      abort: async () => { try { await fh.close(); } catch (e) { /* closed */ } },
    };
  }
  const parts = [];
  return {
    write: async (x) => { parts.push(typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x)); },
    close: async () => { const b = Buffer.concat(parts); await vscode.workspace.fs.writeFile(dest, b); return b.length; },
    abort: async () => {},
  };
}

function createTools({ context, provider, pro, reach }) {
  const panels = {};

  function openPanel(kind, title) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const old = panels[kind];
    if (old && !old.disposed) old.panel.dispose();
    const panel = vscode.window.createWebviewPanel(`${PREFIX}.${kind}`, title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
      enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)),
    });
    panel.webview.html = panelHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title, head: reach ? (n) => reach.headHtml(n) : undefined, showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    let readyFn;
    const p = { panel, kind, disposed: false, actions: null, shown: null };
    p.ready = new Promise((r) => { readyFn = r; });
    p.post = (msg) => { try { const r = panel.webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } };
    p.show = async (o) => { await p.ready; p.post({ type: 'show', ...o }); };
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      try {
        if (m.type === 'ready') readyFn();
        else if (m.type === 'shown') { if (p.shown) { const f = p.shown; p.shown = null; await f(m); } }
        else if (m.type === 'action' && p.actions) await p.actions(m.id, m);
      } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); }
    });
    panel.onDidDispose(() => { p.disposed = true; if (panels[kind] === p) delete panels[kind]; });
    panels[kind] = p;
    return p;
  }

  /** The viewer tab in front (its own tab group first), else the last active viewer. */
  function frontViewerUri() {
    try {
      const groups = vscode.window.tabGroups;
      const tabs = [groups.activeTabGroup && groups.activeTabGroup.activeTab, ...groups.all.map((g) => g.activeTab)];
      for (const t of tabs) if (t && t.input && t.input.viewType === VIEW && t.input.uri) return t.input.uri;
    } catch (e) { /* older API */ }
    return provider.active ? provider.active.uri : null;
  }

  /** The file a tool works on: the clicked one, else the viewer in front, else a dialog. */
  async function targetFile(arg, title) {
    if (arg && arg.scheme) return arg;
    const u = frontViewerUri();
    if (u) return u;
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Choose', title, filters: FILTERS });
    return r && r[0];
  }

  /** The open recording of uri: the viewer's own when it is open, else opened now (and closed after the tool). */
  async function recFor(uri) {
    for (const d of provider.docs) if (d.uri.toString() === uri.toString() && d.rec) return { rec: d.rec, doc: d, close: async () => {} };
    let rec;
    try { rec = await openUri(uri); } catch (e) { throw new Error(`${base(uri)} could not be opened: ${(e && e.message) || e}`); }
    return { rec, doc: null, close: () => rec.close() };
  }

  function selectedTopic(uri) {
    for (const d of provider.docs) if (d.uri.toString() === uri.toString() && d.selectedTopic) return d.selectedTopic;
    return '';
  }

  async function pickOther(uriA, title) {
    const items = [];
    const seen = new Set([uriA.toString()]);
    for (const d of provider.docs) if (!seen.has(d.uri.toString()) && d.rec) { seen.add(d.uri.toString()); items.push({ label: d.name, description: 'open in the viewer', uri: d.uri }); }
    let files = [];
    try { files = await vscode.workspace.findFiles('**/*.{mcap,bag,MCAP,BAG}', '**/node_modules/**', 300); } catch (e) { files = []; }
    for (const u of files) if (!seen.has(u.toString())) { seen.add(u.toString()); items.push({ label: base(u), description: vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(u) : u.fsPath, uri: u }); }
    items.push({ label: 'Choose a file...', description: 'MCAP or ROS 1 bag', file: true });
    const pick = await vscode.window.showQuickPick(items, { ignoreFocusOut: true, title, placeHolder: 'The recording to compare with (B)', matchOnDescription: true });
    if (!pick) return undefined;
    if (!pick.file) return pick.uri;
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', title, filters: FILTERS });
    return r && r[0];
  }

  // ---------- 1. Export a topic to CSV or JSON ----------
  async function exportTopic(arg, extra = {}) {
    if (!(await pro.allowed('export', arg))) return undefined;
    const uri = await targetFile(arg, 'Export: choose a recording');
    if (!uri) return undefined;
    const h = await recFor(uri);
    try {
      const rec = h.rec;
      let topic = extra.topic;
      if (!topic) {
        const sel = selectedTopic(uri);
        const list = rec.topics.filter((t) => t.count > 0);
        if (!list.length) { vscode.window.showWarningMessage(`${base(uri)} has no messages to export.`); return undefined; }
        list.sort((a, b) => (a.topic === sel ? -1 : b.topic === sel ? 1 : 0));
        const pick = await vscode.window.showQuickPick(list.map((t) => {
          const d = rec.decoderFor(t.topic);
          return { label: t.topic, description: t.type, detail: d.decode ? `${fmtN(t.count)} messages, ${t.messageEncoding}` : `cannot be decoded: ${d.error}`, topic: t.topic };
        }), { ignoreFocusOut: true, title: `Export a topic of ${base(uri)}`, placeHolder: 'The topic to export', matchOnDescription: true });
        if (!pick) return undefined;
        topic = pick.topic;
      }
      const dec = rec.decoderFor(topic);
      if (!dec.decode) { vscode.window.showWarningMessage(`${topic} cannot be exported: ${dec.error}`); return undefined; }
      let format = extra.format;
      if (!format) {
        const pick = await vscode.window.showQuickPick([
          { label: 'CSV', description: '.csv, one column per field, arrays up to 64 items spread', id: 'csv' },
          { label: 'JSON', description: '.json, one array of messages with their fields', id: 'json' },
          { label: 'JSON Lines', description: '.jsonl, one message per line', id: 'jsonl' },
        ], { ignoreFocusOut: true, title: `Export ${topic}`, placeHolder: 'Save the messages as...' });
        if (!pick) return undefined;
        format = pick.id;
      }
      if (!FORMATS[format]) return undefined;
      const dest = extra.dest || await vscode.window.showSaveDialog({ defaultUri: sibling(uri, `${stem(uri)}.${slug(topic)}.${format}`), filters: { [FORMATS[format]]: [format] }, title: `Save ${topic} as ${FORMATS[format]}` });
      if (!dest) return undefined;
      if (sameFile(dest, uri)) { vscode.window.showErrorMessage('Choose another file name: the export never writes over the recording it reads.'); return undefined; }
      const w = await openWriter(dest);
      let r; let size;
      try {
        r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Exporting ${topic}` }, () => exportCore(rec, { topic, format, write: w.write }));
        size = await w.close();
      } catch (e) { await w.abort(); throw e; }
      if (size <= OPEN_MAX) { const td = await vscode.workspace.openTextDocument(dest); await vscode.window.showTextDocument(td, { viewColumn: vscode.ViewColumn.Beside, preview: true }); }
      vscode.window.setStatusBarMessage(`Saved ${base(dest)}: ${fmtN(r.rows)} messages of ${topic} (${sizeText(size)})`, 8000);
      await pro.produced('export');
      return { dest, topic, format, rows: r.rows, columns: r.columns, size };
    } finally { await h.close(); }
  }

  // ---------- 2. Trim to a new MCAP file ----------
  async function trim(arg, extra = {}) {
    if (!(await pro.allowed('trim', arg))) return undefined;
    const uri = await targetFile(arg, 'Trim: choose a recording');
    if (!uri) return undefined;
    const h = await recFor(uri);
    try {
      const rec = h.rec;
      if (!rec.messageCount) { vscode.window.showWarningMessage(`${base(uri)} has no messages to trim.`); return undefined; }
      let topics = extra.topics;
      if (!topics) {
        const items = rec.topics.map((t) => ({ label: t.topic, description: t.type, detail: `${fmtN(t.count)} messages`, picked: true, topic: t.topic }));
        const pick = await vscode.window.showQuickPick(items, { canPickMany: true, ignoreFocusOut: true, title: `Trim ${base(uri)}: topics to keep`, placeHolder: 'Every topic is picked; clear the ones to leave out' });
        if (!pick) return undefined;
        if (!pick.length) { vscode.window.showWarningMessage('Pick at least one topic to keep.'); return undefined; }
        topics = pick.length === items.length ? [] : pick.map((p) => p.topic);
      }
      const dur = R.nsToSec(rec.endNs - rec.startNs);
      const ask = async (what, value) => vscode.window.showInputBox({
        ignoreFocusOut: true, title: `Trim ${base(uri)}: ${what}`, value,
        prompt: `${what === 'start' ? 'Start' : 'End'} of the range, in seconds from the first message (0 to ${dur.toFixed(3)}).`,
        validateInput: (v) => { const n = R.secToNs(v); return n === null || n < 0n ? 'Enter a number of seconds, for example 12.5' : null; },
      });
      let startSec = extra.start; let endSec = extra.end;
      if (startSec === undefined) { startSec = await ask('start', '0'); if (startSec === undefined) return undefined; }
      if (endSec === undefined) { endSec = await ask('end', dur.toFixed(3)); if (endSec === undefined) return undefined; }
      const s = R.secToNs(String(startSec)); const e = R.secToNs(String(endSec));
      if (s === null || e === null || e < s) { vscode.window.showErrorMessage('The end of the range must come after its start.'); return undefined; }
      const startNs = rec.startNs + s; const endNs = rec.startNs + e;
      const dest = extra.dest || await vscode.window.showSaveDialog({ defaultUri: sibling(uri, `${stem(uri)}.trim.mcap`), filters: { MCAP: ['mcap'] }, title: `Save the trimmed recording as MCAP` });
      if (!dest) return undefined;
      if (sameFile(dest, uri)) { vscode.window.showErrorMessage('Choose another file name: the trim never writes over the recording it reads.'); return undefined; }
      const w = await openWriter(dest);
      let r;
      try {
        r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Trimming ${base(uri)}` }, () => trimToMcap(rec, { topics, startNs, endNs, compression: extra.compression || 'lz4', write: w.write }));
        await w.close();
      } catch (err) { await w.abort(); throw err; }
      await vscode.commands.executeCommand('vscode.openWith', dest, VIEW, { viewColumn: vscode.ViewColumn.Beside, preview: true });
      vscode.window.setStatusBarMessage(`Saved ${base(dest)}: ${fmtN(r.messages)} messages in ${r.topics} topics (${sizeText(r.bytes)})`, 8000);
      await pro.produced('trim');
      return { dest, ...r };
    } finally { await h.close(); }
  }

  // ---------- 3. Compare two recordings ----------
  async function compare(arg, extra = {}) {
    if (!(await pro.allowed('compare', arg))) return undefined;
    const uriA = await targetFile(arg, 'Compare: choose the first recording (A)');
    if (!uriA) return undefined;
    const uriB = extra.other || await pickOther(uriA, `Compare ${base(uriA)} with...`);
    if (!uriB) return undefined;
    const ha = await recFor(uriA);
    let hb;
    try {
      hb = await recFor(uriB);
      const r = C.compareRecordings(ha.rec, hb.rec);
      const nameA = base(uriA); const nameB = base(uriB);
      const title = `Compare: ${nameA} and ${nameB}`;
      const p = openPanel('compare', title);
      p.result = r;
      p.shown = async () => { await pro.produced('compare'); };
      const fileName = `${stem(uriA)}-vs-${stem(uriB)}`;
      p.actions = async (id) => {
        if (id !== 'md' && id !== 'csv') return;
        const md = id === 'md';
        const dest = await vscode.window.showSaveDialog({ defaultUri: sibling(uriA, `${fileName}.compare.${md ? 'md' : 'csv'}`), filters: md ? { Markdown: ['md'] } : { CSV: ['csv'] }, title: `Save the comparison as ${md ? 'Markdown' : 'CSV'}` });
        if (!dest) return;
        await vscode.workspace.fs.writeFile(dest, Buffer.from(md ? C.toMarkdown(r, nameA, nameB) : C.toCsv(r), 'utf8'));
        p.post({ type: 'patch', target: 'saved', html: `Saved ${esc(dest.fsPath || dest.path)}.` });
      };
      const kindOf = (x) => (x.status === 'same' ? 'same' : x.status === 'only in A' ? 'onlyA' : x.status === 'only in B' ? 'onlyB' : 'changed');
      const cell = (v, n) => (v === null ? '<td class="num muted">-</td>' : `<td class="num">${n ? fmtN(v) : esc(v)}</td>`);
      const rows = r.rows.map((x) => `<tr class="${kindOf(x)}" data-kind="${kindOf(x)}" data-topic="${esc(x.topic)}"><td><code>${esc(x.topic)}</code></td><td>${esc([x.status, ...x.notes.slice(1)].join(', '))}</td><td><code>${esc(x.typeA)}</code></td><td><code>${esc(x.typeB)}</code></td>${cell(x.countA, true)}${cell(x.countB, true)}<td class="num">${esc(C.fmtPct(x.countPct))}</td><td class="num">${esc(C.fmtHz(x.hzA))}</td><td class="num">${esc(C.fmtHz(x.hzB))}</td></tr>`).join('');
      const sum = (k, f) => `<tr><th>${k}</th><td>${f(r.a)}</td><td>${f(r.b)}</td></tr>`;
      const html = `<p class="row"><button class="tb act" data-id="md">Save as Markdown...</button> <button class="tb act" data-id="csv">Save as CSV...</button> <span id="saved" class="muted"></span></p>
<div class="stats"><div><b id="nSame">${r.counts.same}</b><span>topics the same</span></div><div><b id="nChanged">${r.counts.changed}</b><span>topics changed</span></div><div><b id="nOnlyA">${r.counts.onlyA}</b><span>only in A</span></div><div><b id="nOnlyB">${r.counts.onlyB}</b><span>only in B</span></div></div>
<table class="kv" id="sumTable"><thead><tr><th></th><th>A: ${esc(nameA)}</th><th>B: ${esc(nameB)}</th></tr></thead><tbody>
${sum('Format', (s) => esc(`${s.format} ${s.profile}`))}${sum('Size', (s) => esc(sizeText(s.size)))}${sum('Messages', (s) => fmtN(s.messages))}${sum('Topics', (s) => fmtN(s.topics))}${sum('Duration', (s) => `${s.durationSec.toFixed(3)} s`)}${sum('Start (s)', (s) => esc(s.start))}${sum('Chunks', (s) => `${fmtN(s.chunks)} (${esc(s.compression)})`)}
</tbody></table>
<p class="muted">Topics are matched by name. A count change shows when the numbers differ; a rate counts as changed when it differs by more than ${Math.round(r.tolerance * 100)} %. Message contents are not compared.</p>
<div class="filters" id="kindFilter"><label><input type="checkbox" value="changed" checked> Changed (${r.counts.changed})</label><label><input type="checkbox" value="onlyA" checked> Only in A (${r.counts.onlyA})</label><label><input type="checkbox" value="onlyB" checked> Only in B (${r.counts.onlyB})</label><label><input type="checkbox" value="same" checked> Same (${r.counts.same})</label> <span class="muted">Shown: <span id="shownCount">${r.rows.length}</span></span></div>
<table id="cmpTable" class="sort"><thead><tr><th>Topic</th><th>Status</th><th>Type A</th><th>Type B</th><th>Count A</th><th>Count B</th><th>Count change</th><th>Hz A</th><th>Hz B</th></tr></thead><tbody>${rows}</tbody></table>`;
      await p.show({ title, html });
      return r;
    } finally {
      await ha.close();
      if (hb) await hb.close();
    }
  }

  return { exportTopic, trim, compare, panels, recFor, targetFile, frontViewerUri };
}

module.exports = { createTools, sibling, openWriter, slug, REC_RE };
