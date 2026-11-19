'use strict';
// Extension tests with the vscode stub: listing, activation, the custom editor's messages for MCAP files, bags and
// broken files, the three Pro tools with 1 free try each (the 2nd use opens the Pro panel, on another file and after a
// reload), the toolbar row, README and support links.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, tmpDir, cleanup } = require('./support/vscode-stub');
const { editorHtml, panelHtml } = require('../src/html');
const R = require('../src/core/recording');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const FIX = path.join(__dirname, 'fixtures');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await tick(10); } return f(); };
test.after(() => cleanup());

function fakePanel() {
  let onMsg;
  const posted = [];
  return {
    posted, viewColumn: 1, active: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
    send: (m) => onMsg(m),
  };
}

const activated = [];
/** Activates with a fresh stub. state: entries to put into globalState first (a "reload" of the window). */
function activate(folder, state) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  if (state) for (const [k, v] of state) s.state.set(k, v);
  s.api = s.ext.activate(s.context);
  activated.push(s);
  // tool panels answer "show" with "shown" like the real panel does after drawing
  s.log.onPost = (panel, m) => { if (m.type === 'show' && m.html) panel.send({ type: 'shown' }); };
  s.opened = [];
  s.commands.set('vscode.openWith', async (uri, viewType) => {
    s.opened.push([uri.fsPath, viewType]);
    if (viewType !== 'mcapViewer.editor') return undefined;
    const prov = s.api.provider;
    for (const d of prov.docs) if (d.uri.toString() === uri.toString() && d.panels.size) { prov.active = d; prov.activePanel = [...d.panels][0]; return undefined; }
    const e = await openEditor(s, uri.fsPath);
    prov.active = e.doc; prov.activePanel = e.panel;
    return undefined;
  });
  return s;
}
test.after(() => { for (const s of activated) s.api.provider.dispose(); });

async function openEditor(s, file) {
  const prov = s.api.provider;
  const handle = await prov.openCustomDocument(s.vscode.Uri.file(file));
  const panel = fakePanel();
  await prov.resolveCustomEditor(handle, panel);
  await panel.send({ type: 'ready' });
  const init = panel.posted.find((m) => m.type === 'init');
  if (init && init.kind === 'rec') await panel.send({ type: 'rendered', topics: init.info.topics.length });
  prov.active = handle._doc; prov.activePanel = panel;
  return { prov, handle, panel, doc: handle._doc, init };
}
function ws() {
  const dir = tmpDir('mcap-ws-');
  for (const f of fs.readdirSync(SAMPLES)) fs.copyFileSync(path.join(SAMPLES, f), path.join(dir, f));
  for (const f of fs.readdirSync(FIX)) if (fs.statSync(path.join(FIX, f)).isFile()) fs.copyFileSync(path.join(FIX, f), path.join(dir, f));
  fs.copyFileSync(path.join(SAMPLES, 'demo-rover-ros2.mcap'), path.join(dir, 'ROVER.MCAP'));
  fs.copyFileSync(path.join(SAMPLES, 'demo-rover-ros1.bag'), path.join(dir, 'second.bag'));
  return dir;
}
const proPanels = (s, title) => s.log.info.filter((m) => m.text === `${title} is part of Zovo Pro.`);
const U = (s, dir, f) => s.vscode.Uri.file(path.join(dir, f));

// ---------- package.json and listing ----------
test('listing: display name, phrase first, 5 keywords, engines, publisher, repository, activation', () => {
  assert.equal(pkg.displayName, 'MCAP Viewer & ROS Bag Viewer');
  assert.ok(pkg.displayName.length <= 30);
  assert.match(pkg.description, /^MCAP viewer/);
  assert.deepEqual(pkg.keywords, ['mcap', 'rosbag', 'ros', 'ros2', 'robotics']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.equal(pkg.publisher, 'zovo');
  assert.equal(pkg.name, 'zovo-mcap-viewer');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository.url, 'https://github.com/theluckystrike/mcap-viewer-vscode');
  assert.deepEqual(pkg.activationEvents, ['onUri']);
  assert.ok(fs.existsSync(path.join(ROOT, 'icon.png')));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), []);
});
test('editors: *.mcap and *.bag by default, nothing else (no .db3); no language, grammar or theme', () => {
  assert.equal(pkg.contributes.customEditors.length, 1);
  const [ed] = pkg.contributes.customEditors;
  assert.deepEqual(ed.selector.map((s) => s.filenamePattern), ['*.mcap', '*.bag']);
  assert.equal(ed.priority, 'default');
  assert.doesNotMatch(JSON.stringify(pkg.contributes), /db3/);
  assert.ok(!pkg.contributes.themes && !pkg.contributes.grammars && !pkg.contributes.languages && !pkg.contributes.configurationDefaults);
});
test('menus: one backslash before the dot; the right-click regex matches upper case; no title on menu items; wrappers hidden in the palette', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  assert.ok(!raw.includes('\\\\\\\\.'));
  const items = Object.values(pkg.contributes.menus).flat();
  assert.ok(items.every((m) => !('title' in m)));
  const ctx = pkg.contributes.menus['explorer/context'].find((m) => m.command === 'mcapViewer.zovoPro.trim');
  const re = new RegExp(/resourceFilename =~ \/(.*)\/i/.exec(ctx.when)[1], 'i');
  for (const f of ['a.mcap', 'ROVER.MCAP', 'x.bag', 'Y.BAG']) assert.ok(re.test(f), f);
  assert.ok(!re.test('a.db3') && !re.test('a.mcap.bak') && !re.test('bag'));
  const wrappers = pkg.contributes.commands.filter((c) => /\.zovoPro\./.test(c.command));
  assert.equal(wrappers.length, 3);
  assert.ok(wrappers.every((c) => c.title.startsWith('Zovo Pro: ')));
  for (const w of wrappers) assert.ok(pkg.contributes.menus.commandPalette.some((m) => m.command === w.command && m.when === 'false'));
});
test('the trial kill switch setting is zovo.<listing>.trial.enabled, default true', () => {
  const cfg = require('../src/license/config');
  const p = pkg.contributes.configuration.properties[`zovo.${cfg.listing}.trial.enabled`];
  assert.equal(cfg.listing, 'mcap');
  assert.equal(p.type, 'boolean');
  assert.equal(p.default, true);
  assert.equal(p.description, 'Show the 7-day Zovo Pro trial button in the Pro panel.');
});
test('every contributed command is registered, and every registered mcapViewer command is contributed', () => {
  const s = activate();
  const contributed = pkg.contributes.commands.map((c) => c.command);
  for (const c of contributed) assert.ok(s.commands.has(c), c);
  for (const c of s.commands.keys()) if (c.startsWith('mcapViewer.')) assert.ok(contributed.includes(c), c);
});
test('activation shows nothing: no message, no panel, no editor, no status text', () => {
  const s = activate();
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0);
  assert.equal(s.log.panel, undefined);
  assert.equal(s.opened.length, 0);
  assert.equal(s.log.status.length, 0);
});

// ---------- the viewer ----------
test('viewer: the ROS 2 sample sends the summary; pages, fields and a plot answer the webview', async () => {
  const s = activate();
  const e = await openEditor(s, path.join(SAMPLES, 'demo-rover-ros2.mcap'));
  assert.equal(e.init.kind, 'rec');
  const info = e.init.info;
  assert.equal(info.messageCount, 2880);
  assert.equal(info.topics.length, 5);
  assert.equal(info.profile, 'ros2');
  assert.deepEqual(Object.keys(info.chunks.by), ['zstd']);
  await e.panel.send({ type: 'page', id: 1, topic: '/imu', fromNs: info.startNs, count: 10 });
  const page = e.panel.posted.find((m) => m.type === 'page');
  assert.equal(page.id, 1);
  assert.equal(page.items.length, 10);
  assert.equal(page.items[0].value.header.frame_id, 'imu_link');
  await e.panel.send({ type: 'fields', id: 2, topic: '/imu' });
  assert.ok(e.panel.posted.find((m) => m.type === 'fields').paths.includes('linear_acceleration.z'));
  await e.panel.send({ type: 'plot', id: 3, topic: '/imu', path: 'linear_acceleration.z' });
  const plot = e.panel.posted.find((m) => m.type === 'plot');
  assert.equal(plot.total, 1500);
  assert.ok(plot.min > 9.6 && plot.max < 10);
  await e.panel.send({ type: 'select', topic: '/imu' });
  assert.equal(e.doc.selectedTopic, '/imu');
  assert.ok(e.doc.rendered && e.doc.rendered.topics === 5);
  assert.equal(s.log.error.length, 0);
});
test('viewer: the ROS 1 bag sample and an upper-case .MCAP name open the same way', async () => {
  const dir = ws();
  const s = activate(dir);
  const bag = await openEditor(s, path.join(dir, 'demo-rover-ros1.bag'));
  assert.equal(bag.init.info.formatLabel, 'ROS 1 bag');
  assert.deepEqual(Object.keys(bag.init.info.chunks.by), ['lz4']);
  const up = await openEditor(s, path.join(dir, 'ROVER.MCAP'));
  assert.equal(up.init.info.messageCount, 2880);
});
test('viewer: broken, empty, old, not-a-bag and cut-off files give a plain note in the view, no error message, no tab reopened', async () => {
  const dir = ws();
  const s = activate(dir);
  for (const [f, kind, re] of [['broken.mcap', 'error', /could not be read/], ['empty.mcap', 'empty', /empty/], ['old-format.bag', 'old', /rosbag fix/], ['not-a-bag.bag', 'notrec', /not an MCAP file/], ['cut-off.bag', 'error', /reindex/]]) {
    const e = await openEditor(s, path.join(dir, f));
    assert.equal(e.init.kind, kind, f);
    assert.match(e.init.error, re, f);
  }
  const cut = await openEditor(s, path.join(dir, 'cut-off.mcap'));
  assert.equal(cut.init.kind, 'rec');
  assert.ok(cut.init.info.warnings.some((w) => /cut off/.test(w)));
  assert.equal(s.log.error.length + s.log.info.length + s.log.warn.length, 0);
  assert.equal(s.opened.length, 0);
  await cut.panel.send({ type: 'page', id: 9, topic: '/nope', fromNs: '0' });
  assert.equal(cut.panel.posted.find((m) => m.type === 'page').items.length, 0);
});
test('viewer: a failing request answers "failed" in the view, not with a popup', async () => {
  const s = activate();
  const e = await openEditor(s, path.join(SAMPLES, 'demo-sensors.mcap'));
  await e.panel.send({ type: 'page', id: 4, topic: '/gps', fromNs: 'not a number' });
  const f = e.panel.posted.find((m) => m.type === 'failed');
  assert.equal(f.id, 4);
  assert.equal(s.log.error.length, 0);
});
test('webview HTML: strict CSP, nonce scripts, no remote URLs, no blob, worker or connect sources', () => {
  const e = editorHtml({ cspSource: 'vscode-resource:', scriptUri: 'media/viewer.js', styleUri: 'media/viewer.css', title: 'x<y', showSupportLinks: true, nonce: 'abc' });
  const p = panelHtml({ cspSource: 'vscode-resource:', scriptUri: 'media/panel.js', styleUri: 'media/viewer.css', title: 't', nonce: 'abc' });
  for (const h of [e, p]) {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(h)[1];
    assert.match(csp, /^default-src 'none'/);
    assert.match(csp, /script-src 'nonce-abc'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|connect-src|worker-src|blob:|https?:/);
    assert.ok([...h.matchAll(/<script\b[^>]*>/g)].every((m) => /nonce="abc"/.test(m[0])));
    assert.doesNotMatch(h.replace(/https:\/\/(marketplace\.visualstudio\.com|github\.com|www\.paypal\.com|open-vsx\.org)[^"]*/g, ''), /https?:\/\//);
  }
  assert.match(e, /<title>x&lt;y<\/title>/);
});
test('media scripts load nothing remote and open no connection', () => {
  for (const f of ['viewer.js', 'panel.js']) {
    const t = fs.readFileSync(path.join(ROOT, 'media', f), 'utf8');
    assert.doesNotMatch(t, /fetch\(|XMLHttpRequest|WebSocket|new Worker|importScripts|https?:\/\/|eval\(/, f);
  }
});
test('no source file and no vendored library opens a network connection', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(ROOT, 'src')).filter((x) => x.endsWith('.js') && !x.includes(`${path.sep}license${path.sep}`))) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /require\(['"](https?|net|tls|dgram|child_process)['"]\)|fetch\(/, f);
  }
  const v = fs.readFileSync(path.join(ROOT, 'lib', 'vendor.js'), 'utf8');
  assert.doesNotMatch(v, /require\(["'](https?|net|tls|dgram|child_process|worker_threads)["']\)|XMLHttpRequest|WebSocket/);
});

// ---------- Pro: export ----------
test('Pro Export: the IMU topic as CSV (file written and opened); try counted after the file was written; Escape uses no try', async () => {
  const dir = ws();
  const s = activate(dir);
  const a = U(s, dir, 'demo-rover-ros2.mcap');
  s.ui.quick.push(undefined); // Escape in the topic pick
  assert.equal(await s.api.tools.exportTopic(a), undefined);
  assert.equal(s.api.pro.left('export'), 1);
  s.ui.quick.push((items) => items.find((i) => i.topic === '/imu'), (items) => items.find((i) => i.id === 'csv'));
  s.ui.save.push(U(s, dir, 'imu.csv'));
  const r = await s.api.tools.exportTopic(a);
  assert.equal(r.rows, 1500);
  const csv = fs.readFileSync(path.join(dir, 'imu.csv'), 'utf8').split('\n');
  assert.equal(csv.length, 1502);
  assert.match(csv[0], /^log_time,publish_time,header\.stamp,header\.frame_id,orientation\.x/);
  assert.equal(s.log.opened.length, 1);
  assert.equal(s.api.pro.left('export'), 0);
  assert.ok(s.log.status.some((t) => /free try 1 of 1 of "Export a topic to CSV or JSON"/.test(t)));
});
test('Pro Export A then B: after the JSON of file A, the export of file B opens the Pro panel and writes nothing', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.exportTopic(U(s, dir, 'demo-rover-ros2.mcap'), { topic: '/scan', format: 'json', dest: U(s, dir, 'scan.json') });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'scan.json'), 'utf8')).length, 300);
  const r = await s.api.tools.exportTopic(U(s, dir, 'demo-rover-ros1.bag'), { topic: '/imu', format: 'csv', dest: U(s, dir, 'b.csv') });
  assert.equal(r, undefined);
  assert.equal(proPanels(s, 'Export a topic to CSV or JSON').length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'b.csv')));
});
test('Pro Export: a topic without a decoder and a save over the recording use no try', async () => {
  const dir = ws();
  fs.copyFileSync(path.join(FIX, 'third-party', 'TenMessages.mcap'), path.join(dir, 'ten.mcap'));
  const s = activate(dir);
  assert.equal(await s.api.tools.exportTopic(U(s, dir, 'ten.mcap'), { topic: 'example', format: 'csv', dest: U(s, dir, 'x.csv') }), undefined);
  assert.match(s.log.warn[0].text, /cannot be exported/);
  assert.equal(await s.api.tools.exportTopic(U(s, dir, 'demo-sensors.mcap'), { topic: '/gps', format: 'csv', dest: U(s, dir, 'demo-sensors.mcap') }), undefined);
  assert.match(s.log.error[0].text, /never writes over/);
  assert.equal(s.api.pro.left('export'), 1);
});

// ---------- Pro: trim ----------
test('Pro Trim: picked topics and a typed range become a new MCAP file that opens in the viewer; try counted after', async () => {
  const dir = ws();
  const s = activate(dir);
  s.ui.quick.push((items) => items.filter((i) => i.topic === '/imu' || i.topic === '/scan'));
  s.ui.input.push('5', '7.5');
  s.ui.save.push(U(s, dir, 'cut.mcap'));
  const r = await s.api.tools.trim(U(s, dir, 'demo-rover-ros1.bag'));
  assert.equal(r.topics, 2);
  assert.ok(r.messages >= 148 && r.messages <= 152, String(r.messages));
  const out = await R.openPath(path.join(dir, 'cut.mcap'));
  assert.deepEqual(out.topics.map((t) => t.topic), ['/imu', '/scan']);
  assert.equal(out.profile, 'ros1');
  assert.ok(R.nsToSec(out.endNs - out.startNs) <= 2.5);
  await out.close();
  assert.deepEqual(s.opened.at(-1), [path.join(dir, 'cut.mcap'), 'mcapViewer.editor']);
  assert.equal(s.api.pro.left('trim'), 0);
});
test('Pro Trim: Escape in the range, a range that ends before it starts and Cancel in the save dialog use no try', async () => {
  const dir = ws();
  const s = activate(dir);
  const a = U(s, dir, 'demo-rover-ros2.mcap');
  s.ui.quick.push((items) => items);
  s.ui.input.push(undefined);
  assert.equal(await s.api.tools.trim(a), undefined);
  assert.equal(await s.api.tools.trim(a, { topics: [], start: '9', end: '3' }), undefined);
  assert.match(s.log.error[0].text, /end of the range/);
  s.ui.save.push(undefined);
  assert.equal(await s.api.tools.trim(a, { topics: [], start: '0', end: '1' }), undefined);
  assert.equal(s.api.pro.left('trim'), 1);
});
test('Pro Trim A then B: after trimming file A, trimming file B opens the Pro panel', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.trim(U(s, dir, 'demo-rover-ros2.mcap'), { topics: ['/pose'], start: '0', end: '2', dest: U(s, dir, 'a.trim.mcap') });
  assert.ok(fs.existsSync(path.join(dir, 'a.trim.mcap')));
  assert.equal(await s.api.tools.trim(U(s, dir, 'second.bag'), { topics: [], start: '0', end: '2', dest: U(s, dir, 'b.trim.mcap') }), undefined);
  assert.equal(proPanels(s, 'Trim to a new MCAP file').length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'b.trim.mcap')));
});

// ---------- Pro: compare ----------
test('Pro Compare: the report shows changed counts and only-in-A topics; Markdown saved; try counted after the report showed', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.trim(U(s, dir, 'demo-rover-ros2.mcap'), { topics: ['/imu', '/pose'], start: '0', end: '10', dest: U(s, dir, 'short.mcap') });
  s.state.delete('mcapViewer.proTrial');
  const s2 = activate(dir);
  s2.ui.quick.push((items) => items.find((i) => i.label === 'short.mcap'));
  const r = await s2.api.tools.compare(U(s2, dir, 'demo-rover-ros2.mcap'));
  assert.deepEqual(r.counts, { same: 0, onlyA: 3, onlyB: 0, changed: 2 });
  const show = s2.log.panel.posted.find((m) => m.type === 'show');
  assert.match(show.html, /<table id="cmpTable"/);
  assert.match(show.html, /data-topic="\/cmd_vel"[^>]*>|data-kind="onlyA" data-topic="\/cmd_vel"/);
  await until(() => s2.api.pro.left('compare') === 0);
  s2.ui.save.push(U(s2, dir, 'report.md'));
  await s2.log.panel.send({ type: 'action', id: 'md' });
  await until(() => fs.existsSync(path.join(dir, 'report.md')));
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /\| \/imu \| count differs \|/);
});
test('Pro Compare A then B: after one use, comparing another pair opens the Pro panel; Escape in the pick used no try', async () => {
  const dir = ws();
  const s = activate(dir);
  const a = U(s, dir, 'demo-rover-ros2.mcap');
  s.ui.quick.push(undefined); // Escape
  assert.equal(await s.api.tools.compare(a), undefined);
  assert.equal(s.api.pro.left('compare'), 1);
  await s.api.tools.compare(a, { other: U(s, dir, 'demo-rover-ros1.bag') });
  await until(() => s.api.pro.left('compare') === 0);
  const r = await s.api.tools.compare(U(s, dir, 'second.bag'), { other: U(s, dir, 'demo-sensors.mcap') });
  assert.equal(r, undefined);
  assert.equal(proPanels(s, 'Compare two recordings').length, 1);
  assert.equal(s.log.panel.posted.filter((m) => m.type === 'show').length, 1);
});

// ---------- tries and the Pro panel ----------
test('a window reload keeps the counts: after a reload every used tool opens the Pro panel', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.exportTopic(U(s, dir, 'demo-rover-ros2.mcap'), { topic: '/cmd_vel', format: 'jsonl', dest: U(s, dir, 'c.jsonl') });
  await s.api.tools.trim(U(s, dir, 'demo-rover-ros2.mcap'), { topics: [], start: '0', end: '1', dest: U(s, dir, 'one.mcap') });
  assert.deepEqual(s.api.pro.tries(), { export: 0, trim: 0, compare: 1 });
  const s2 = activate(dir, s.state);
  assert.deepEqual(s2.api.pro.tries(), { export: 0, trim: 0, compare: 1 });
  assert.equal(await s2.api.tools.exportTopic(U(s2, dir, 'second.bag'), { topic: '/imu', format: 'csv', dest: U(s2, dir, 'z.csv') }), undefined);
  assert.equal(proPanels(s2, 'Export a topic to CSV or JSON').length, 1);
  assert.equal(await s2.api.tools.trim(U(s2, dir, 'second.bag'), { topics: [], start: '0', end: '1', dest: U(s2, dir, 'z.mcap') }), undefined);
  assert.equal(proPanels(s2, 'Trim to a new MCAP file').length, 1);
});
test('the Pro panel names the other tools with their tries and no URL is opened when it is dismissed', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.exportTopic(U(s, dir, 'demo-sensors.mcap'), { topic: '/status', format: 'csv', dest: U(s, dir, 's.csv') });
  await s.api.tools.exportTopic(U(s, dir, 'demo-rover-ros2.mcap'), { topic: '/imu', format: 'csv', dest: U(s, dir, 't.csv') });
  const p = proPanels(s, 'Export a topic to CSV or JSON')[0];
  assert.ok(p && p.opts.modal);
  assert.match(p.opts.detail, /You used the free try of Export a topic to CSV or JSON on this computer\./);
  assert.match(p.opts.detail, /Trim to a new MCAP file: 0 of 1 free try used/);
  assert.match(p.opts.detail, /Compare two recordings: 0 of 1 free try used/);
  assert.equal(s.log.external.length, 0);
});
test('the Explorer entry runs the tool on the clicked file (upper-case name)', async () => {
  const dir = ws();
  const s = activate(dir);
  s.ui.quick.push((items) => items.find((i) => i.topic === '/battery/voltage'), (items) => items.find((i) => i.id === 'json'));
  s.ui.save.push(U(s, dir, 'battery.json'));
  const r = await s.vscode.commands.executeCommand('mcapViewer.zovoPro.export', U(s, dir, 'ROVER.MCAP'), [U(s, dir, 'ROVER.MCAP')]);
  assert.equal(r.rows, 30);
  assert.equal(s.log.lastPick.opts.ignoreFocusOut, true);
});
test('a tool without a file argument works on the viewer in front', async () => {
  const dir = ws();
  const s = activate(dir);
  await openEditor(s, path.join(dir, 'demo-rover-ros1.bag'));
  const r = await s.api.tools.exportTopic(undefined, { topic: '/pose', format: 'csv', dest: U(s, dir, 'pose.csv') });
  assert.equal(r.rows, 750);
});
test('the toolbar row lists the 3 Pro tools with 1 free try each; one constant; the proinfo tries key matches', () => {
  const s = activate();
  const reachCfg = require('../src/reach-config');
  assert.deepEqual(reachCfg.tools.map((t) => t.id), ['export', 'trim', 'compare']);
  const pro = require('../src/pro');
  assert.equal(pro.TRIAL_USES, 1);
  const cfg = require('../src/license/config');
  assert.equal(cfg.listing, 'mcap');
  assert.equal(cfg.pro_info.triesKey, pro.TRIAL_KEY);
  assert.equal(reachCfg.triesKey, pro.TRIAL_KEY);
  assert.equal(cfg.pro_info.triesMax, undefined);
  assert.deepEqual(cfg.pro_info.tools.map((t) => t.id), ['export', 'trim', 'compare']);
  assert.deepEqual(Object.keys(s.api.pro.tries()), ['export', 'trim', 'compare']);
  const row = s.api.provider.hooks.reach().rowHtml();
  assert.equal((row.match(/<small>1 free try<\/small>/g) || []).length, 3);
  assert.match(row, /Get Zovo Pro/);
});

// ---------- README and text ----------
const RIVALS = /foxglove|codevilot|gagalo|promethus|lochbrunner|vscode-rosbag|mcap-explorer|mcap-cli|PlotJuggler|rqt_bag|Webviz|rerun\.io/i;
test('README: first screen has the main use, a screenshot of this product, the free list and the price; by Zovo; no rival names', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const first = md.split('\n').slice(0, 32).join('\n');
  assert.match(first, /^# MCAP Viewer & ROS Bag Viewer/);
  assert.match(first, /\(images\/screenshot\.png\)/);
  assert.match(first, /Zovo Pro: USD 19 once/);
  assert.match(md, /by Zovo/i);
  for (const f of ['README.md', 'CHANGELOG.md', 'package.json', 'walkthrough/messages.md', 'walkthrough/related.md', 'src/editor.js', 'src/tools.js', 'src/extension.js', 'src/pro.js', 'src/core/view.js', 'media/viewer.js', 'media/panel.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), RIVALS, f);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'screenshot.png')));
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8'), /^images\/?(\*\*|\*\.png|screenshot)?\s*$/m);
});
test('support links name this listing and related Zovo tools; walkthrough links name products we have', () => {
  const support = require('../src/support');
  assert.equal(support.SELF_ID, 'zovo.zovo-mcap-viewer');
  assert.ok(support.RELATED.length >= 3 && !support.RELATED.includes(support.SELF_ID));
  assert.equal(support.PRO.getPro, 'mcapViewer.getPro');
  const steps = pkg.contributes.walkthroughs[0].steps;
  const links = steps.flatMap((st) => [...st.description.matchAll(/command:extension\.open\?%5B%22([^%]+)%22%5D/g)].map((m) => m[1]));
  assert.deepEqual(links, ['zovo.sqlite-table-viewer', 'zovo.zovo-parquet-viewer', 'zovo.hdf5-netcdf-explorer']);
  const products = path.join(ROOT, '..');
  const ids = new Set(fs.readdirSync(products).map((d) => { try { const p = JSON.parse(fs.readFileSync(path.join(products, d, 'package.json'), 'utf8')); return `${p.publisher}.${p.name}`; } catch (e) { return ''; } }));
  for (const id of links) assert.ok(ids.has(id), id);
});
