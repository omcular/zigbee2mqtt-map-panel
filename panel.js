/* Zigbee map panel for Home Assistant (panel_custom).
 * Shows the last Zigbee2MQTT raw network map kept retained on <store_topic> by the zigbee_map_store automation
 * (background scan every 6 h), and can request a fresh scan over HA's own websocket (mqtt.publish + mqtt/subscribe),
 * renders it as a d3 force graph with pinnable nodes. Admin user required (mqtt/subscribe is admin-only).
 * Files: /config/www/zigbee_map/panel.js + d3.v7.min.js ; config: yamls/zigbee_map_panel.yaml
 */
const BASE = new URL('.', import.meta.url).href;
const REL = { 0: 'parent', 1: 'child', 2: 'sibling', 3: 'none', 4: 'previous child' };
const LS = { map: 'z2m_panel_map_v1', pos: 'z2m_map_positions_v2', view: 'z2m_map_view_v1', spring: 'z2m_map_spring', lqilen: 'z2m_map_lqilen', pin: 'z2m_map_pin', prefs: 'z2m_map_prefs_v1' };

let d3Ready;
function loadD3() {
  if (window.d3) return Promise.resolve(window.d3);
  d3Ready ??= new Promise((res, rej) => { const s = document.createElement('script'); s.src = BASE + 'd3.v7.min.js'; s.onload = () => res(window.d3); s.onerror = () => rej(new Error('d3 failed to load from ' + s.src)); document.head.appendChild(s); });
  return d3Ready;
}
// one slider, middle = show all. Left (v < 0): hide GOOD links, i.e. keep only LQI < |v| (find the bad ones).
// Right (v > 0): hide BAD links, i.e. keep only LQI > v (clean picture). Dead zone around 0.
const hideOk = (lq, v) => v <= -10 ? lq < -v : v >= 10 ? lq > v : true;
const hideLabel = v => v <= -10 ? `≥ ${-v} hidden` : v >= 10 ? `≤ ${v} hidden` : 'off';
const imgUrl = m => m ? `https://www.zigbee2mqtt.io/images/devices/${String(m).replace(/[/:\s]/g, '-')}.png` : null;
const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lqColor = v => v == null || v === 0 ? '#8a8f99' : v >= 80 ? 'var(--green)' : v >= 50 ? 'var(--orange)' : 'var(--red)';
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
  details.dd { position:relative; }
  details.dd summary { list-style:none; cursor:pointer; background:var(--bgc); border:1px solid var(--divider-color,#444); border-radius:4px; padding:3px 8px; user-select:none; }
  details.dd summary::-webkit-details-marker { display:none; }
  details.dd .menu { position:absolute; top:calc(100% + 4px); left:0; z-index:6; display:flex; flex-direction:column; gap:8px; min-width:250px; padding:10px 12px; background:var(--panel); border:1px solid var(--divider-color,#444); border-radius:6px; box-shadow:0 4px 14px rgba(0,0,0,.4); }
  details.dd .menu .row { display:flex; gap:6px; flex-wrap:wrap; }
  details.dd .menu .sep { border-top:1px solid var(--divider-color,#444); margin:2px 0; }
  details.dd .menu .note { color:var(--muted); font-size:11px; }
  details.dd .menu input[type=number] { width:64px; background:var(--bgc); color:inherit; border:1px solid var(--divider-color,#444); border-radius:4px; padding:2px 4px; }
  details#help .menu { min-width:min(560px, calc(100vw - 40px)); gap:6px; font-size:12px; line-height:1.45; }
  details#help h4 { margin:4px 0 0; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  details#help dl { display:grid; grid-template-columns:max-content 1fr; gap:3px 12px; margin:0; }
  details#help dt { color:var(--primary-text-color); white-space:nowrap; }
  details#help dd { margin:0; color:var(--muted); }
  details#help kbd { font:inherit; padding:0 4px; border:1px solid var(--divider-color,#555); border-radius:3px; }
  details.dd .menu input[type=range] { width:120px; }
  #legend { position:absolute; left:10px; bottom:10px; background:var(--panel); border:1px solid var(--divider-color,#333); border-radius:6px; padding:6px 9px; font-size:11px; color:var(--muted); max-width:min(900px,calc(100% - 40px)); }
  #legend span.sw { display:inline-block; width:20px; height:3px; vertical-align:middle; margin-right:5px; }
  #tip { position:absolute; pointer-events:none; background:var(--panel); color:inherit; border:1px solid var(--divider-color,#444); border-radius:6px; padding:6px 9px; font-size:12px; max-width:380px; display:none; white-space:pre-line; z-index:3; box-shadow:0 2px 8px rgba(0,0,0,.4); }
  svg { position:absolute; inset:0; width:100%; height:100%; cursor:grab; }
  svg:active { cursor:grabbing; }
  svg.rotating { cursor:grabbing; }
  #tip .big { font-size:22px; font-weight:600; line-height:1.1; margin-bottom:3px; }
  #canvas { position:relative; flex:1; height:calc(100% - var(--barh,44px)); }
  .link line.vis { stroke-linecap:round; pointer-events:none; }
  .link line.hit { stroke:transparent; stroke-width:6px; cursor:help; }
  .link.dim, .lql.dim { opacity:0.3; }
  .node.dim .shape, .node.dim .ring, .node.dim .halo, .node.dim image.img, .node.dim text { opacity:0.3; }   /* the disc behind the image stays opaque so the link gap survives */
  .lql { font-size:9px; fill:var(--primary-text-color,#c7cdd8); paint-order:stroke; stroke:var(--bgc); stroke-width:3px; pointer-events:none; }
  .node text { font-size:11px; fill:var(--primary-text-color,#dfe3ea); paint-order:stroke; stroke:var(--bgc); stroke-width:3px; pointer-events:none; }
  .node.end text { font-size:9.5px; fill:var(--muted); }
  .node .shape, .node .ring { cursor:move; }
  .node image.img { cursor:move; }
  .node circle.imgbg { fill:var(--bgc); cursor:move; }
  .node .halo { fill:var(--yellow); fill-opacity:0; }
  .node.pinned .halo { fill-opacity:0.22; }
  .node.pinned .shape { stroke:var(--primary-text-color,#fff); }
  .node.stale .ring { stroke:var(--red); stroke-dasharray:3 2; }
  .node.sel .shape { stroke:var(--yellow); stroke-width:3px; }
  .node.sel circle.imgbg { stroke:var(--yellow); stroke-width:2px; }
  .node.pinned circle.imgbg { stroke:var(--primary-text-color,#fff); stroke-width:1px; }
  ha-menu-button { --mdc-icon-button-size:36px; }
`;

const BAR = `
  <ha-menu-button></ha-menu-button>
  <button id="pull" class="primary">pull fresh map</button>
  <label title="middle: show all · left: hide good links (keep LQI below n, to find the bad ones) · right: hide bad links (keep LQI above n)">hide <input type="range" id="hide" min="-255" max="255" value="0" step="5"> <span id="hideV">off</span></label>
  <label>find <input type="text" id="find" placeholder="node name…"></label>
  <details id="opts" class="dd"><summary>options ▾</summary><div class="menu">
    <label><input type="checkbox" id="showEnd"> end devices</label>
    <label><input type="checkbox" id="showOne"> one-sided / stale links</label>
    <label title="device photos from zigbee2mqtt.io (the browser fetches them, so this needs internet); nodes without a picture keep the generic shape"><input type="checkbox" id="showImg"> show device images</label>
    <label title="size of the device images (end devices get two thirds)">image size <input type="range" id="imgsize" min="16" max="64" value="30" step="2"> <span id="imgsizeV">30</span></label>
    <label><input type="checkbox" id="showNames" checked> show device names</label>
    <label><input type="checkbox" id="showLql"> show LQI labels</label>
    <label title="also read every router's routing table on a pull (slower: +15 s per router that does not answer)"><input type="checkbox" id="routes"> routes on pull</label>
    <div class="sep"></div>
    <label title="Home Assistant scans on its own at this interval, whether anyone is looking or not (input_number.zigbee_map_scan_interval). 0 = off">background scan every <input type="number" id="bgInt" min="0" max="24" step="0.5"> h</label>
    <label title="while this panel is open and visible it requests a scan at this interval (input_number.zigbee_map_live_interval). 0 = off">scan while viewing every <input type="number" id="liveInt" min="0" max="60" step="1"> min</label>
    <label title="use the networkmap_fast external extension (2 routers at a time, the measured sweet spot here) instead of Zigbee2MQTT's one-by-one scan; needs the extension loaded in Z2M"><input type="checkbox" id="fastScan"> parallel scan (extension)</label>
    <div id="schedNote" class="note"></div>
    <label>spring <input type="range" id="spring" min="0.3" max="3" value="1" step="0.05"> <span id="springV">1.0</span></label>
    <label title="0: all links the same length · 1: strong links short, weak links long · 1.5: exaggerated">LQI → length <input type="range" id="lqilen" min="0" max="1.5" value="1" step="0.05"> <span id="lqilenV">1.0</span></label>
    <label title="off: dragging only disentangles, the node floats again when released (hold Shift to pin anyway) · on: every dragged node stays where you drop it"><input type="checkbox" id="pinmode"> drag pins nodes</label>
    <div class="row"><button id="unpin">unpin all</button><button id="relayout">re-layout</button><button id="resetview">reset view</button><button id="png">save PNG</button></div>
    <div class="row"><button id="resetall" title="forget every option, pin, position and the view in this browser (the last map is kept)">reset to defaults</button></div>
  </div></details>
  <details id="help" class="dd"><summary>help ▾</summary><div class="menu">
    <h4>Mouse</h4>
    <dl>
      <dt>drag background · wheel</dt><dd>pan · zoom (<kbd>Ctrl</kbd>-wheel is left to the browser)</dd>
      <dt><kbd>Ctrl</kbd>-drag · middle-drag</dt><dd>rotate the whole map around the centre of the view; positions and pins turn with it</dd>
      <dt>drag node</dt><dd>disentangle; the node floats again when released. <kbd>Shift</kbd>-drag pins it (or turn on "drag pins nodes" in options)</dd>
      <dt>double-click node</dt><dd>pin / unpin. Pinned nodes carry a yellow halo and keep their place across scans and reloads</dd>
      <dt>click node · click background</dt><dd>show that node with ALL its links, even the ones the hide slider or the one-sided filter would hide, and fade the rest · back to normal</dd>
      <dt>hover node / link</dt><dd>model, last seen, link count · both LQI directions, relationship, routes</dd>
    </dl>
    <h4>Reading the map</h4>
    <dl>
      <dt>a / b on a link</dt><dd>what the left-hand node hears from the right-hand one / what the right-hand node hears. LQI 0–255, higher is better: <span style="color:var(--green)">≥ 80</span>, <span style="color:var(--orange)">50–79</span>, <span style="color:var(--red)">&lt; 50</span>. Colour and width follow the weaker direction</dd>
      <dt>dashed grey</dt><dd>only one side reported the link, or reported 0: usually a stale neighbour-table entry (hidden unless "one-sided / stale links" is on)</dd>
      <dt>link length</dt><dd>strong links short, weak links long ("LQI → length" in options sets how much; "spring" scales everything)</dd>
      <dt>shapes</dt><dd>yellow disc = coordinator · square = router · small dot = end device (hidden by default) · red dashed ring = not seen for more than 24 h · "show device images" in options puts the zigbee2mqtt.io photo on each node, "image size" scales them (needs internet; the PNG export leaves them out)</dd>
      <dt>what a link is</dt><dd>an entry in a router's neighbour table, not a live route. These tables hold ~16 entries and age in and out, so links come and go between scans; judge a path over several scans</dd>
    </dl>
    <h4>Data</h4>
    <dl>
      <dt>background scan</dt><dd>Home Assistant asks Zigbee2MQTT for the map at the interval set in options and keeps the answer, so the panel opens with the latest scan and updates itself when a scan finishes</dd>
      <dt>scan while viewing</dt><dd>while this panel is open and visible it requests a scan at the second interval in options. Several open panels share one schedule through the last-request time kept in HA</dd>
      <dt>pull fresh map</dt><dd>starts a scan now; every router that does not answer costs about 15 s. Leaving the page is fine, the result is kept. "routes on pull" also reads routing tables (slower). "parallel scan" sends the request to the networkmap_fast extension's own topic (2 routers at a time; more loses routers behind weak links). With the extension's default config the normal topic is served by it too, so the toggle only matters if that takeover is off</dd>
      <dt>hide slider</dt><dd>middle shows all · left hides good links (keep only LQI below n, to find the bad ones) · right hides bad links</dd>
      <dt>find</dt><dd>highlights every node whose name contains the text</dd>
      <dt>stored in this browser</dt><dd>node positions and pins, zoom and pan, every option, the hide slider and the last map, so a revisit looks like you left it. Other browsers and devices have their own. "re-layout" shakes the layout, "reset view" the zoom</dd>
    </dl>
  </div></details>
  <span id="status"></span>`;

const LEGEND = `
  <div><span class="sw" style="background:var(--green)"></span>LQI ≥ 80 &nbsp; <span class="sw" style="background:var(--orange)"></span>50–79 &nbsp; <span class="sw" style="background:var(--red)"></span>&lt; 50 &nbsp; <span class="sw" style="height:0;border-top:2px dashed #999"></span>one side only &nbsp;·&nbsp; a / b = what left hears / what right hears &nbsp;·&nbsp; see "help ▾"</div>`;

class ZigbeeMapPanel extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }); this._hass = null; this._built = false; this.selected = null; this.data = null; }
  set hass(h) { this._hass = h; const mb = this.shadowRoot.querySelector('ha-menu-button'); if (mb) { mb.hass = h; mb.narrow = this._narrow; } this.syncSched(); }
  get hass() { return this._hass; }
  set narrow(n) { this._narrow = n; const mb = this.shadowRoot.querySelector('ha-menu-button'); if (mb) mb.narrow = n; }
  set panel(p) { this._panel = p; }
  get baseTopic() { return this._panel?.config?.base_topic || 'zigbee2mqtt'; }
  get storeTopic() { return this._panel?.config?.store_topic || 'zigbee_map/latest'; }
  get E() { const c = this._panel?.config || {}; return { bg: c.scan_interval_entity || 'input_number.zigbee_map_scan_interval', live: c.live_interval_entity || 'input_number.zigbee_map_live_interval', last: c.last_request_entity || 'input_datetime.zigbee_map_last_request', fast: c.fast_scan_entity || 'input_boolean.zigbee_map_fast_scan' }; }
  get fast() { return this._hass?.states?.[this.E.fast]?.state === 'on'; }
  num(eid) { const v = parseFloat(this._hass?.states?.[eid]?.state); return Number.isFinite(v) ? v : null; }
  lastRequestMs() { const st = this._hass?.states?.[this.E.last]?.state; const t = st ? Date.parse(st.replace(' ', 'T')) : NaN; return Number.isFinite(t) ? t : 0; }

  connectedCallback() { if (!this._built) { this._built = true; this.build(); } else { this.watchStore(); if (!this._liveT) this._liveT = setInterval(() => this.liveTick(), 15000); } }   // HA may re-attach the same element

  async build() {
    const r = this.shadowRoot;
    r.innerHTML = `<style>${STYLE}</style><div id="wrap"><div id="bar">${BAR}</div><div id="canvas"><svg></svg><div id="legend">${LEGEND}</div><div id="tip"></div></div></div>`;
    const mb = r.querySelector('ha-menu-button'); mb.hass = this._hass; mb.narrow = this._narrow;
    this.$ = id => r.getElementById(id);
    this.$('pull').onclick = () => this.pull();
    const dds = [this.$('opts'), this.$('help')];
    r.addEventListener('click', e => { for (const d of dds) if (d.open && !e.composedPath().includes(d)) d.open = false; });
    for (const d of dds) d.addEventListener('toggle', () => { if (d.open) for (const o of dds) if (o !== d) o.open = false; });
    try { await loadD3(); } catch (e) { this.$('status').textContent = e.message; return; }
    this.initGraph();
    const cached = lsGet(LS.map, null);
    if (cached) { this.setMap(cached.map, cached.fetchedAt); this.$('status').textContent += ' (cached in this browser)'; }
    else this.$('status').textContent = 'no map yet, press "pull fresh map"';
    this.watchStore();
    new ResizeObserver(() => this.onResize()).observe(this.$('canvas'));
    this.onResize();
    for (const [id, key] of [['bgInt', 'bg'], ['liveInt', 'live']]) this.$(id).onchange = () => {
      const v = parseFloat(this.$(id).value); if (!Number.isFinite(v) || !this._hass) return;
      this._hass.callService('input_number', 'set_value', { entity_id: this.E[key], value: v }).catch(e => { this.$('schedNote').textContent = 'could not set ' + this.E[key] + ': ' + (e.message || e); });
    };
    this.$('fastScan').onchange = () => { if (!this._hass) return; this._hass.callService('input_boolean', this.$('fastScan').checked ? 'turn_on' : 'turn_off', { entity_id: this.E.fast }).catch(() => {}); };
    this.syncSched();
    if (!this._liveT) this._liveT = setInterval(() => this.liveTick(), 15000);
  }
  // mirror the HA interval entities into the options menu (they may be edited anywhere in HA)
  syncSched() {
    if (!this.$ || !this.$('bgInt')) return;
    const bg = this.num(this.E.bg), live = this.num(this.E.live);
    const fs = this._hass?.states?.[this.E.fast]; this.$('fastScan').disabled = !fs; this.$('fastScan').checked = !!fs && fs.state === 'on';
    for (const [id, v] of [['bgInt', bg], ['liveInt', live]]) { const el = this.$(id); if (this.shadowRoot.activeElement !== el) { el.value = v == null ? '' : v; el.disabled = v == null; } }
    this.$('schedNote').textContent = (bg == null || live == null) ? 'interval entities not found in HA: is the zigbee_map_panel package installed?' :
      (bg > 0 ? `background: every ${bg} h` : 'background: off') + ' · ' + (live > 0 ? `viewing: every ${live} min` : 'viewing: off') + (this.fast ? ' · parallel' : '');
  }
  // while the panel is open and visible: request a scan once the live interval has passed since the last request anywhere
  liveTick() {
    if (!this.isConnected || document.visibilityState !== 'visible' || !this._hass || this._pulling) return;
    const live = this.num(this.E.live); if (!(live > 0)) return;
    const last = Math.max(this.lastRequestMs(), this.data ? (Date.parse(this.data.fetchedAt) || 0) : 0);
    if (Date.now() - last >= live * 60000) this.pull(true);
  }
  onResize() { const bar = this.$('bar'); if (bar) { const h = bar.offsetHeight + 'px'; if (this._barh !== h) { this._barh = h; this.style.setProperty('--barh', h); } } if (this.sim && this.data) { const c = this.$('canvas'), cx = c.clientWidth / 2, cy = c.clientHeight / 2; this.sim.force('center', d3.forceCenter(cx, cy)); this.sim.force('x')?.x(cx); this.sim.force('y')?.y(cy); } }

  // retained copy kept by HA (zigbee_map_store automation): arrives immediately on subscribe, and after every scan
  async watchStore() {
    const h = this._hass; if (!h || this._storeSub) return;
    try {
      this._storeSub = await h.connection.subscribeMessage(msg => {
        let r; try { r = JSON.parse(msg.payload); } catch (e) { return; }
        if (!r?.map?.nodes) return;
        if (this.data && this.data.fetchedAt === r.fetchedAt) return;
        lsSet(LS.map, { fetchedAt: r.fetchedAt, map: r.map });
        this.setMap(r.map, r.fetchedAt);
        if (this._pulling) { this._pulling(); this._pulling = null; }
      }, { type: 'mqtt/subscribe', topic: this.storeTopic });
    } catch (e) { this.$('status').textContent = 'cannot subscribe to ' + this.storeTopic + ': ' + (e.message || JSON.stringify(e)); }
  }
  disconnectedCallback() { clearInterval(this._liveT); this._liveT = null; this.savePos(); this.saveView(); if (this._storeSub) { try { this._storeSub(); } catch (e) {} this._storeSub = null; } }

  async pull(auto = false) {
    const h = this._hass; if (!h) return;
    if (h.states?.[this.E.last]) { const d = new Date(), pad = n => String(n).padStart(2, '0'); h.callService('input_datetime', 'set_datetime', { entity_id: this.E.last, datetime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }).catch(() => {}); }
    const st = this.$('status'), btn = this.$('pull');
    const kind = this.fast ? 'networkmap_fast' : 'networkmap';
    btn.disabled = true; st.textContent = `requesting ${kind} on ${this.baseTopic}…`;
    const t0 = Date.now(); let unsub = null, progSub = null, progress = '';
    const tick = setInterval(() => { st.textContent = `${auto ? 'viewing scan' : 'scan'} running… ${Math.round((Date.now() - t0) / 1000)} s${progress} (each router that does not answer costs 15 s; leaving the page is fine, the result is kept by HA)`; }, 1000);
    const done = () => { clearInterval(tick); clearTimeout(to); btn.disabled = false; this._pulling = null; for (const u of [unsub, progSub]) if (u) { try { u(); } catch (e) {} } unsub = progSub = null; };
    const to = setTimeout(() => { done(); st.textContent = 'timeout: no response in 10 min (Z2M busy? base topic right? the background scan will still land here when it finishes)'; }, 600000);
    this._pulling = done;   // the retained store topic may deliver the result first
    try {
      // progress comes from the networkmap_fast extension; with its default config it also answers the normal topic, so always listen
      progSub = await h.connection.subscribeMessage(msg => { try { const p = JSON.parse(msg.payload); progress = ` · ${p.done}/${p.total} routers${p.failed ? `, ${p.failed} not answering` : ''}`; } catch (e) {} },
        { type: 'mqtt/subscribe', topic: `${this.baseTopic}/bridge/networkmap_fast/progress` });
      unsub = await h.connection.subscribeMessage(msg => {
        let r; try { r = JSON.parse(msg.payload); } catch (e) { return; }
        if (r.status !== 'ok') { done(); st.textContent = 'Z2M error: ' + (r.error || 'unknown'); return; }
        done();
        const fetchedAt = new Date().toISOString();
        lsSet(LS.map, { fetchedAt, map: r.data.value });
        this.setMap(r.data.value, fetchedAt);
        if (r.data.duration) st.textContent += ` · scan took ${r.data.duration} s`;
      }, { type: 'mqtt/subscribe', topic: `${this.baseTopic}/bridge/response/${kind}` });
      await h.callService('mqtt', 'publish', { topic: `${this.baseTopic}/bridge/request/${kind}`, payload: JSON.stringify({ type: 'raw', routes: !!this.$('routes').checked }) });
    } catch (e) { done(); st.textContent = 'failed: ' + (e.message || JSON.stringify(e)) + ' (admin user needed for mqtt/subscribe)'; }
  }

  setMap(map, fetchedAt) {
    const { nodes, links } = mergeMap(map);
    const saved = lsGet(LS.pos, {}), now = Date.now(); let seeded = 0;
    // keep live positions of nodes that already exist
    const old = this.data ? Object.fromEntries(this.data.nodes.map(n => [n.id, n])) : {};
    for (const n of nodes) {
      n.isEnd = n.type === 'EndDevice' || n.type === 'Unknown';
      n.stale = n.lastSeen && (now - n.lastSeen) > 86400e3;
      const o = old[n.id], sv = saved[n.id];
      if (o) { n.x = o.x; n.y = o.y; n.fx = o.fx; n.fy = o.fy; }
      else if (sv) { n.x = sv[0]; n.y = sv[1]; if (sv[2]) { n.fx = sv[0]; n.fy = sv[1]; } seeded++; }
    }
    if (seeded > 0 && !this.data) { this.warm = true; this._gentle = true; }   // first map of this visit, positions known: no warm-up, no shake
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    for (const l of links) {
      l.s = byId[l.source]; l.t = byId[l.target];
      // an end device has no neighbour table, so its link is reported by the parent only: that is normal, not stale
      l.endLink = l.s.isEnd || l.t.isEnd;
      const vals = [l.lqS, l.lqT].filter(v => v != null && v > 0);
      l.min = l.endLink ? (vals.length ? Math.min(...vals) : 0) : Math.min(l.lqS ?? 999, l.lqT ?? 999);
      l.oneSided = !l.endLink && (l.lqS == null || l.lqT == null || l.lqS === 0 || l.lqT === 0);
    }
    this.data = { nodes, links, byId, fetchedAt };
    this.selected = null;
    const routers = nodes.filter(n => !n.isEnd && n.type !== 'Coordinator').length, ends = nodes.filter(n => n.isEnd).length;
    this.$('status').textContent = `map ${new Date(fetchedAt).toLocaleString()} · ${routers} routers, ${ends} end devices, ${links.length} links`;
    if (!(seeded > 0)) this.warm = false;
    this.render();
  }

  initGraph() {
    const r = this.shadowRoot, $ = this.$;
    this.svg = d3.select(r.querySelector('svg')); this.tip = d3.select($('tip'));
    this.g = this.svg.append('g'); this.gl = this.g.append('g'); this.glq = this.g.append('g'); this.gn = this.g.append('g');
    // Ctrl is excluded on purpose: Ctrl-wheel stays browser zoom, Ctrl-drag rotates (below); middle button rotates too
    this.zoom = d3.zoom().scaleExtent([0.15, 6]).on('zoom', e => { this._zoomT = e.transform; this.g.attr('transform', e.transform); }).on('end', () => this.saveView()).filter(e => !e.target.closest?.('.node') && !e.button && !e.ctrlKey);
    this.svg.call(this.zoom);
    const svgEl = this.svg.node();
    svgEl.addEventListener('mousedown', e => {
      if (!this.data || e.target.closest?.('.node') || !(e.button === 1 || (e.button === 0 && e.ctrlKey))) return;
      e.preventDefault(); e.stopPropagation();
      const c = $('canvas').getBoundingClientRect(), cx = c.left + c.width / 2, cy = c.top + c.height / 2;
      const centre = d3.zoomTransform(svgEl).invert([c.width / 2, c.height / 2]);   // centre of the view, in graph coordinates
      let a0 = Math.atan2(e.clientY - cy, e.clientX - cx), turned = false;
      svgEl.classList.add('rotating');
      const move = ev => { const a1 = Math.atan2(ev.clientY - cy, ev.clientX - cx); if (a1 !== a0) { this.rotateAll(a1 - a0, centre); a0 = a1; turned = true; } };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); svgEl.classList.remove('rotating'); if (turned) { this._rotated = true; this.savePos(); } };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    svgEl.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
    const v = lsGet(LS.view, null); if (v && v.k > 0) this.svg.call(this.zoom.transform, d3.zoomIdentity.translate(v.x, v.y).scale(v.k));
    this.svg.on('click', () => { if (this._rotated) { this._rotated = false; return; } if (this.selected) { this.selected = null; this._selOnly = true; this.render(); } else this.applySel(); });
    this.spring = +lsGet(LS.spring, 1) || 1;
    // rest length follows link quality (weaker direction): LQI 255 -> short, LQI 0 / one-sided -> long
    const q = l => (l.oneSided || !(l.min >= 0) || l.min > 255) ? 0 : l.min / 255;
    this.lqilen = +lsGet(LS.lqilen, 1); if (!(this.lqilen >= 0)) this.lqilen = 1;
    // k = 0: fixed lengths (210 / 60) · k = 1: 120..300 / 40..100 by LQI · in between: linear blend
    const dist = l => { const k = this.lqilen; return ((l.s.isEnd || l.t.isEnd) ? ((60 - 20 * k) + 60 * k * (1 - q(l))) : ((210 - 90 * k) + 180 * k * (1 - q(l)))) * this.spring; };
    const charge = d => (d.isEnd ? -150 : -1100) * this.spring;
    this.sim = d3.forceSimulation().force('link', d3.forceLink().id(d => d.id).distance(dist).strength(l => l.revealed ? 0 : l.oneSided ? 0.15 : 0.5))
      .force('charge', d3.forceManyBody().strength(charge)).force('center', d3.forceCenter(400, 300)).force('collide', d3.forceCollide(d => d.isEnd ? 18 : 42))
      .on('tick', () => { this.draw(); this.savePosSoon(); }).on('end', () => this.savePos());
    // remembered controls (this browser): checkboxes and the hide slider; spring / LQI→length / pin mode have their own keys
    const PREFS = ['showEnd', 'showOne', 'showLql', 'showNames', 'showImg', 'routes', 'hide', 'imgsize'];
    const prefs = lsGet(LS.prefs, {});
    for (const id of PREFS) { const el = $(id); if (!(id in prefs)) continue; if (el.type === 'checkbox') el.checked = !!prefs[id]; else el.value = prefs[id]; }
    $('hideV').textContent = hideLabel(+$('hide').value);
    this.imgsize = +$('imgsize').value || 30; $('imgsizeV').textContent = this.imgsize;
    $('imgsize').oninput = () => { this.imgsize = +$('imgsize').value; $('imgsizeV').textContent = this.imgsize; this.applyImgSize(); };
    const savePrefs = () => { const o = {}; for (const id of PREFS) { const el = $(id); o[id] = el.type === 'checkbox' ? el.checked : +el.value; } lsSet(LS.prefs, o); };
    for (const id of PREFS) $(id).addEventListener($(id).type === 'checkbox' ? 'change' : 'input', savePrefs);
    $('showEnd').onchange = () => this.render(); $('showOne').onchange = () => this.render();
    $('showLql').onchange = () => this.glq.selectAll('text').style('display', $('showLql').checked ? null : 'none');
    $('showNames').onchange = () => this.gn.selectAll('g.node text').style('display', $('showNames').checked ? null : 'none');
    $('showImg').onchange = () => { const on = $('showImg').checked; this.gn.selectAll('image.img, circle.imgbg').style('display', on ? null : 'none'); this.gn.classed('imgs', on); this.applyImgSize(); };
    this.gn.classed('imgs', $('showImg').checked);
    $('hide').oninput = () => { $('hideV').textContent = hideLabel(+$('hide').value); this.render(); };
    $('spring').value = this.spring; $('springV').textContent = this.spring.toFixed(1);
    $('spring').oninput = () => { this.spring = +$('spring').value; $('springV').textContent = this.spring.toFixed(1); lsSet(LS.spring, this.spring); this.sim.force('link').distance(dist); this.sim.force('charge').strength(charge); this.sim.alpha(0.5).restart(); };
    $('lqilen').value = this.lqilen; $('lqilenV').textContent = this.lqilen.toFixed(2).replace(/0$/, '');
    $('lqilen').oninput = () => { this.lqilen = +$('lqilen').value; $('lqilenV').textContent = this.lqilen.toFixed(2).replace(/0$/, ''); lsSet(LS.lqilen, this.lqilen); this.sim.force('link').distance(dist); this.sim.alpha(0.5).restart(); };
    this.pinMode = !!lsGet(LS.pin, false); $('pinmode').checked = this.pinMode;
    $('pinmode').onchange = () => { this.pinMode = $('pinmode').checked; lsSet(LS.pin, this.pinMode); };
    $('find').oninput = () => this.applySel();
    $('unpin').onclick = () => { if (!this.data) return; for (const n of this.data.nodes) n.fx = n.fy = null; this.savePos(); this.sim.alpha(0.6).restart(); this.draw(); };
    $('relayout').onclick = () => this.sim.alpha(0.8).restart();
    $('resetview').onclick = () => { this.svg.transition().duration(300).call(this.zoom.transform, d3.zoomIdentity); };
    $('png').onclick = () => this.savePng();
    $('resetall').onclick = () => {
      for (const k of [LS.prefs, LS.spring, LS.lqilen, LS.pin, LS.pos, LS.view]) { try { localStorage.removeItem(k); } catch (e) {} }
      const keep = this.data ? { map: lsGet(LS.map, null) } : null;
      this.sim.stop(); clearTimeout(this._posT); this.data = null; this.selected = null; this.warm = false; this._zoomT = null;
      if (this._storeSub) { try { this._storeSub(); } catch (e) {} this._storeSub = null; }
      this.build();   // rebuilds the bar and the graph with defaults; the cached map is re-read from storage
    };
  }
  // turn every node (positions, pins and velocities) by da radians around a point in graph coordinates
  rotateAll(da, [ox, oy]) {
    const c = Math.cos(da), s = Math.sin(da);
    for (const n of this.data.nodes) {
      if (n.x == null) continue;
      const dx = n.x - ox, dy = n.y - oy; n.x = ox + dx * c - dy * s; n.y = oy + dx * s + dy * c;
      if (n.fx != null) { const fx = n.fx - ox, fy = n.fy - oy; n.fx = ox + fx * c - fy * s; n.fy = oy + fx * s + fy * c; }
      if (n.vx) { const vx = n.vx, vy = n.vy || 0; n.vx = vx * c - vy * s; n.vy = vx * s + vy * c; }
    }
    this.draw();
  }
  // graph state: every node's last position (pinned ones flagged) + the zoom/pan view, so a revisit starts where you left off
  savePos() { const o = {}; if (this.data) for (const n of this.data.nodes) if (n.x != null) o[n.id] = [Math.round(n.x), Math.round(n.y), n.fx != null ? 1 : 0]; lsSet(LS.pos, o); }
  savePosSoon() { clearTimeout(this._posT); this._posT = setTimeout(() => this.savePos(), 1500); }
  saveView() { if (this._zoomT) lsSet(LS.view, { k: this._zoomT.k, x: this._zoomT.x, y: this._zoomT.y }); }
  visible() {
    const $ = this.$, se = $('showEnd').checked, so = $('showOne').checked, hv = +$('hide').value;
    const nodes = this.data.nodes.filter(n => se || !n.isEnd);
    const vis = new Set(nodes.map(n => n.id));
    const sel = this.selected;
    const links = [];
    for (const l of this.data.links) {
      if (!vis.has(l.s.id) || !vis.has(l.t.id)) continue;
      const normal = (so || !l.oneSided) && (l.oneSided || hideOk(l.min, hv));
      l.revealed = !normal && !!sel && (l.s === sel || l.t === sel);   // shown only because of the selection: drawn, but no force
      if (normal || l.revealed) links.push(l);
    }
    return { nodes, links };
  }
  render() {
    if (!this.data) return;
    const { nodes, links } = this.visible(), self = this, byId = this.data.byId, $ = this.$;
    const color = l => l.oneSided ? '#8a8f99' : l.min >= 80 ? 'var(--green)' : l.min >= 50 ? 'var(--orange)' : 'var(--red)';
    const width = l => l.oneSided ? 1 : l.endLink ? 1.2 : 1 + 2.5 * Math.min(l.min, 200) / 200;
    const fmt = v => v == null ? '–' : v, key = l => l.s.id + '|' + l.t.id;
    // routing-table entries, identical ones collapsed (tables often hold a dozen inactive entries for one destination)
    const routesText = rs => { const c = {}; for (const r of rs) { const k = `${byId[r.via]?.name ?? r.via} → nwk ${r.to} ${r.status}`; c[k] = (c[k] || 0) + 1; } return Object.entries(c).map(([k, n]) => n > 1 ? `${k} ×${n}` : k).join('; '); };
    // each link = a group with the visible line and a wide invisible "hit" line for hovering
    const link = this.gl.selectAll('g.link').data(links, key); link.exit().remove();
    const le = link.enter().append('g').attr('class', 'link');
    le.append('line').attr('class', 'vis'); le.append('line').attr('class', 'hit');
    const lm = le.merge(link);
    lm.select('line.vis').attr('stroke', color).attr('stroke-width', width).attr('stroke-dasharray', l => l.oneSided ? '4 4' : null);
    lm.select('line.hit')
      .on('mouseenter', (e, l) => this.showTip(e, `<div class="big"><span style="color:${lqColor(l.lqS)}">${fmt(l.lqS)}</span> <span style="color:var(--muted)">/</span> <span style="color:${lqColor(l.lqT)}">${fmt(l.lqT)}</span></div>` +
        esc(`${l.s.name}  ⟷  ${l.t.name}\n${l.s.name} hears ${l.t.name}: ${fmt(l.lqS)}  (${REL[l.relS] ?? '–'})\n${l.t.name} hears ${l.s.name}: ${fmt(l.lqT)}  (${REL[l.relT] ?? '–'})` + (l.routes.length ? `\nroutes: ${routesText(l.routes)}` : '')), true))
      .on('mousemove', e => this.moveTip(e)).on('mouseleave', () => this.hideTip());
    const lql = this.glq.selectAll('text').data(links, key); lql.exit().remove();
    lql.enter().append('text').attr('class', 'lql').attr('text-anchor', 'middle').merge(lql).text(l => `${fmt(l.lqS)} / ${fmt(l.lqT)}`).style('display', $('showLql').checked ? null : 'none');
    const node = this.gn.selectAll('g.node').data(nodes, n => n.id); node.exit().remove();
    const ne = node.enter().append('g').attr('class', 'node').call(d3.drag()
      .on('start', (e, d) => { d._moved = false; d._wasPinned = d.fx != null; d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { if (!d._moved) { d._moved = true; self.sim.alphaTarget(0.25).restart(); } d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => {
        if (!d._moved) { if (!d._wasPinned) { d.fx = d.fy = null; } return; }   // plain click: nothing moved, nothing heats
        if (!e.active) self.sim.alphaTarget(0);
        if (!(self.pinMode || e.sourceEvent?.shiftKey)) { d.fx = d.fy = null; }
        self.savePos(); self.draw();
      }))
      // single click (delayed so a double-click does not also select) toggles the neighbour view, double-click toggles the pin
      .on('click', (e, d) => { e.stopPropagation(); clearTimeout(self._clickT); self._clickT = setTimeout(() => { self.selected = self.selected === d ? null : d; self._selOnly = true; self.render(); }, 260); })
      .on('dblclick', (e, d) => { e.stopPropagation(); clearTimeout(self._clickT); if (d.fx != null) { d.fx = d.fy = null; self.sim.alpha(0.3).restart(); } else { d.fx = d.x; d.fy = d.y; } self.savePos(); self.draw(); })
      .on('mouseenter', (e, d) => this.showTip(e, `${d.name}\n${d.type}${d.vendor ? ` · ${d.vendor} ${d.model}` : ''}${d.desc ? `\n${d.desc}` : ''}\nIEEE ${d.id}${d.nwk != null ? `  nwk ${d.nwk}` : ''}${d.lastSeen ? `\nlast seen ${new Date(d.lastSeen).toLocaleString()}` : ''}\nlinks: ${this.data.links.filter(l => l.s === d || l.t === d).length}`))
      .on('mousemove', e => this.moveTip(e)).on('mouseleave', () => this.hideTip());
    ne.append('circle').attr('class', 'halo').attr('r', d => d.type === 'Coordinator' ? 22 : d.isEnd ? 11 : 19);
    ne.append('circle').attr('class', 'ring').attr('r', d => d.type === 'Coordinator' ? 15 : d.isEnd ? 7 : 12).attr('fill', 'none').attr('stroke', 'none').attr('stroke-width', 2);
    ne.each(function (d) {
      const s = d3.select(this);
      if (d.type === 'Coordinator') s.append('circle').attr('class', 'shape').attr('r', 11).attr('fill', 'var(--yellow)').attr('stroke', '#000');
      else if (d.isEnd) s.append('circle').attr('class', 'shape').attr('r', 4).attr('fill', '#9aa3b2').attr('stroke', '#000');
      else s.append('rect').attr('class', 'shape').attr('x', -8).attr('y', -8).attr('width', 16).attr('height', 16).attr('rx', 3).attr('fill', 'var(--blue)').attr('stroke', '#000');
    });
    const withImg = ne.filter(d => d.type !== 'Coordinator' && imgUrl(d.model));
    withImg.append('circle').attr('class', 'imgbg').attr('r', d => d.isEnd ? 14 : 21).style('display', $('showImg').checked ? null : 'none');
    withImg.append('image').attr('class', 'img')
      .attr('href', d => imgUrl(d.model)).attr('preserveAspectRatio', 'xMidYMid meet').style('display', $('showImg').checked ? null : 'none')
      .on('error', function () { const g = this.parentNode; this.remove(); g.querySelector('circle.imgbg')?.remove(); d3.select(g).select('text').attr('dy', g.__data__.isEnd ? 14 : 22); });
    ne.append('text').attr('dy', d => d.isEnd ? 14 : 22).attr('text-anchor', 'middle').text(d => d.name).style('display', $('showNames').checked ? null : 'none');
    this.gn.selectAll('g.node').classed('end', d => d.isEnd).classed('stale', d => d.stale);
    this.applyImgSize();
    // weak gravity toward the canvas centre so nodes that lose all visible links do not fly off; stronger for isolated ones
    const deg = {}; for (const l of links) { deg[l.s.id] = (deg[l.s.id] || 0) + 1; deg[l.t.id] = (deg[l.t.id] || 0) + 1; }
    const cv = $('canvas'), cx = cv.clientWidth / 2, cy = cv.clientHeight / 2, grav = d => deg[d.id] ? 0.03 : 0.15;
    this.sim.force('x', d3.forceX(cx).strength(grav)).force('y', d3.forceY(cy).strength(grav));
    this.sim.nodes(nodes); this.sim.force('link').links(links);
    for (const n of nodes) if (n.x == null) { n.x = cx + (Math.random() - 0.5) * 80; n.y = cy + (Math.random() - 0.5) * 80; }
    if (!this.warm) { this.warm = true; this.sim.force('center', d3.forceCenter(cx, cy)); this.sim.alpha(1); for (let i = 0; i < 250; i++) this.sim.tick(); }
    if (this._selOnly) { for (const l of links) { l.source = l.s; l.target = l.t; } this.draw(); }   // selection: redraw in place, no physics
    else this.sim.alpha(this._gentle ? 0.15 : 0.5).restart();
    this._selOnly = false; this._gentle = false;
    this.applySel();
  }
  // image, backing disc, label offset and collision radius follow the image-size slider
  applyImgSize() {
    if (!this.gn) return;
    const on = this.$('showImg').checked, S0 = this.imgsize || 30;
    this.gn.selectAll('g.node').each(function (d) {
      const S = d.isEnd ? Math.round(S0 * 0.67) : S0, r = S / 2 + 6, g = d3.select(this), has = !!this.querySelector('image.img');
      g.select('image.img').attr('width', S).attr('height', S).attr('x', -S / 2).attr('y', -S / 2);
      g.select('circle.imgbg').attr('r', r);
      g.select('text').attr('dy', has && on ? r + 11 : d.isEnd ? 14 : 22);
    });
    this.sim?.force('collide')?.radius(d => d.isEnd ? Math.max(18, on ? S0 * 0.33 + 10 : 0) : Math.max(42, on ? S0 / 2 + 14 : 0));
  }
  draw() {
    this.gl.selectAll('g.link').each(function (l) { for (const ln of this.children) { ln.setAttribute('x1', l.source.x); ln.setAttribute('y1', l.source.y); ln.setAttribute('x2', l.target.x); ln.setAttribute('y2', l.target.y); } });
    this.glq.selectAll('text').attr('x', l => (l.source.x + l.target.x) / 2).attr('y', l => (l.source.y + l.target.y) / 2 - 3);
    this.gn.selectAll('g.node').attr('transform', d => `translate(${d.x},${d.y})`).classed('pinned', d => d.fx != null);
  }
  applySel() {
    if (!this.data) return;
    const q = this.$('find').value.trim().toLowerCase(), sel = this.selected;
    const matches = q ? new Set(this.data.nodes.filter(n => n.name.toLowerCase().includes(q)).map(n => n.id)) : null;
    const keep = new Set();
    if (sel) { keep.add(sel.id); this.gl.selectAll('g.link').each(l => { if (l.s === sel) keep.add(l.t.id); if (l.t === sel) keep.add(l.s.id); }); }
    const active = sel ? keep : matches;
    const linkOn = l => !active || (sel ? (l.s === sel || l.t === sel) : (active.has(l.s.id) || active.has(l.t.id)));
    this.gn.selectAll('g.node').classed('dim', d => active && !active.has(d.id)).classed('sel', d => d === sel || (matches && matches.has(d.id) && !sel));
    this.gl.selectAll('g.link').classed('dim', l => !linkOn(l));
    this.glq.selectAll('text').classed('dim', l => !linkOn(l));
  }
  showTip(e, text, html = false) { const t = this.tip.style('display', 'block'); if (html) t.html(text); else t.text(text); this.moveTip(e); }
  moveTip(e) { const c = this.$('canvas').getBoundingClientRect(); this.tip.style('left', Math.min(e.clientX - c.left + 14, c.width - 400) + 'px').style('top', (e.clientY - c.top + 14) + 'px'); }
  hideTip() { this.tip.style('display', 'none'); }
  savePng() {
    const svgEl = this.svg.node(), c = this.$('canvas'), w = c.clientWidth, h = c.clientHeight;
    const cs = getComputedStyle(this), bg = cs.getPropertyValue('--primary-background-color').trim() || '#1c2027';
    const vars = ['--red', '--orange', '--green', '--blue', '--yellow', '--bgc', '--muted', '--primary-text-color'].map(v => `${v}:${cs.getPropertyValue(v).trim()}`).join(';');
    let xml = new XMLSerializer().serializeToString(svgEl).replace(/<image\b[^>]*\/>|<image\b[^>]*>.*?<\/image>/gs, '');   // remote images would taint the canvas
    const css = STYLE.replace(/:host\s*{[^}]*}/, '').replace(/#\w+\s*{[^}]*}/g, '');
    xml = xml.replace('<svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" style="${vars};background:${bg};font:13px system-ui,sans-serif"`).replace('>', `><style>${css}</style>`);
    const img = new Image(), cv = document.createElement('canvas'); cv.width = w * 2; cv.height = h * 2;
    img.onload = () => { const ctx = cv.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height); ctx.scale(2, 2); ctx.drawImage(img, 0, 0); const a = document.createElement('a'); a.download = `zigbee_map_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`; a.href = cv.toDataURL('image/png'); a.click(); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  }
}
customElements.define('zigbee-map-panel', ZigbeeMapPanel);
