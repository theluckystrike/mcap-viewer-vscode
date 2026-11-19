'use strict';
// Read-only custom editor mcapViewer.editor (default for *.mcap and *.bag). The extension host opens the recording
// (a local file with random-access reads, any other file system through VS Code's file API), and the webview asks
// for what it shows: the summary, pages of decoded messages, field lists and plot series. The webview has no network
// access (CSP default-src 'none'). A file that is not a recording gets a plain note in the view: no popup, and the
// viewer never reopens a tab by itself.
const vscode = require('vscode');
const path = require('path');
const R = require('./core/recording');
const Vw = require('./core/view');
const { editorHtml } = require('./html');
const support = require('./support');

const VIEW = 'mcapViewer.editor';
const PREFIX = 'mcapViewer';
const REC_RE = /\.(mcap|bag)$/i;
const MAX_REMOTE_BYTES = 1024 * 1024 * 1024;
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

/** Opens the recording of a URI: random access for local files, the whole file through VS Code otherwise. */
async function openUri(uri) {
  if (uri.scheme === 'file') return R.openPath(uri.fsPath);
  let size = 0;
  try { const st = await vscode.workspace.fs.stat(uri); size = st.size; } catch (e) { size = 0; }
  if (size > MAX_REMOTE_BYTES) throw new R.RecordingError(`This file is ${Vw.sizeText(size)}. Files over 1 GB open only from a local disk.`, 'large');
  const bytes = await vscode.workspace.fs.readFile(uri);
  return R.openRecording(R.bufferSource(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
}

class RecDocument {
  constructor(uri) { this.uri = uri; this.panels = new Set(); this.rec = null; this.error = null; this.selectedTopic = ''; this.rendered = null; }
  get name() { return path.posix.basename(this.uri.path); }
  async load() {
    try { this.rec = await openUri(this.uri); this.error = null; } catch (e) {
      this.rec = null;
      this.error = { kind: (e && e.kind) || 'error', message: String((e && e.message) || e) };
    }
  }
  dispose() { if (this.rec) { const r = this.rec; this.rec = null; r.close().then(undefined, () => false); } }
}

class RecEditorProvider {
  constructor(context, hooks = {}) {
    this.context = context;
    this.hooks = hooks;
    this.docs = new Set();
    this.active = null;
    this.activePanel = null;
    this._success = new WeakSet();
  }
  dispose() { for (const d of this.docs) d.dispose(); this.docs.clear(); }

  async openCustomDocument(uri) {
    const doc = new RecDocument(uri);
    await doc.load();
    this.docs.add(doc);
    return { uri, dispose: () => { this.docs.delete(doc); doc.dispose(); if (this.active === doc) this.active = null; }, _doc: doc };
  }

  async resolveCustomEditor(handle, panel) {
    const doc = handle._doc;
    doc.panels.add(panel);
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const reach = this.hooks.reach ? this.hooks.reach() : null;
    panel.webview.options = {
      enableScripts: true, localResourceRoots: [media],
      enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)),
    };
    panel.webview.html = editorHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title: doc.name,
      head: reach ? (n) => reach.headHtml(n) : undefined,
      showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    const setActive = () => { if (panel.active) { this.active = doc; this.activePanel = panel; } };
    setActive();
    panel.onDidChangeViewState(setActive);
    panel.onDidDispose(() => { doc.panels.delete(panel); if (this.activePanel === panel) { this.activePanel = null; if (this.active === doc) this.active = null; } });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      try { await this.onMessage(doc, panel, m); } catch (e) {
        this.send(panel.webview, { type: 'failed', id: m.id, request: m.type, error: String((e && e.message) || e) });
      }
    });
  }

  send(webview, msg) { try { const r = webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } }

  init(doc, webview) {
    const base = { type: 'init', name: doc.name, settings: { showPro: setting('showProTools', true) !== false } };
    if (!doc.rec) {
      const e = doc.error || { kind: 'error', message: 'The file could not be read.' };
      this.send(webview, { ...base, kind: e.kind, error: e.message });
      if (e.kind === 'error' && this.hooks.onFailure) this.hooks.onFailure(doc);
      return;
    }
    this.send(webview, { ...base, kind: 'rec', info: Vw.infoView(doc.rec, doc.name) });
  }

  /** The panel showing uri (the active one first), or null. */
  panelFor(uri) {
    const key = uri.toString();
    if (this.active && this.active.uri.toString() === key && this.activePanel) return { doc: this.active, panel: this.activePanel };
    for (const d of this.docs) if (d.uri.toString() === key) for (const p of d.panels) return { doc: d, panel: p };
    return null;
  }

  async onMessage(doc, panel, m) {
    const w = panel.webview;
    switch (m.type) {
      case 'ready': this.init(doc, w); return;
      case 'rendered':
        doc.rendered = { topics: Number(m.topics) || 0, at: Date.now() };
        if (!this._success.has(doc) && doc.rec) { this._success.add(doc); if (this.hooks.onSuccess) this.hooks.onSuccess(doc); }
        return;
      case 'page': {
        if (!doc.rec) return;
        const r = await Vw.page(doc.rec, { topic: String(m.topic), fromNs: m.fromNs, skip: m.skip, count: m.count, back: !!m.back });
        this.send(w, { type: 'page', id: m.id, ...r });
        return;
      }
      case 'fields': {
        if (!doc.rec) return;
        this.send(w, { type: 'fields', id: m.id, ...(await Vw.fieldsOf(doc.rec, String(m.topic))) });
        return;
      }
      case 'plot': {
        if (!doc.rec) return;
        this.send(w, { type: 'plot', id: m.id, ...(await Vw.plotSeries(doc.rec, String(m.topic), String(m.path))) });
        return;
      }
      case 'select': doc.selectedTopic = typeof m.topic === 'string' ? m.topic : ''; return;
      case 'copy':
        if (typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text.slice(0, 2000000)); vscode.window.setStatusBarMessage(`Copied ${m.what || 'the message'}`, 3000); }
        return;
      case 'openText': await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default'); return;
      default:
    }
  }
}

module.exports = { RecEditorProvider, RecDocument, openUri, VIEW, PREFIX, REC_RE };
