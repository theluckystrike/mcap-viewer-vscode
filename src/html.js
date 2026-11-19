'use strict';
// Webview HTML for the viewer and the Pro tool panel. No vscode import, so tests can check the CSP: no remote origin,
// no connect-src, no worker or blob source, scripts only with the page nonce.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'mcapViewer';
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data:`, `font-src ${cspSource}`].join('; ');
}

function head(p, n) {
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return { footer, html: `<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>` };
}

/** p: { cspSource, scriptUri, styleUri, title, showSupportLinks, head?(nonce) } */
function editorHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const h = head(p, n);
  return `<!DOCTYPE html>
<html lang="en">
<head>
${h.html}
</head>
<body>
<div id="toolbar" role="toolbar" aria-label="MCAP viewer">
  <span id="fmt" class="chip" title="Format and size"></span>
  <span id="facts" class="muted"></span>
  <span class="grp" id="tabs"><button class="tb tab sel" id="tabOverview" data-tab="overview">Overview</button><button class="tb tab" id="tabTopic" data-tab="topic">Messages and plot</button></span>
</div>
<div id="app">
  <aside id="side" aria-label="Topics">
    <input id="search" type="search" spellcheck="false" placeholder="Filter topics and types" aria-label="Filter topics">
    <table id="topics"><thead><tr><th>Topic</th><th class="num">Messages</th><th class="num">Hz</th></tr></thead><tbody></tbody></table>
  </aside>
  <main id="main">
    <div id="msg" role="alert" hidden></div>
    <section id="overview" aria-label="Recording facts"></section>
    <section id="topicView" hidden aria-label="Messages of the topic">
      <div id="topicHead"></div>
      <div class="seek">
        <button class="tb" id="prev" title="The page before">&lt;</button>
        <input id="slider" type="range" min="0" max="10000" step="1" value="0" aria-label="Time in the recording">
        <button class="tb" id="next" title="The next page">&gt;</button>
        <span id="seekTime" class="mono"></span>
      </div>
      <div id="split">
        <div id="listBox"><table id="list"><thead><tr><th class="num">Time (s)</th><th class="num">Bytes</th><th>Preview</th></tr></thead><tbody></tbody></table></div>
        <div id="detail"><pre id="value" class="mono" aria-label="Decoded message"></pre></div>
      </div>
      <div id="plotBox">
        <div class="plotBar"><label for="field">Plot</label> <select id="field" aria-label="Field to plot"></select> <span id="plotFacts" class="muted"></span></div>
        <canvas id="plot" width="800" height="220" aria-label="Plot of the field over time"></canvas>
      </div>
    </section>
  </main>
</div>
<div id="status"><span id="statusText"></span></div>
<div id="footer"></div>
<template id="zovo-footer">${h.footer}</template>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

/** Panel of a Pro tool. p: { cspSource, scriptUri, styleUri, title, head?(nonce), showSupportLinks } */
function panelHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const h = head(p, n);
  return `<!DOCTYPE html>
<html lang="en">
<head>
${h.html}
</head>
<body class="panel">
<div id="toolbar" role="toolbar"><strong id="title"></strong><span id="actions"></span></div>
<div id="app" class="panelApp">
  <div id="report"><p class="muted">Working...</p></div>
</div>
<div id="footer">${h.footer}</div>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { editorHtml, panelHtml, csp };
