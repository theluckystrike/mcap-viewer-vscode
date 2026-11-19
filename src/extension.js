'use strict';
// MCAP Viewer & ROS Bag Viewer by Zovo: opens .mcap recordings and ROS 1 .bag files with their topics, decoded
// messages, a time slider and a plot. No network, no telemetry. Activation shows nothing: no message, no popup. The
// viewer opens only for files the user opens, and it never reopens a tab in another editor by itself.
const vscode = require('vscode');
const { RecEditorProvider, VIEW, REC_RE } = require('./editor');
const { createTools } = require('./tools');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const PREFIX = 'mcapViewer';
const EXT_ID = 'zovo.zovo-mcap-viewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'MCAP Viewer' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  const reach = createReach({ vscode, ...reachConfig, maximum: pro.TRIAL_USES, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  sub(pro.onDidChange(() => reach.refresh()));

  const samples = vscode.Uri.joinPath(context.extensionUri, 'samples').toString();
  const provider = new RecEditorProvider(context, {
    reach: () => reach,
    onSuccess: (doc) => { if (!doc.uri.toString().startsWith(samples)) rating.success(doc.uri); },
    onFailure: () => rating.failure(),
  });
  sub(vscode.window.registerCustomEditorProvider(VIEW, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));
  sub(provider);
  const tools = createTools({ context, provider, pro, reach });

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); return undefined; }
  }));
  const target = (uri) => (uri && uri.scheme ? uri : undefined);
  const extraOf = (x) => (x && typeof x === 'object' && !x.scheme && !Array.isArray(x) ? x : {});
  const sample = (name) => vscode.Uri.joinPath(context.extensionUri, 'samples', name);
  reg(`${PREFIX}.openWithViewer`, (uri) => {
    const u = uri && uri.scheme ? uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    if (!u || !REC_RE.test(u.path)) { vscode.window.showInformationMessage('Select a .mcap or .bag file first.'); return undefined; }
    return vscode.commands.executeCommand('vscode.openWith', u, VIEW);
  });
  reg(`${PREFIX}.openSample`, () => vscode.commands.executeCommand('vscode.openWith', sample('demo-rover-ros2.mcap'), VIEW));
  reg(`${PREFIX}.openSampleBag`, () => vscode.commands.executeCommand('vscode.openWith', sample('demo-rover-ros1.bag'), VIEW));
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.exportTopic`, reach.wrap((uri, extra) => tools.exportTopic(target(uri), extraOf(extra))));
  reg(`${PREFIX}.trim`, reach.wrap((uri, extra) => tools.trim(target(uri), extraOf(extra))));
  reg(`${PREFIX}.compare`, reach.wrap((uri, extra) => tools.compare(target(uri), extraOf(extra))));
  sub(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) reach.refresh(); }));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { provider, tools, pro };
}

function deactivate() {}

module.exports = { activate, deactivate };
