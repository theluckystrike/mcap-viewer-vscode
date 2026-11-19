'use strict';
// Zovo Pro for the MCAP Viewer, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license by apply.sh). Three Pro tools, 1 free try each on this computer. A try counts only after the
// tool showed its result (the export file written, the trimmed MCAP file written, the comparison drawn); Escape,
// Cancel or an error never uses one. Every click on a Pro tool checks the count again, whatever the file: the 2nd use
// opens the Pro panel, on the same file or another one.
// Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no tries
// left. The 7-day trial (module TRIAL2) starts only from that panel's first button.
const { createLicense } = require('./license');
const { currentSurface } = require('./reach');

const SKU = 'mcap-viewer-pro';
// OWNER DECISION 15 Nov (TRIES1): 1 free try per Pro tool. The only place this listing sets the number.
const TRIAL_USES = 1;
const TRIAL_KEY = 'mcapViewer.proTrial';

const FEATURES = {
  export: {
    title: 'Export a topic to CSV or JSON',
    detail: 'Saves every message of a topic as CSV (one column per field), JSON or JSON Lines, with its log time.',
  },
  trim: {
    title: 'Trim to a new MCAP file',
    detail: 'Saves a time range and the topics you pick as a new MCAP file, messages copied byte for byte. A ROS 1 bag becomes an MCAP file.',
  },
  compare: {
    title: 'Compare two recordings',
    detail: 'Compares two MCAP or bag files topic by topic: types, message counts and rates, saved as Markdown or CSV.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function surfaceOf(arg) {
  const s = currentSurface();
  if (s) return s;
  if (arg && typeof arg === 'object' && typeof arg.surface === 'string') return arg.surface;
  return undefined;
}

function createPro({ vscode, context, license, prefix = 'mcapViewer', productName = 'MCAP Viewer' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  // Counts never go down in a session: globalState can hand back an older value for a moment after a write, so the
  // highest count seen here wins.
  const seen = {};
  const used = (f) => Math.max(Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0, seen[f] || 0);
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed or in the trial, or a free try left). Otherwise the one panel. */
  async function allowed(f, arg) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    const surface = surfaceOf(arg);
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, toolId: f, triesUsed: used(f), ...(surface ? { surface } : {}) }));
  }

  /** After the tool showed its result: counts one free try (nothing when licensed or in the trial). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    for (const k of Object.keys(seen)) m[k] = Math.max(Number(m[k]) || 0, seen[k]);
    m[f] = used(f) + 1;
    seen[f] = m[f];
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left, used,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS, surfaceOf };
