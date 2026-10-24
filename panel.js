/* Zigbee map panel for Home Assistant (panel_custom).
 * Pulls the Zigbee2MQTT raw network map over HA's own websocket (mqtt/subscribe + mqtt.publish),
 * renders it as a d3 force graph with pinnable nodes. Admin user required (mqtt/subscribe is admin-only).
 * Files: /config/www/zigbee_map/panel.js + d3.v7.min.js ; config: yamls/zigbee_map_panel.yaml
 */
const BASE = new URL('.', import.meta.url).href;
const REL = { 0: 'parent', 1: 'child', 2: 'sibling', 3: 'none', 4: 'previous child' };
const LS = { map: 'z2m_panel_map_v1', pos: 'z2m_map_positions_v1', spring: 'z2m_map_spring' };

let d3Ready;
function loadD3() {
  if (window.d3) return Promise.resolve(window.d3);
  d3Ready ??= new Promise((res, rej) => { const s = document.createElement('script'); s.src = BASE + 'd3.v7.min.js'; s.onload = () => res(window.d3); s.onerror = () => rej(new Error('d3 failed to load from ' + s.src)); document.head.appendChild(s); });
  return d3Ready;
}
// one slider: v < -5 hides links with LQI <= |v| (weak), v > 5 hides links with LQI >= v (strong), around 0 = off
const hideOk = (lq, v) => v <= -10 ? lq > -v : v >= 10 ? lq < v : true;
const hideLabel = v => v <= -10 ? `≤ ${-v}` : v >= 10 ? `≥ ${v}` : 'off';
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

// raw map -> {nodes, links}; source = neighbour, target = reporting device, lqi = what the target hears from the source
function mergeMap(map) {
  const nodes = map.nodes.map(n => ({ id: n.ieeeAddr, name: n.friendlyName || n.ieeeAddr, type: n.type, nwk: n.networkAddress, lastSeen: n.lastSeen ?? null,
    model: n.definition?.model ?? '', vendor: n.definition?.vendor ?? '', desc: n.definition?.description ?? '' }));
  const known = new Set(nodes.map(n => n.id));
  for (const l of map.links) for (const a of [l.sourceIeeeAddr, l.targetIeeeAddr]) if (!known.has(a)) { known.add(a); nodes.push({ id: a, name: a + ' (not in device list)', type: 'Unknown', nwk: null, lastSeen: null }); }
  const pairs = {};
  for (const l of map.links) {
    const [a, b] = [l.sourceIeeeAddr, l.targetIeeeAddr].sort();
    const p = pairs[a + '|' + b] ??= { source: a, target: b, hear: {}, rel: {}, routes: [] };
    p.hear[l.targetIeeeAddr] = l.lqi; p.rel[l.targetIeeeAddr] = l.relationship;
    if (l.routes?.length) p.routes.push(...l.routes.map(r => ({ via: l.targetIeeeAddr, to: r.destinationAddress, status: r.status })));
  }
  const links = Object.values(pairs).map(p => ({ source: p.source, target: p.target, lqS: p.hear[p.source] ?? null, lqT: p.hear[p.target] ?? null, relS: p.rel[p.source] ?? null, relT: p.rel[p.target] ?? null, routes: p.routes }));
  return { nodes, links };
}

const STYLE = `
  :host { display:block; height:100vh; background:var(--primary-background-color,#1c2027); color:var(--primary-text-color,#dfe3ea); font:13px/1.4 var(--paper-font-body1_-_font-family,system-ui,sans-serif); --red:#e5484d; --orange:#f5a623; --green:#46c36a; --blue:#6ea8fe; --yellow:#ffd60a; --muted:var(--secondary-text-color,#8a93a3); --panel:var(--card-background-color,#262b34); --bgc:var(--primary-background-color,#1c2027); }
  #wrap { position:relative; height:100%; overflow:hidden; }
  #bar { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; padding:6px 10px; background:var(--panel); border-bottom:1px solid var(--divider-color,#333); }
  #bar label { display:flex; gap:5px; align-items:center; white-space:nowrap; }
  #bar input[type=text] { background:var(--bgc); color:inherit; border:1px solid var(--divider-color,#444); border-radius:4px; padding:3px 6px; width:150px; }
  #bar input[type=range] { width:90px; }
  #bar input#hide { width:150px; }
  #bar button { background:var(--bgc); color:inherit; border:1px solid var(--divider-color,#444); border-radius:4px; padding:3px 8px; cursor:pointer; }
  #bar button:hover { border-color:#888; }
  #bar button.primary { border-color:var(--primary-color,#03a9f4); color:var(--primary-color,#03a9f4); }
  #status { color:var(--muted); margin-left:auto; }
  #legend { position:absolute; left:10px; bottom:10px; background:var(--panel); border:1px solid var(--divider-color,#333); border-radius:6px; padding:6px 9px; font-size:11px; color:var(--muted); max-width:min(900px,calc(100% - 40px)); }
  #legend span.sw { display:inline-block; width:20px; height:3px; vertical-align:middle; margin-right:5px; }
  #tip { position:absolute; pointer-events:none; background:var(--panel); color:inherit; border:1px solid var(--divider-color,#444); border-radius:6px; padding:6px 9px; font-size:12px; max-width:380px; display:none; white-space:pre-line; z-index:3; box-shadow:0 2px 8px rgba(0,0,0,.4); }
  svg { position:absolute; inset:0; width:100%; height:100%; cursor:grab; }
  svg:active { cursor:grabbing; }
  #canvas { position:relative; flex:1; height:calc(100% - var(--barh,44px)); }
  .link { stroke-linecap:round; cursor:help; }
  .link.dim, .node.dim, .lql.dim { opacity:0.12; }
  .lql { font-size:9px; fill:var(--primary-text-color,#c7cdd8); paint-order:stroke; stroke:var(--bgc); stroke-width:3px; pointer-events:none; }
  .node text { font-size:11px; fill:var(--primary-text-color,#dfe3ea); paint-order:stroke; stroke:var(--bgc); stroke-width:3px; pointer-events:none; }
  .node.end text { font-size:9.5px; fill:var(--muted); }
  .node .shape, .node .ring { cursor:move; }
  .node.pinned .shape { stroke:var(--primary-text-color,#fff); }
  .node.stale .ring { stroke:var(--red); stroke-dasharray:3 2; }
  .node.sel .shape { stroke:var(--yellow); stroke-width:3px; }
  ha-menu-button { --mdc-icon-button-size:36px; }
`;

const BAR = `
  <ha-menu-button></ha-menu-button>
  <button id="pull" class="primary">pull fresh map</button>
  <label><input type="checkbox" id="showEnd"> end devices</label>
  <label><input type="checkbox" id="showOne"> one-sided / stale links</label>
  <label><input type="checkbox" id="showLql" checked> LQI labels</label>
  <label title="left: hide weak links (LQI ≤ n) · middle: show all · right: hide strong links (LQI ≥ n)">hide <input type="range" id="hide" min="-255" max="255" value="0" step="5"> <span id="hideV">off</span></label>
  <label>spring <input type="range" id="spring" min="0.3" max="3" value="1" step="0.05"> <span id="springV">1.0</span></label>
  <label>find <input type="text" id="find" placeholder="node name…"></label>
  <button id="unpin">unpin all</button>
  <button id="relayout">re-layout</button>
  <button id="png">save PNG</button>
  <span id="status"></span>`;

const LEGEND = `
  <div><span class="sw" style="background:var(--green)"></span>LQI ≥ 80 &nbsp; <span class="sw" style="background:var(--orange)"></span>50–79 &nbsp; <span class="sw" style="background:var(--red)"></span>&lt; 50 &nbsp; <span class="sw" style="height:0;border-top:2px dashed #999"></span>one side only / 0</div>
  <div>label a / b = what the left-hand node hears / what the right-hand node hears (hover for names) · drag pins a node, double-click unpins · click a node to isolate its neighbours, click background to clear · yellow = coordinator, square = router, dot = end device, red dashed ring = not seen for &gt; 24 h</div>`;

class ZigbeeMapPanel extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }); this._hass = null; this._built = false; this.selected = null; this.data = null; }
  set hass(h) { this._hass = h; const mb = this.shadowRoot.querySelector('ha-menu-button'); if (mb) { mb.hass = h; mb.narrow = this._narrow; } }
  get hass() { return this._hass; }
  set narrow(n) { this._narrow = n; const mb = this.shadowRoot.querySelector('ha-menu-button'); if (mb) mb.narrow = n; }
  set panel(p) { this._panel = p; }
  get baseTopic() { return this._panel?.config?.base_topic || 'zigbee2mqtt'; }

  connectedCallback() { if (!this._built) { this._built = true; this.build(); } }

  async build() {
    const r = this.shadowRoot;
    r.innerHTML = `<style>${STYLE}</style><div id="wrap"><div id="bar">${BAR}</div><div id="canvas"><svg></svg><div id="legend">${LEGEND}</div><div id="tip"></div></div></div>`;
    const mb = r.querySelector('ha-menu-button'); mb.hass = this._hass; mb.narrow = this._narrow;
    this.$ = id => r.getElementById(id);
    this.$('pull').onclick = () => this.pull();
    try { await loadD3(); } catch (e) { this.$('status').textContent = e.message; return; }
    this.initGraph();
    const cached = lsGet(LS.map, null);
    if (cached) { this.setMap(cached.map, cached.fetchedAt); this.$('status').textContent += ' (cached in this browser)'; }
    else this.$('status').textContent = 'no map yet, press "pull fresh map"';
    new ResizeObserver(() => this.onResize()).observe(this.$('canvas'));
    this.onResize();
  }
  onResize() { const bar = this.$('bar'); if (bar) { const h = bar.offsetHeight + 'px'; if (this._barh !== h) { this._barh = h; this.style.setProperty('--barh', h); } } if (this.sim && this.data) { const c = this.$('canvas'); this.sim.force('center', d3.forceCenter(c.clientWidth / 2, c.clientHeight / 2)); } }

  async pull() {
    const h = this._hass; if (!h) return;
    const st = this.$('status'), btn = this.$('pull');
    btn.disabled = true; st.textContent = `requesting raw map on ${this.baseTopic}… (can take a few minutes)`;
    const t0 = Date.now(); let unsub = null;
    const tick = setInterval(() => { st.textContent = `waiting for ${this.baseTopic}/bridge/response/networkmap… ${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
    const done = () => { clearInterval(tick); btn.disabled = false; if (unsub) { try { unsub(); } catch (e) {} unsub = null; } clearTimeout(to); };
    const to = setTimeout(() => { done(); st.textContent = 'timeout: no response in 5 min (is Z2M busy, is the base topic right?)'; }, 300000);
    try {
      unsub = await h.connection.subscribeMessage(msg => {
        let r; try { r = JSON.parse(msg.payload); } catch (e) { return; }
        if (r.status !== 'ok') { done(); st.textContent = 'Z2M error: ' + (r.error || 'unknown'); return; }
        done();
        const fetchedAt = new Date().toISOString();
        lsSet(LS.map, { fetchedAt, map: r.data.value });
        this.setMap(r.data.value, fetchedAt);
      }, { type: 'mqtt/subscribe', topic: `${this.baseTopic}/bridge/response/networkmap` });
      await h.callService('mqtt', 'publish', { topic: `${this.baseTopic}/bridge/request/networkmap`, payload: JSON.stringify({ type: 'raw', routes: true }) });
    } catch (e) { done(); st.textContent = 'failed: ' + (e.message || JSON.stringify(e)) + ' (admin user needed for mqtt/subscribe)'; }
  }

  setMap(map, fetchedAt) {
    const { nodes, links } = mergeMap(map);
    const saved = lsGet(LS.pos, {}), now = Date.now();
    // keep live positions of nodes that already exist
    const old = this.data ? Object.fromEntries(this.data.nodes.map(n => [n.id, n])) : {};
    for (const n of nodes) {
      n.isEnd = n.type === 'EndDevice' || n.type === 'Unknown';
      n.stale = n.lastSeen && (now - n.lastSeen) > 86400e3;
      const o = old[n.id];
      if (o) { n.x = o.x; n.y = o.y; n.fx = o.fx; n.fy = o.fy; }
      else if (saved[n.id]) { n.fx = n.x = saved[n.id][0]; n.fy = n.y = saved[n.id][1]; }
    }
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    for (const l of links) { l.s = byId[l.source]; l.t = byId[l.target]; l.min = Math.min(l.lqS ?? 999, l.lqT ?? 999); l.oneSided = (l.lqS == null || l.lqT == null || l.lqS === 0 || l.lqT === 0); }
    this.data = { nodes, links, byId, fetchedAt };
    this.selected = null;
    const routers = nodes.filter(n => !n.isEnd && n.type !== 'Coordinator').length, ends = nodes.filter(n => n.isEnd).length;
    const weak = links.filter(l => !l.oneSided && l.min < 50 && !l.s.isEnd && !l.t.isEnd).length;
    this.$('status').textContent = `map ${new Date(fetchedAt).toLocaleString()} · ${routers} routers, ${ends} end devices, ${links.length} links · ${weak} router links < 50`;
    this.warm = false;
    this.render();
  }

  initGraph() {
    const r = this.shadowRoot, $ = this.$;
    this.svg = d3.select(r.querySelector('svg')); this.tip = d3.select($('tip'));
    this.g = this.svg.append('g'); this.gl = this.g.append('g'); this.glq = this.g.append('g'); this.gn = this.g.append('g');
    this.svg.call(d3.zoom().scaleExtent([0.15, 6]).on('zoom', e => this.g.attr('transform', e.transform)).filter(e => !e.target.closest?.('.node') && !e.button));
    this.svg.on('click', () => { this.selected = null; this.applySel(); });
    this.spring = +lsGet(LS.spring, 1) || 1;
    const dist = l => (l.s.isEnd || l.t.isEnd ? 60 : 210) * this.spring, charge = d => (d.isEnd ? -150 : -1100) * this.spring;
    this.sim = d3.forceSimulation().force('link', d3.forceLink().id(d => d.id).distance(dist).strength(l => l.oneSided ? 0.15 : 0.5))
      .force('charge', d3.forceManyBody().strength(charge)).force('center', d3.forceCenter(400, 300)).force('collide', d3.forceCollide(d => d.isEnd ? 18 : 42))
      .on('tick', () => this.draw());
    $('showEnd').onchange = () => this.render(); $('showOne').onchange = () => this.render();
    $('showLql').onchange = () => this.glq.selectAll('text').style('display', $('showLql').checked ? null : 'none');
    $('hide').oninput = () => { $('hideV').textContent = hideLabel(+$('hide').value); this.render(); };
    $('spring').value = this.spring; $('springV').textContent = this.spring.toFixed(1);
    $('spring').oninput = () => { this.spring = +$('spring').value; $('springV').textContent = this.spring.toFixed(1); lsSet(LS.spring, this.spring); this.sim.force('link').distance(dist); this.sim.force('charge').strength(charge); this.sim.alpha(0.5).restart(); };
    $('find').oninput = () => this.applySel();
    $('unpin').onclick = () => { if (!this.data) return; for (const n of this.data.nodes) n.fx = n.fy = null; this.savePos(); this.sim.alpha(0.6).restart(); this.draw(); };
    $('relayout').onclick = () => this.sim.alpha(0.8).restart();
    $('png').onclick = () => this.savePng();
  }
  savePos() { const o = {}; if (this.data) for (const n of this.data.nodes) if (n.fx != null) o[n.id] = [Math.round(n.fx), Math.round(n.fy)]; lsSet(LS.pos, o); }
  visible() {
    const $ = this.$, se = $('showEnd').checked, so = $('showOne').checked, hv = +$('hide').value;
    const nodes = this.data.nodes.filter(n => se || !n.isEnd);
    const vis = new Set(nodes.map(n => n.id));
    const links = this.data.links.filter(l => vis.has(l.s.id) && vis.has(l.t.id) && (so || !l.oneSided) && (l.oneSided || hideOk(l.min, hv)));
    return { nodes, links };
  }
  render() {
    if (!this.data) return;
    const { nodes, links } = this.visible(), self = this, byId = this.data.byId, $ = this.$;
    const color = l => l.oneSided ? '#8a8f99' : l.min >= 80 ? 'var(--green)' : l.min >= 50 ? 'var(--orange)' : 'var(--red)';
    const width = l => l.oneSided ? 1 : 1 + 2.5 * Math.min(l.min, 200) / 200;
    const fmt = v => v == null ? '–' : v, key = l => l.s.id + '|' + l.t.id;
    const link = this.gl.selectAll('line').data(links, key); link.exit().remove();
    link.enter().append('line').attr('class', 'link').merge(link).attr('stroke', color).attr('stroke-width', width).attr('stroke-dasharray', l => l.oneSided ? '4 4' : null)
      .on('mouseenter', (e, l) => this.showTip(e, `${l.s.name}  ⟷  ${l.t.name}\n${l.s.name} hears ${l.t.name}: ${fmt(l.lqS)}  (${REL[l.relS] ?? '–'})\n${l.t.name} hears ${l.s.name}: ${fmt(l.lqT)}  (${REL[l.relT] ?? '–'})` + (l.routes.length ? `\nroutes: ${l.routes.map(r => `${byId[r.via]?.name ?? r.via} → nwk ${r.to} ${r.status}`).join('; ')}` : '')))
      .on('mousemove', e => this.moveTip(e)).on('mouseleave', () => this.hideTip());
    const lql = this.glq.selectAll('text').data(links, key); lql.exit().remove();
    lql.enter().append('text').attr('class', 'lql').attr('text-anchor', 'middle').merge(lql).text(l => `${fmt(l.lqS)} / ${fmt(l.lqT)}`).style('display', $('showLql').checked ? null : 'none');
    const node = this.gn.selectAll('g.node').data(nodes, n => n.id); node.exit().remove();
    const ne = node.enter().append('g').attr('class', 'node').call(d3.drag()
      .on('start', (e, d) => { if (!e.active) self.sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) self.sim.alphaTarget(0); self.savePos(); self.draw(); }))
      .on('click', (e, d) => { e.stopPropagation(); self.selected = self.selected === d ? null : d; self.applySel(); })
      .on('dblclick', (e, d) => { e.stopPropagation(); d.fx = d.fy = null; self.savePos(); self.sim.alpha(0.3).restart(); self.draw(); })
      .on('mouseenter', (e, d) => this.showTip(e, `${d.name}\n${d.type}${d.vendor ? ` · ${d.vendor} ${d.model}` : ''}${d.desc ? `\n${d.desc}` : ''}\nIEEE ${d.id}${d.nwk != null ? `  nwk ${d.nwk}` : ''}${d.lastSeen ? `\nlast seen ${new Date(d.lastSeen).toLocaleString()}` : ''}\nlinks: ${this.data.links.filter(l => l.s === d || l.t === d).length}`))
      .on('mousemove', e => this.moveTip(e)).on('mouseleave', () => this.hideTip());
    ne.append('circle').attr('class', 'ring').attr('r', d => d.type === 'Coordinator' ? 15 : d.isEnd ? 7 : 12).attr('fill', 'none').attr('stroke', 'none').attr('stroke-width', 2);
    ne.each(function (d) {
      const s = d3.select(this);
      if (d.type === 'Coordinator') s.append('circle').attr('class', 'shape').attr('r', 11).attr('fill', 'var(--yellow)').attr('stroke', '#000');
      else if (d.isEnd) s.append('circle').attr('class', 'shape').attr('r', 4).attr('fill', '#9aa3b2').attr('stroke', '#000');
      else s.append('rect').attr('class', 'shape').attr('x', -8).attr('y', -8).attr('width', 16).attr('height', 16).attr('rx', 3).attr('fill', 'var(--blue)').attr('stroke', '#000');
    });
    ne.append('text').attr('dy', d => d.isEnd ? 14 : 22).attr('text-anchor', 'middle').text(d => d.name);
    this.gn.selectAll('g.node').classed('end', d => d.isEnd).classed('stale', d => d.stale);
    this.sim.nodes(nodes); this.sim.force('link').links(links);
    if (!this.warm) { this.warm = true; const c = $('canvas'); this.sim.force('center', d3.forceCenter(c.clientWidth / 2, c.clientHeight / 2)); this.sim.alpha(1); for (let i = 0; i < 250; i++) this.sim.tick(); }
    this.sim.alpha(0.5).restart();
    this.applySel();
  }
  draw() {
    this.gl.selectAll('line').attr('x1', l => l.source.x).attr('y1', l => l.source.y).attr('x2', l => l.target.x).attr('y2', l => l.target.y);
    this.glq.selectAll('text').attr('x', l => (l.source.x + l.target.x) / 2).attr('y', l => (l.source.y + l.target.y) / 2 - 3);
    this.gn.selectAll('g.node').attr('transform', d => `translate(${d.x},${d.y})`).classed('pinned', d => d.fx != null);
  }
  applySel() {
    if (!this.data) return;
    const q = this.$('find').value.trim().toLowerCase(), sel = this.selected;
    const matches = q ? new Set(this.data.nodes.filter(n => n.name.toLowerCase().includes(q)).map(n => n.id)) : null;
    const keep = new Set();
    if (sel) { keep.add(sel.id); for (const l of this.data.links) { if (l.s === sel) keep.add(l.t.id); if (l.t === sel) keep.add(l.s.id); } }
    const active = sel ? keep : matches;
    const linkOn = l => !active || (sel ? (l.s === sel || l.t === sel) : (active.has(l.s.id) || active.has(l.t.id)));
    this.gn.selectAll('g.node').classed('dim', d => active && !active.has(d.id)).classed('sel', d => d === sel || (matches && matches.has(d.id) && !sel));
    this.gl.selectAll('line').classed('dim', l => !linkOn(l));
    this.glq.selectAll('text').classed('dim', l => !linkOn(l));
  }
  showTip(e, text) { this.tip.style('display', 'block').text(text); this.moveTip(e); }
  moveTip(e) { const c = this.$('canvas').getBoundingClientRect(); this.tip.style('left', Math.min(e.clientX - c.left + 14, c.width - 400) + 'px').style('top', (e.clientY - c.top + 14) + 'px'); }
  hideTip() { this.tip.style('display', 'none'); }
  savePng() {
    const svgEl = this.svg.node(), c = this.$('canvas'), w = c.clientWidth, h = c.clientHeight;
    const cs = getComputedStyle(this), bg = cs.getPropertyValue('--primary-background-color').trim() || '#1c2027';
    const vars = ['--red', '--orange', '--green', '--blue', '--yellow', '--bgc', '--muted', '--primary-text-color'].map(v => `${v}:${cs.getPropertyValue(v).trim()}`).join(';');
    let xml = new XMLSerializer().serializeToString(svgEl);
    const css = STYLE.replace(/:host\s*{[^}]*}/, '').replace(/#\w+\s*{[^}]*}/g, '');
    xml = xml.replace('<svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" style="${vars};background:${bg};font:13px system-ui,sans-serif"`).replace('>', `><style>${css}</style>`);
    const img = new Image(), cv = document.createElement('canvas'); cv.width = w * 2; cv.height = h * 2;
    img.onload = () => { const ctx = cv.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height); ctx.scale(2, 2); ctx.drawImage(img, 0, 0); const a = document.createElement('a'); a.download = `zigbee_map_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`; a.href = cv.toDataURL('image/png'); a.click(); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  }
}
customElements.define('zigbee-map-panel', ZigbeeMapPanel);
