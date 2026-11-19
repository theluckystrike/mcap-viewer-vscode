// MCAP Viewer webview: the recording summary, the topic list, pages of decoded messages with a time slider, and a
// plot of one number field. Everything comes from the extension host by postMessage; no network request.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtN = (n) => Number(n).toLocaleString('en-US');
  const fmtHz = (h) => (!h ? '' : h >= 100 ? h.toFixed(0) : h >= 10 ? h.toFixed(1) : h.toFixed(2));
  const st = { info: null, topic: '', items: [], sel: -1, more: false, atStart: true, seekNs: null, reqId: 0, pageId: 0, plotId: 0, series: null, fields: [] };

  function status(t) { $('statusText').textContent = t || ''; }
  function post(m) { vscode.postMessage(m); }
  function startNs() { return BigInt(st.info.startNs); }
  function endNs() { return BigInt(st.info.endNs); }
  function relOf(nsStr) { return Number(BigInt(nsStr) - startNs()) / 1e9; }
  function nsText(ns) { const s = ns.toString().padStart(10, '0'); return `${s.slice(0, -9)}.${s.slice(-9)}`; }

  // ---------- tabs ----------
  function tab(name) {
    for (const b of document.querySelectorAll('#tabs .tab')) b.classList.toggle('sel', b.dataset.tab === name);
    $('overview').hidden = name !== 'overview';
    $('topicView').hidden = name !== 'topic';
    document.body.dataset.tab = name;
    if (name === 'topic') drawPlot();
  }
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    if (b.dataset.tab === 'topic' && !st.topic && st.info && st.info.topics.length) { selectTopic(firstTopic()); return; }
    tab(b.dataset.tab);
  });
  function firstTopic() { const t = st.info.topics.find((x) => x.count > 0 && x.decoder !== 'raw') || st.info.topics.find((x) => x.count > 0) || st.info.topics[0]; return t ? t.topic : ''; }

  // ---------- summary ----------
  function renderInfo(info) {
    st.info = info;
    $('fmt').textContent = `${info.formatLabel}${info.profile ? ` ${info.profile}` : ''} · ${info.sizeText}`;
    $('facts').textContent = `${fmtN(info.messageCount)} messages · ${info.topics.length} topics · ${info.durationSec.toFixed(2)} s`;
    renderTopics();
    const c = info.chunks;
    const comp = Object.keys(c.by).length ? Object.entries(c.by).map(([k, n]) => `${k} ${fmtN(n)}`).join(', ') : 'none';
    const row = (k, v, id) => `<tr><th>${esc(k)}</th><td${id ? ` id="${id}"` : ''}>${v}</td></tr>`;
    const warn = info.warnings.length ? `<ul id="warnings" class="warn">${info.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
    const topicsTable = `<table id="topicTable" class="grid"><thead><tr><th>Topic</th><th>Type</th><th>Encoding</th><th class="num">Messages</th><th class="num">Hz</th><th class="num">First (s)</th><th class="num">Last (s)</th></tr></thead><tbody>${info.topics.map((t) => `<tr data-topic="${esc(t.topic)}"><td><a href="#" class="tlink" data-topic="${esc(t.topic)}">${esc(t.topic)}</a></td><td class="mono">${esc(t.type)}</td><td>${esc(t.messageEncoding)}${t.schemaEncoding ? ` / ${esc(t.schemaEncoding)}` : ''}${t.decoder === 'raw' ? ' <span class="chip warnc" title="' + esc(t.decoderError) + '">bytes</span>' : ''}</td><td class="num">${fmtN(t.count)}</td><td class="num">${fmtHz(t.hz)}</td><td class="num">${t.firstNs ? relOf(t.firstNs).toFixed(3) : ''}</td><td class="num">${t.lastNs ? relOf(t.lastNs).toFixed(3) : ''}</td></tr>`).join('')}</tbody></table>`;
    const schemas = info.schemas.length ? info.schemas.map((s) => `<details class="schema" data-name="${esc(s.name)}"><summary><span class="mono">${esc(s.name || '(no name)')}</span> <span class="muted">${esc(s.encoding)}, ${fmtN(s.size)} bytes, used by ${esc(s.topics.join(', ') || 'no topic')}</span></summary><pre class="mono">${esc(s.text || '(empty)')}</pre></details>`).join('') : '<p class="muted">No schemas.</p>';
    const meta = info.metadata.length ? `<table id="metaTable" class="grid"><thead><tr><th>Name</th><th>Key</th><th>Value</th></tr></thead><tbody>${info.metadata.map((m) => Object.entries(m.entries).map(([k, v]) => `<tr><td>${esc(m.name)}</td><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')).join('')}</tbody></table>` : '<p class="muted">No metadata records.</p>';
    const att = info.attachments.length ? `<table id="attTable" class="grid"><thead><tr><th>Name</th><th>Media type</th><th class="num">Size</th><th class="num">Log time (s)</th></tr></thead><tbody>${info.attachments.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.mediaType)}</td><td class="num">${esc(a.sizeText)}</td><td class="num">${esc(a.log)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No attachments.</p>';
    $('overview').innerHTML = `${warn}
<div class="cols"><table class="kv" id="factsTable">
${row('Format', esc(info.formatLabel), 'fFormat')}${row('Profile', esc(info.profile || '(none)'), 'fProfile')}${row('Written by', esc(info.library || '(not set)'), 'fLibrary')}${row('Size', `${esc(info.sizeText)} (${fmtN(info.size)} bytes)`, 'fSize')}${row('Index', info.indexed ? 'yes, read by ranges' : 'no, read in full', 'fIndexed')}
${row('Messages', fmtN(info.messageCount), 'fMessages')}${row('Topics', fmtN(info.topics.length), 'fTopics')}${row('Duration', `${info.durationSec.toFixed(3)} s`, 'fDuration')}
${row('Start', `${esc(info.start)}${info.startIso ? `<br><span class="muted">${esc(info.startIso)}</span>` : ''}`, 'fStart')}${row('End', `${esc(info.end)}${info.endIso ? `<br><span class="muted">${esc(info.endIso)}</span>` : ''}`, 'fEnd')}
</table><table class="kv" id="chunkTable">
${row('Chunks', fmtN(c.count), 'cCount')}${row('Compression', esc(comp), 'cCompression')}${row('Compressed', esc(c.compressedText), 'cCompressed')}${row('Uncompressed', esc(c.uncompressedText), 'cUncompressed')}${row('Ratio', c.ratio ? `${c.ratio.toFixed(2)} : 1` : '', 'cRatio')}${row('Schemas', fmtN(info.schemas.length), 'cSchemas')}${row('Attachments', fmtN(info.attachments.length), 'cAttachments')}${row('Metadata', fmtN(info.metadata.length), 'cMetadata')}
</table></div>
<h3>Topics</h3>${topicsTable}
<h3>Schemas</h3><div id="schemas">${schemas}</div>
<h3>Metadata</h3>${meta}
<h3>Attachments</h3>${att}`;
    document.body.dataset.state = 'ready';
    status(`${info.name}: ${info.formatLabel}, ${fmtN(info.messageCount)} messages in ${info.topics.length} topics.`);
    post({ type: 'rendered', topics: info.topics.length });
  }

  function renderTopics() {
    const q = $('search').value.trim().toLowerCase();
    const rows = st.info.topics.filter((t) => !q || t.topic.toLowerCase().includes(q) || t.type.toLowerCase().includes(q));
    $('topics').tBodies[0].innerHTML = rows.map((t) => `<tr data-topic="${esc(t.topic)}" class="${t.topic === st.topic ? 'sel' : ''}${t.count ? '' : ' empty'}" title="${esc(t.type)}"><td><div class="tn">${esc(t.topic)}</div><div class="tt muted">${esc(t.type)}</div></td><td class="num">${fmtN(t.count)}</td><td class="num">${fmtHz(t.hz)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No topic matches.</td></tr>';
  }
  $('search').addEventListener('input', renderTopics);
  $('topics').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-topic]'); if (tr) selectTopic(tr.dataset.topic); });
  $('overview').addEventListener('click', (e) => { const a = e.target.closest('a.tlink'); if (a) { e.preventDefault(); selectTopic(a.dataset.topic); } });

  // ---------- topic view ----------
  function selectTopic(topic) {
    if (!topic) return;
    st.topic = topic; st.items = []; st.sel = -1; st.series = null; st.fields = [];
    renderTopics();
    const t = st.info.topics.find((x) => x.topic === topic);
    $('topicHead').innerHTML = `<h2 id="topicName">${esc(topic)}</h2><div class="muted" id="topicFacts"><span class="mono">${esc(t.type)}</span> · ${esc(t.messageEncoding)}${t.schemaEncoding ? ` / ${esc(t.schemaEncoding)}` : ''} · ${fmtN(t.count)} messages${t.hz ? ` · ${fmtHz(t.hz)} Hz` : ''}${t.channels > 1 ? ` · ${t.channels} channels` : ''}</div>${t.decoder === 'raw' ? `<div class="note" id="rawNote">${esc(t.decoderError)}</div>` : ''}`;
    $('field').innerHTML = '<option value="">(loading fields)</option>';
    $('plotFacts').textContent = '';
    tab('topic');
    post({ type: 'select', topic });
    seek(startNs(), true);
    post({ type: 'fields', topic, id: ++st.reqId });
  }

  function setSlider(ns) {
    const s = startNs(); const e = endNs();
    const span = e > s ? e - s : 1n;
    const v = ns <= s ? 0 : ns >= e ? 10000 : Number(((ns - s) * 10000n) / span);
    $('slider').value = String(v);
    $('seekTime').textContent = `${(Number(ns - s) / 1e9).toFixed(3)} s  (${nsText(ns)})`;
  }
  function sliderNs() {
    const s = startNs(); const e = endNs();
    return s + ((e - s) * BigInt($('slider').value)) / 10000n;
  }
  function seek(ns, first) {
    st.seekNs = ns;
    setSlider(ns);
    requestPage({ fromNs: ns.toString(), skip: 0, selectFirst: true, first });
    drawPlot();
  }
  function requestPage(q) {
    const id = ++st.pageId;
    st.pending = { id, selectFirst: !!q.selectFirst, selectLast: !!q.selectLast };
    $('list').classList.add('loading');
    post({ type: 'page', id, topic: st.topic, fromNs: q.fromNs, skip: q.skip || 0, back: !!q.back, count: 50 });
  }
  let sliderTimer = null;
  $('slider').addEventListener('input', () => { const ns = sliderNs(); setSlider(ns); clearTimeout(sliderTimer); sliderTimer = setTimeout(() => seek(ns), 120); });
  $('slider').addEventListener('change', () => { clearTimeout(sliderTimer); seek(sliderNs()); });
  $('next').addEventListener('click', () => {
    if (!st.items.length || !st.more) return;
    const last = st.items[st.items.length - 1].ns;
    const skip = st.items.filter((i) => i.ns === last).length;
    requestPage({ fromNs: last, skip, selectFirst: true });
  });
  $('prev').addEventListener('click', () => {
    if (!st.items.length || st.atStart) return;
    requestPage({ fromNs: st.items[0].ns, back: true, selectLast: true });
  });

  function preview(it) {
    if (it.error && it.hex !== undefined) return it.hex.split('\n')[0];
    const s = JSON.stringify(it.value, (k, v) => (v && typeof v === 'object' && v.__more ? `+${v.__more}` : v));
    return s.length > 160 ? `${s.slice(0, 160)}...` : s;
  }
  function renderPage(p) {
    st.items = p.items; st.more = p.more; st.atStart = p.atStart;
    const sel = st.pending && st.pending.selectLast ? p.items.length - 1 : 0;
    $('list').classList.remove('loading');
    $('list').tBodies[0].innerHTML = p.items.map((it, i) => `<tr data-i="${i}" data-ns="${it.ns}"><td class="num">${it.rel.toFixed(3)}</td><td class="num">${fmtN(it.size)}</td><td class="mono pv">${esc(preview(it))}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No messages from this time on.</td></tr>';
    $('prev').disabled = p.atStart || !p.items.length;
    $('next').disabled = !p.more;
    if (p.items.length) select(sel); else { st.sel = -1; $('value').textContent = ''; }
    document.body.dataset.page = String(st.pageId);
  }
  function pretty(v, ind) {
    const pad = '  '.repeat(ind);
    if (v === null) return 'null';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      const simple = v.every((x) => x === null || typeof x !== 'object' || x.__more);
      const parts = v.map((x) => (x && typeof x === 'object' && x.__more ? `... ${x.__more} more${x.__type ? ` (${x.__type}[${x.__length}])` : ''}` : pretty(x, ind + 1)));
      if (simple && parts.join(', ').length < 100) return `[${parts.join(', ')}]`;
      return `[\n${parts.map((p) => `${pad}  ${p}`).join(',\n')}\n${pad}]`;
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) return '{}';
      if (keys.length === 2 && 'sec' in v && ('nsec' in v || 'nanosec' in v)) {
        const ns = 'nsec' in v ? v.nsec : v.nanosec;
        return `{ sec: ${v.sec}, ${'nsec' in v ? 'nsec' : 'nanosec'}: ${ns} }`;
      }
      return `{\n${keys.map((k) => `${pad}  ${k}: ${pretty(v[k], ind + 1)}`).join('\n')}\n${pad}}`;
    }
    if (typeof v === 'string') return JSON.stringify(v);
    return String(v);
  }
  function select(i) {
    st.sel = i;
    for (const tr of $('list').tBodies[0].rows) tr.classList.toggle('sel', Number(tr.dataset.i) === i);
    const it = st.items[i];
    if (!it) return;
    const head = `log time ${relOf(it.ns).toFixed(6)} s (${nsText(BigInt(it.ns))})${it.publish ? `, publish time ${it.publish}` : ''}, ${fmtN(it.size)} bytes${it.sequence ? `, sequence ${it.sequence}` : ''}\n\n`;
    $('value').textContent = head + (it.error ? `${it.error}\n\n${it.hex || ''}` : pretty(it.value, 0));
    $('value').dataset.ns = it.ns;
    const tr = $('list').tBodies[0].rows[i];
    if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest' });
    st.cursorNs = BigInt(it.ns);
    drawPlot();
  }
  $('list').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-i]'); if (tr) select(Number(tr.dataset.i)); });
  $('listBox').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && st.sel < st.items.length - 1) { select(st.sel + 1); e.preventDefault(); }
    if (e.key === 'ArrowUp' && st.sel > 0) { select(st.sel - 1); e.preventDefault(); }
  });
  $('listBox').tabIndex = 0;

  // ---------- plot ----------
  function renderFields(f) {
    if (f.topic !== st.topic) return;
    st.fields = f.paths || [];
    if (!st.fields.length) { $('field').innerHTML = `<option value="">${esc(f.error ? 'no decoder' : 'no number fields')}</option>`; $('plotFacts').textContent = f.error || ''; drawPlot(); return; }
    const pick = st.fields.find((p) => !/^header\.|covariance|^orientation\.[xyw]$|stamp/.test(p)) || st.fields[0];
    $('field').innerHTML = st.fields.map((p) => `<option value="${esc(p)}"${p === pick ? ' selected' : ''}>${esc(p)}</option>`).join('');
    requestPlot(pick);
  }
  function requestPlot(path) {
    if (!path) return;
    const id = ++st.plotId;
    $('plotFacts').textContent = 'Reading...';
    $('plot').dataset.state = 'loading';
    post({ type: 'plot', id, topic: st.topic, path });
  }
  $('field').addEventListener('change', () => requestPlot($('field').value));
  function drawPlot() {
    const c = $('plot');
    if (!c || $('topicView').hidden) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, c.clientWidth || 800); const h = Math.max(120, c.clientHeight || 220);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.body);
    const fg = css.getPropertyValue('--vscode-foreground').trim() || '#ccc';
    const grid = css.getPropertyValue('--vscode-panel-border').trim() || 'rgba(128,128,128,.35)';
    const line = css.getPropertyValue('--vscode-charts-blue').trim() || '#3794ff';
    const cursor = css.getPropertyValue('--vscode-charts-orange').trim() || '#d18616';
    g.clearRect(0, 0, w, h);
    g.font = '11px sans-serif'; g.fillStyle = fg; g.strokeStyle = grid; g.lineWidth = 1;
    const L = 56; const R = 10; const T = 10; const B = 22;
    const s = st.series;
    const dur = st.info ? Math.max(1e-9, Number(endNs() - startNs()) / 1e9) : 1;
    g.strokeRect(L + 0.5, T + 0.5, w - L - R, h - T - B);
    for (let k = 0; k <= 4; k++) { const x = L + ((w - L - R) * k) / 4; g.fillText(`${((dur * k) / 4).toFixed(dur < 10 ? 2 : 1)} s`, Math.min(x - 10, w - 50), h - 6); }
    if (!s || !s.xs.length) { g.fillText(s ? (s.error || 'No values to plot.') : 'Pick a number field.', L + 10, T + 20); c.dataset.points = '0'; return; }
    let lo = s.min; let hi = s.max;
    if (hi === lo) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
    const X = (t) => L + ((w - L - R) * t) / dur;
    const Y = (v) => T + (h - T - B) * (1 - (v - lo) / (hi - lo));
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4; const y = Y(v);
      g.globalAlpha = 0.35; g.beginPath(); g.moveTo(L, y + 0.5); g.lineTo(w - R, y + 0.5); g.stroke(); g.globalAlpha = 1;
      g.fillText(Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : v.toFixed(Math.abs(hi - lo) < 10 ? 3 : 1), 2, y + 4);
    }
    g.strokeStyle = line; g.lineWidth = 1.4; g.beginPath();
    for (let i = 0; i < s.xs.length; i++) { const x = X(s.xs[i]); const y = Y(s.ys[i]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
    if (s.xs.length < 60) { g.fillStyle = line; for (let i = 0; i < s.xs.length; i++) { g.beginPath(); g.arc(X(s.xs[i]), Y(s.ys[i]), 2.2, 0, 7); g.fill(); } }
    const cur = st.cursorNs !== undefined && st.cursorNs !== null ? st.cursorNs : st.seekNs;
    if (cur !== null && cur !== undefined) {
      const x = X(Number(cur - startNs()) / 1e9);
      g.strokeStyle = cursor; g.lineWidth = 1; g.beginPath(); g.moveTo(x + 0.5, T); g.lineTo(x + 0.5, h - B); g.stroke();
    }
    c.dataset.points = String(s.xs.length);
  }
  $('plot').addEventListener('click', (e) => {
    if (!st.info) return;
    const r = $('plot').getBoundingClientRect();
    const L = 56; const R = 10;
    const f = Math.min(1, Math.max(0, (e.clientX - r.left - L) / (r.width - L - R)));
    const s = startNs(); const span = endNs() - s;
    seek(s + (span * BigInt(Math.round(f * 1e6))) / 1000000n);
  });
  window.addEventListener('resize', () => drawPlot());

  // ---------- messages from the extension host ----------
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'init':
        if (m.kind !== 'rec') {
          document.body.dataset.state = 'error';
          $('tabs').hidden = true;
          $('fmt').textContent = 'Not opened';
          $('msg').hidden = false;
          $('msg').innerHTML = `<p id="errText">${esc(m.error)}</p><p><button class="tb" id="openText">Open in the text editor</button></p>`;
          $('overview').innerHTML = '';
          $('topics').tBodies[0].innerHTML = '';
          status(`${m.name}: ${m.error}`);
          return;
        }
        $('msg').hidden = true;
        renderInfo(m.info);
        if (st.topic && m.info.topics.some((t) => t.topic === st.topic)) selectTopic(st.topic);
        return;
      case 'page':
        if (m.id !== st.pageId || m.topic !== st.topic) return;
        renderPage(m);
        return;
      case 'fields': renderFields(m); return;
      case 'plot':
        if (m.id !== st.plotId || m.topic !== st.topic) return;
        st.series = m;
        $('plot').dataset.state = 'done';
        $('plot').dataset.path = m.path;
        $('plot').dataset.total = String(m.total);
        $('plotFacts').textContent = m.error ? m.error : `${fmtN(m.total)} values${m.total ? `, min ${m.min.toPrecision(6)}, max ${m.max.toPrecision(6)}` : ''}${m.missing ? `, ${fmtN(m.missing)} messages without it` : ''}${m.truncated ? ', first 500,000 messages' : ''}${m.xs.length < m.total ? `, ${fmtN(m.xs.length)} points drawn` : ''}`;
        drawPlot();
        return;
      case 'failed':
        status(`Could not ${m.request === 'plot' ? 'plot the field' : 'read the messages'}: ${m.error}`);
        if (m.request === 'page') { $('list').classList.remove('loading'); $('list').tBodies[0].innerHTML = `<tr><td colspan="3" class="err">${esc(m.error)}</td></tr>`; }
        return;
      default:
    }
  });
  document.addEventListener('click', (e) => { if (e.target && e.target.id === 'openText') post({ type: 'openText' }); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && st.sel >= 0 && document.activeElement === $('listBox')) {
      const it = st.items[st.sel];
      if (it) post({ type: 'copy', what: 'the message as JSON', text: JSON.stringify(it.value, null, 2) });
    }
  });
  const ft = document.getElementById('zovo-footer');
  if (ft && ft.innerHTML.trim()) $('footer').innerHTML = ft.innerHTML;
  post({ type: 'ready' });
}());
