/* zigbee2mqtt-map-panel: Zigbee2MQTT's network map as a Home Assistant sidebar panel.
 * Served and registered by the zigbee2mqtt_map integration (custom_components/zigbee2mqtt_map), which talks to Zigbee2MQTT
 * over MQTT, keeps the last map and runs the background schedule. This file only renders: it subscribes to the
 * integration's websocket events (status, map, progress, error) and asks for scans with one websocket command.
 * d3.v7.min.js is loaded from next to this file.
 */
const VERSION = '2.3.0';
console.info(`%c zigbee2mqtt-map-panel %c v${VERSION} `, 'background:#f5a623;color:#000;font-weight:bold', 'background:#333;color:#fff');
const WS = { subscribe: 'zigbee2mqtt_map/subscribe', scan: 'zigbee2mqtt_map/scan', permitJoin: 'zigbee2mqtt_map/permit_join' };
const FIT_MS = 380;   // fit view: turn and zoom together, eased out
const SETTLE_ALPHA = 0.06;   // a fresh layout counts as mostly settled below this simulation energy (about 1.7 s after a start at 0.5): the deferred fit happens then, not at full rest
const RAMP_TICKS = 60;   // forces fade in over this many simulation ticks after a restart (about a second at 60 fps; see wake)
const CHARGE_EXPONENT = 1.2;   // repulsion falls off as 1/distance^p: d3's own charge is p = 1 (a dense cluster pushes a lone node far away), 2 is inverse-square; strengths are normalised at CHARGE_REF px so the near field stays as it was
const CHARGE_REF = 100;
const FADED_PULL = 0.2;   // pull of a link hidden by Min LQI, relative to a shown one (0 = the old behaviour: hidden links left the layout)
const JOIN_SECONDS = 254;   // Zigbee2MQTT's maximum; it closes the network itself when the time is up
const mmss = ms => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const SET = { bg: 'background_hours', live: 'viewing_minutes', parallel: 'parallel' };   // setting names as the integration stores them
const BASE = new URL('.', import.meta.url).href;
const REL = { 0: 'parent', 1: 'child', 2: 'sibling', 3: 'none', 4: 'previous child' };
const LS = { map: 'z2m_panel_map_v1', pos: 'z2m_map_positions_v2', view: 'z2m_map_view_v1', spring: 'z2m_map_spring', lqilen: 'z2m_map_lqilen', pin: 'z2m_map_pin', prefs: 'z2m_map_prefs_v1', sel: 'z2m_map_sel_v1', avoid: 'z2m_map_avoid', devSort: 'z2m_map_devsort_v1', hideSet: 'z2m_map_hide_user', hideMode: 'z2m_map_hide_mode' };

let d3Ready;
function loadD3() {
  if (window.d3) return Promise.resolve(window.d3);
  d3Ready ??= new Promise((res, rej) => { const s = document.createElement('script'); s.src = BASE + 'd3.v7.min.js'; s.onload = () => res(window.d3); s.onerror = () => rej(new Error('d3 failed to load from ' + s.src)); document.head.appendChild(s); });
  return d3Ready;
}
// hide slider: 0 = show all, otherwise hide links with LQI <= v (weaker direction). Bad links are found by colour, not by hiding good ones.
const hideOk = (lq, v) => v > 0 ? lq > v : true;
const hideLabel = v => v > 0 ? `> ${v}` : 'off';
const imgUrl = m => m ? `https://www.zigbee2mqtt.io/images/devices/${String(m).replace(/[/:\s]/g, '-')}.png` : null;
const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = ms => ms < 60e3 ? 'just now' : ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : ms < 86400e3 ? `${(ms / 3600e3).toFixed(1)} h ago` : `${(ms / 86400e3).toFixed(1)} d ago`;
const LQ = { red: '#e5484d', orange: '#f5a623', green: '#46c36a', green2: '#22d66f', grey: '#8a8f99' };
let lqScale = null;   // built once d3 is loaded
const lqSmooth = v => (lqScale ??= d3.scaleLinear().domain([0, 50, 80, 255]).range([LQ.red, LQ.orange, LQ.green, LQ.green2]).interpolate(d3.interpolateHcl).clamp(true))(v);
const lqColor = v => v == null || v === 0 ? LQ.grey : lqSmooth(v);
const FOOT = `
  <span id="scanGrp"><button id="pull" class="primary icon" title="pull a fresh map: scan the network now" aria-label="pull a fresh map"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z"/></svg></button><span id="status"></span></span>
  <a id="gear" href="/config/integrations/integration/zigbee2mqtt_map" data-nav title="integration settings: Zigbee2MQTT frontend URL, sidebar title, administrators only · entities, reload">⚙</a>
`;
const LQ_GRADIENT = `linear-gradient(to right, ${LQ.red} 0%, ${LQ.orange} ${50 / 2.55}%, ${LQ.green} ${80 / 2.55}%, ${LQ.green2} 100%)`;
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
// label as up to three lines of tspans, broken at spaces to fit maxW px (measured with a canvas, so hidden labels wrap too);
// the first tspan carries no dy of its own, the text element's dy keeps positioning the first line
function wrapLabel(textEl, name, maxW) {
  const cs = getComputedStyle(textEl), ctx = (wrapLabel._c ??= document.createElement('canvas').getContext('2d'));
  ctx.font = `${cs.fontWeight || 400} ${cs.fontSize || '11px'} ${cs.fontFamily || 'sans-serif'}`;
  const width = t => ctx.measureText(t).width, words = String(name).split(/\s+/).filter(Boolean), lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (!cur || width(next) <= maxW) cur = next; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > 3) { lines.length = 3; lines[2] += '…'; }
  const sel = d3.select(textEl); sel.text(null);
  lines.forEach((t, i) => { const ts = sel.append('tspan').attr('x', 0).text(t); if (i) ts.attr('dy', '1.15em'); });
}

// raw map -> {nodes, links}; source = neighbour, target = reporting device, lqi = what the target hears from the source
// The two mesh numbers (connected ≥ C, redundant ≥ R, what limits each) come with the map from the integration, which
// computes them after every scan (custom_components/zigbee2mqtt_map/mesh.py): one implementation, the sensors and the
// footer can never disagree.

function mergeMap(map) {
  const nodes = map.nodes.map(n => ({ id: n.ieeeAddr, name: n.friendlyName || n.ieeeAddr, type: n.type, nwk: n.networkAddress, lastSeen: n.lastSeen ?? null, failed: n.failed || [], removed: !!n.removed,
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
  #wrap { position:relative; height:100%; overflow:hidden; display:flex; flex-direction:column; }
  #bar, #foot { flex:none; }
  #foot { order:3; display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; padding:5px 10px; background:var(--panel); border-top:1px solid var(--divider-color,#333); }
  #wrap.swap #bar { order:3; border-bottom:0; border-top:1px solid var(--divider-color,#333); }
  #wrap.swap #foot { order:1; border-top:0; border-bottom:1px solid var(--divider-color,#333); }
  #wrap.swap details.dd .menu { top:auto; bottom:calc(100% + 4px); }   /* controls at the bottom: menus open upwards */
  #bar { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; padding:6px 10px; background:var(--panel); border-bottom:1px solid var(--divider-color,#333); }
  #bar label { display:flex; gap:5px; align-items:center; white-space:nowrap; }
  #bar input[type=text] { background:var(--bgc); color:inherit; border:1px solid var(--divider-color,#444); border-radius:4px; padding:3px 6px; width:190px; max-width:45vw; }
  #bar input[type=range] { width:90px; }
  #lq { display:flex; align-items:center; white-space:nowrap; padding-top:4px; }
  #bar button, #foot button { background:var(--bgc); color:inherit; border:1px solid var(--divider-color,#444); border-radius:4px; padding:3px 8px; cursor:pointer; }
  #bar button:hover, #foot button:hover { border-color:#888; }
  #bar button.primary, #foot button.primary { border-color:var(--primary-color,#03a9f4); color:var(--primary-color,#03a9f4); }
  #status { color:var(--muted); }
  #scanGrp { flex:1; display:flex; gap:8px; align-items:center; min-width:0; }
  #foot button#pull { flex:none; padding:3px 6px; line-height:0; } #foot button#pull:disabled { opacity:.5; cursor:default; }
  #side { position:absolute; top:0; right:0; bottom:0; width:min(100%, max(440px, 46%)); display:none; flex-direction:column; background:var(--panel); border-left:1px solid var(--divider-color,#333); box-shadow:-6px 0 18px rgba(0,0,0,.35); z-index:5; }
  #side.show { display:flex; }
  #side .sidebar { display:flex; gap:10px; align-items:center; padding:5px 10px; border-bottom:1px solid var(--divider-color,#333); font-size:12px; }
  #side .sidebar span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #side .sidebar a { color:var(--primary-color,#03a9f4); text-decoration:none; }
  #side .sidebar button { background:var(--bgc); color:inherit; border:1px solid var(--divider-color,#444); border-radius:4px; padding:2px 8px; cursor:pointer; }
  #side iframe { flex:1; border:0; width:100%; background:#fff; }
  #gear { color:var(--muted); text-decoration:none; font-size:17px; line-height:1; padding:0 2px; } #gear:hover { color:var(--primary-text-color,#fff); }
  #stale { display:none; flex-basis:100%; padding:6px 10px; background:var(--warning-color,#f5a623); color:#000; border-radius:4px; }
  #stale.show { display:block; }
  #stale button { margin-left:10px; font:inherit; padding:2px 10px; border-radius:4px; border:1px solid #0006; background:#fff8; cursor:pointer; }
  #status .mesh { color:var(--primary-text-color,#dfe3ea); cursor:pointer; text-decoration:underline dotted; }
  details.dd { position:relative; }
  details.dd summary { list-style:none; cursor:pointer; background:var(--bgc); border:1px solid var(--divider-color,#444); border-radius:4px; padding:3px 8px; user-select:none; }
  details.dd summary::-webkit-details-marker { display:none; }
  details.dd summary i.arr { display:inline-block; width:0; height:0; margin-left:3px; vertical-align:middle; border:4px solid transparent; border-top:5px solid currentColor; border-bottom:0; }
  #wrap.swap details.dd summary i.arr { border-top:0; border-bottom:5px solid currentColor; }   /* menus open upwards there */
  details.dd .menu { position:absolute; top:calc(100% + 4px); left:0; z-index:6; display:flex; flex-direction:column; gap:8px; box-sizing:border-box; min-width:min(var(--mw,250px), var(--avail,100vw)); max-width:var(--avail,100vw); max-height:var(--availH,80vh); overflow:auto; padding:10px 12px; background:var(--panel); border:1px solid var(--divider-color,#444); border-radius:6px; box-shadow:0 4px 14px rgba(0,0,0,.4); }
  details.dd .menu .row { display:flex; gap:6px; flex-wrap:wrap; }
  details.dd .menu .sep { border-top:1px solid var(--divider-color,#444); margin:2px 0; }
  details.dd .menu .note { color:var(--muted); font-size:11px; }
  details.dd .menu select { background:var(--bgc); color:inherit; border:1px solid var(--divider-color,#444); border-radius:4px; padding:2px 4px; }
  details.dd .menu input[type=number] { width:64px; background:var(--bgc); color:inherit; border:1px solid var(--divider-color,#444); border-radius:4px; padding:2px 4px; }
  details#help .menu { gap:6px; font-size:12px; line-height:1.45; }
  /* help: the term as a small heading, its explanation indented below it */
  details#help .menu { --mw:560px; }
  details#help dl { margin:0; }
  details#help dl > div { padding-top:8px; }
  details#help dt { color:var(--primary-text-color); font-weight:600; }
  details#help dd { margin:2px 0 0 14px; color:var(--muted); overflow-wrap:anywhere; }
  details.dd .menu h4 { margin:6px 0 -2px; font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  details.dd .menu h4:first-child { margin-top:0; }
  details.dd .menu .grp { display:flex; flex-direction:column; gap:8px; margin-left:14px; }
  details#help p.ver { margin:8px 0 0; color:var(--muted); font-size:11px; }
  details#help table.keys { border-collapse:collapse; margin:2px 0 4px; } details#help table.keys td { padding:1px 10px 1px 0; vertical-align:top; white-space:nowrap; } details#help table.keys td:last-child { white-space:normal; }
  details#help kbd { font:inherit; padding:0 4px; border:1px solid var(--divider-color,#555); border-radius:3px; }
  details#devs .menu { --mw:640px; max-height:min(var(--availH,70vh), 640px); gap:4px; }
  details#devs td.name { white-space:normal; min-width:90px; }

  details#devs table { border-collapse:collapse; font-size:12px; user-select:none; }
  details#devs tr.sub th { border-top:6px solid var(--panel); }
  details#devs th[data-sort] { cursor:pointer; } details#devs th[data-sort]:hover { color:var(--primary-text-color,#fff); } details#devs th.sorted { color:var(--primary-text-color,#fff); }
  details#devs th { text-align:left; color:var(--muted); font-weight:normal; padding:3px 10px 3px 4px; white-space:nowrap; background:var(--bgc); }
  details#devs th:first-child { border-radius:4px 0 0 4px; } details#devs th:last-child { border-radius:0 4px 4px 0; }
  details#devs tr.head + tr td { padding-top:5px; }
  details#devs td { padding:2px 10px 2px 4px; white-space:nowrap; }
  details#devs td.name { cursor:pointer; max-width:260px; overflow:hidden; text-overflow:ellipsis; } details#devs td.name:hover { text-decoration:underline; }
  details#devs td.name { color:var(--primary-color,#03a9f4); }   /* every name selects its node: styled as a link */
  details#devs tr.sel td.name { font-weight:600; }
  details#devs td.lq { font-variant-numeric:tabular-nums; }
  details#devs a { color:var(--primary-color,#03a9f4); text-decoration:none; margin-right:8px; }
  details#devs a:hover { text-decoration:underline; }
  details#devs .muted { color:var(--muted); }
  details#help code { font-size:11px; }
  details#help a { color:var(--primary-color,#03a9f4); }
  details.dd .menu input[type=range] { width:120px; }
  #lq span.grad { position:relative; display:inline-block; width:204px; height:6px; border-radius:3px; vertical-align:middle; margin:0 12px 10px 8px; }
  #lq span.grad { cursor:pointer; touch-action:none; } #lq span.grad.drag { cursor:ew-resize; }
  #lq span.grad::before { content:''; position:absolute; left:-4px; right:-4px; top:-8px; bottom:-14px; }   /* bigger hit area */
  #lq span.grad b.mk { position:absolute; top:-8px; width:0; height:0; transform:translateX(-50%); border:5px solid transparent; border-top:6px solid var(--primary-text-color,#fff); border-bottom:0; pointer-events:none; }
  #lq span.grad i { position:absolute; top:6px; transform:translateX(-50%); font-style:normal; font-size:9px; color:var(--muted); }
  #tip.touch, #tip.pinned { pointer-events:auto; }
  #tip.pinned { cursor:pointer; border-color:var(--primary-color,#03a9f4); }
  #tip .tiplinks { margin-top:6px; display:flex; flex-wrap:wrap; gap:4px 12px; } #tip .tipjoin { margin-top:4px; } #tip .tiplinks a { white-space:nowrap; } #tip .tiplinks a { color:var(--primary-color,#03a9f4); text-decoration:none; font-weight:600; cursor:pointer; }
  #tip .routes { margin-top:6px; border-top:1px solid var(--divider-color,#444); padding-top:4px; white-space:normal; }
  #tip .routes .h { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin-bottom:2px; }
  #tip .routes .rt { margin:2px 0 0 10px; text-indent:-10px; }
  #tip .path { margin-top:4px; white-space:normal; }
  #tip .tiphint { margin-top:4px; font-size:10px; color:var(--muted); } #tip .muted { color:var(--muted); }
  #tip { position:absolute; pointer-events:none; background:var(--panel); color:inherit; border:1px solid var(--divider-color,#444); border-radius:6px; padding:6px 9px; font-size:12px; max-width:min(380px, calc(100% - 8px)); box-sizing:border-box; overflow-wrap:anywhere; display:none; white-space:pre-line; z-index:3; box-shadow:0 2px 8px rgba(0,0,0,.4); }
  #canvas > svg { position:absolute; inset:0; width:100%; height:100%; user-select:none; -webkit-user-select:none; }   /* labels are not selectable text: Shift-click / double-click would otherwise start a selection */
  #tip .big { font-size:22px; font-weight:600; line-height:1.1; margin-bottom:3px; }
  #tip .title { font-size:16px; font-weight:600; line-height:1.2; margin-bottom:2px; }
  #canvas { position:relative; order:2; flex:1 1 auto; min-height:0; }
  .link line.vis { stroke-linecap:butt; pointer-events:none; }
  .link path.arr { pointer-events:none; }
  .link.onpath line.vis { stroke-width:12px !important; }   /* the selected router's path to the coordinator */
  .link line.hit { stroke:transparent; stroke-width:6px; }
  .link.dim, .lql.dim { opacity:0.3; }
  .node.dim .shape, .node.dim .ring, .node.dim .halo, .node.dim image.img, .node.dim text { opacity:0.3; }
  /* removed from Zigbee2MQTT after the scan: grey in the browser only (the filter greys the photo, the opacity makes the mostly white pictures read as grey) */
  .node.removed { filter:grayscale(1); opacity:.55; }
  .link.removed line.vis, .link.removed path.arr, .lql.removed { filter:grayscale(1); opacity:.45; }
  details#devs tr.removed td { color:var(--muted); } details#devs tr.removed td.name { text-decoration:line-through; }
  #bar button#join.open { font-variant-numeric:tabular-nums; } #bar button#join:disabled { opacity:.6; cursor:default; }
  #toast { position:absolute; top:10px; left:50%; transform:translateX(-50%); max-width:min(90%, 420px); box-sizing:border-box; background:var(--panel); color:var(--primary-text-color,#dfe3ea); border:1px solid var(--primary-color,#03a9f4); border-radius:8px; padding:6px 12px; font-size:13px; box-shadow:0 4px 14px #0008; z-index:7; pointer-events:none; opacity:0; transition:opacity .25s; }
  #toast.show { opacity:1; } #toast.bad { border-color:var(--orange); color:var(--orange); }   /* the pairing feed: joined → interviewing → paired */
  .lql { pointer-events:none; }
  .lql text { font-size:9px; font-weight:600; fill:#10131a; }
  .node text { font-size:11px; fill:var(--primary-text-color,#dfe3ea); paint-order:stroke; stroke:var(--bgc); stroke-width:3px; pointer-events:none; }
  .node.end text { font-size:9.5px; fill:var(--muted); }
  .node, .node * { cursor:pointer; }   /* a node is clicked (select) far more often than dragged */
  .node circle.imgbg { fill:transparent; }   /* hit area + selection/pin ring only; own links stop at the rim (see draw) */
  g.imgs .node.hasimg .shape { display:none; }           /* the generic square/dot would show behind a small photo */
  .node .halo { fill:var(--yellow); fill-opacity:0; }
  .node.pinned .halo { fill-opacity:0.22; }
  .node.pinned .shape { stroke:var(--primary-text-color,#fff); }
  .node.stale .ring { stroke:var(--red); stroke-dasharray:3 2; }
  .node .orbit { display:none; } .node.joinopen .orbit { display:block; } .node .orbit .dot { fill:var(--primary-color,#03a9f4); stroke:var(--bgc); stroke-width:1px; }   /* open for joining: a dot circles the node */
  .node.sel .shape { stroke:var(--yellow); stroke-width:3px; }
  .node.sel circle.imgbg { stroke:var(--yellow); stroke-width:2px; }
  .node.pinned circle.imgbg { stroke:var(--primary-text-color,#fff); stroke-width:1px; }
  ha-menu-button { --mdc-icon-button-size:36px; }
`;

const BAR = `
  <ha-menu-button></ha-menu-button>
  <span id="lq" title="show only router links whose weaker direction is above this LQI · press or drag on the bar · far left: show all · hidden links still hold the layout together, so moving the bar changes what you see, not where things sit · until you move it, it follows the &quot;connected&quot; mesh number (click a mesh number in the footer to follow that one) · keys: ← → one step, ↑ ↓ next stop (0, redundant, connected, 255)">Min LQI <span class="grad" style="background:${LQ_GRADIENT}"><b class="mk"></b><i style="left:0">0</i><i style="left:${50 / 2.55}%">50</i><i style="left:${80 / 2.55}%">80</i><i style="left:100%">255</i></span><input type="range" id="hide" min="0" max="255" value="0" step="5" hidden><span id="hideV" hidden>off</span></span>
  <label title="highlight every node whose name contains the text; several terms separated by commas match any of them · the devices list is filtered the same way · key: /">find <input type="text" id="find" placeholder="search term, search term, …"></label>
  <button id="join" class="primary" title="let new devices join the network for 254 s (Zigbee2MQTT closes it again by itself); click again to close now · while open: every running countdown, and a dot circles each node the network is open through · a router's card offers 'permit join here' (and 'also here' while a join runs) for joining through that router · the new device appears at the edge and is selected once its interview succeeds · administrators only">permit join</button>
  <details id="devs" class="dd"><summary title="every device, or the selected one with its neighbours and both LQI directions · sortable by the column heads · a name selects the node, Z2M / HA open the device there · key: D (Shift-d)">devices <i class="arr"></i></summary><div class="menu" id="devMenu"></div></details>
  <details id="opts" class="dd"><summary title="what is shown, how it is laid out, when the integration scans · remembered in this browser (the scan settings are the integration's entities) · key: O (Shift-o)">options <i class="arr"></i></summary><div class="menu">
    <h4>Show</h4>
    <div class="grp">
    <label title="sensors, remotes, battery devices: one link each, to their parent router · hidden ones stay in the layout, so switching them on or off moves nothing · key: E (Shift-e)"><input type="checkbox" id="showEnd"> end devices</label>
    <label title="a ghost is an address in some router's neighbour table that is not in Zigbee2MQTT's device list: a removed device whose entries have not aged out. The devices list still shows them"><input type="checkbox" id="showGhosts"> show ghost devices</label>
    <label title="links only one side reported, or reported with LQI 0: usually a stale neighbour-table entry, drawn as a dashed grey hairline · they are not part of the mesh numbers"><input type="checkbox" id="showOne"> one-sided / stale links</label>
    <label title="when a node is selected, also reveal its one-sided (dashed) links; links Min LQI hides are always revealed for the selected node"><input type="checkbox" id="selOne"> one-sided / stale on selected node</label>
    <label title="links where every reporting side calls the other a 'sibling'. Careful: with EmberZNet coordinators this is the normal relationship between routers, so turning it off hides most of the mesh"><input type="checkbox" id="showSib" checked> sibling links</label>
    <label title="labels under the nodes · a hidden label still answers to find and shows in the card">show names for <select id="names"><option value="none">none</option><option value="routers" selected>routers only</option><option value="all">all devices</option></select></label>
    <label title="a pill on every link with both values: what the left-hand node hears / what the right-hand node hears · pills that do not fit a short link are left out"><input type="checkbox" id="showLql"> LQI labels</label>
    <label title="the info box that appears while the mouse rests on a node or a link; off: only the card a click opens"><input type="checkbox" id="hoverTips" checked> hover popups</label>
    <label id="routesCtl" title="draw what the routing tables say: links that carry active routes thicker (the more routes, the thicker) with an arrow at the end the traffic goes to; a selected router shows its path to the coordinator extra thick. 0: off · higher: thickness grows faster with the number of routes. Needs a scan with &quot;routes on pull&quot;">routes <input type="range" id="showRoutes" min="0" max="3" value="0" step="0.1"> <span id="showRoutesV">off</span></label>
    <div id="routesNote" class="note"></div>
    <label title="device photos from zigbee2mqtt.io (the browser fetches them, so this needs internet); nodes without a picture keep the generic shape"><input type="checkbox" id="showImg" checked> device images</label>
    </div>
    <h4>Layout</h4>
    <div class="grp">
    <label title="size of the nodes: the device images, or the squares and dots when images are off (end devices get two thirds) · zoom scales the whole map, this only the nodes against the links and labels">node size <input type="range" id="imgsize" min="16" max="64" value="24" step="2"> <span id="imgsizeV">24</span></label>
    <label title="overall distance between nodes, relative to their size (zoom scales everything, this only the spacing)">spacing <input type="range" id="spring" min="0.3" max="2" value="0.7" step="0.05"> <span id="springV">0.7</span></label>
    <label title="push nodes off drawn links they are not part of (and bend those links away); acts only within a small clearance around a link · 0: off">keep nodes off links <input type="range" id="avoid" min="0" max="2" value="1" step="0.1"> <span id="avoidV">1.0</span></label>
    <label title="how much a strong link is shorter than a weak one · 0: all links the same length · 1: weak links 2.5× longer than strong ones · 3: extreme">LQI contrast <input type="range" id="lqilen" min="0" max="3" value="1" step="0.05"> <span id="lqilenV">1.0</span></label>
    <label title="off: dragging only disentangles, the node floats again when released (hold Shift to pin anyway) · on: every dragged node stays where you drop it"><input type="checkbox" id="pinmode"> dragging pins nodes</label>
    <div class="row"><button id="unpin" title="release every pinned node (yellow halo) so the physics places it again · double-click pins or unpins a single node">unpin all</button><button id="relayout" title="run the physics again from the current positions, forces fading in; pinned nodes stay · key: r">re-layout</button><button id="resetview" title="turn the map to the shape of the window and zoom so everything drawn is in view (Shift-click: zoom only, no turning) · key: f">fit view</button></div>
    </div>
    <h4>Scans</h4>
    <div class="grp">
    <label title="also read every router's routing table on a pull (one more request per router; much slower without the networkmap_fast extension) · ticking it turns the routes overlay on if it was off · the overlay slider appears here while this is on"><input type="checkbox" id="routes"> pull routes (may take very long)</label>
    <label title="the integration scans on its own at this interval, whether anyone is looking or not; every scan is a sample for the mesh sensors (number entity &quot;Background scan interval&quot;; 0.25 h = 15 min). 0 = off">background scan every <input type="number" id="bgInt" min="0" max="24" step="0.25"> h</label>
    <label title="while this panel is open and visible it requests a scan at this interval; several open panels share one schedule (number entity &quot;Scan interval while viewing&quot;). 0 = off">scan while viewing every <input type="number" id="liveInt" min="0" max="60" step="1"> min</label>
    <div id="schedNote" class="note"></div>
    </div>
    <h4>Panel</h4>
    <div class="grp">
    <label title="the scan button and status line at the top and these controls at the bottom, within thumb reach on a phone (menus then open upwards)"><input type="checkbox" id="swapBars"> controls at the bottom</label>
    <div class="row"><button id="png" title="download the map as a picture at twice the screen resolution, with the current view and selection · device pictures are left out (browsers refuse to draw remote images into a file)">save PNG</button><button id="resetall" title="forget every option, pin, position and the view in this browser (the last map is kept), lay the map out afresh and fit it to the window">reset to defaults</button></div>
    </div>
  </div></details>
<details id="help" class="dd"><summary title="what the colours, shapes and numbers mean · the keys · key: h">help <i class="arr"></i></summary><div class="menu">
    <h4>Mouse</h4>
    <dl>
      <dt>keys</dt><dd><table class="keys">
        <tr><td><kbd>f</kbd></td><td>fit view: turn the map to the window and zoom to everything drawn</td></tr>
        <tr><td><kbd>F</kbd></td><td>fit view without turning</td></tr>
        <tr><td><kbd>r</kbd></td><td>re-layout, forces fading in</td></tr>
        <tr><td><kbd>E</kbd></td><td>show or hide end devices (<kbd>Shift</kbd>-<kbd>e</kbd>; plain <kbd>e</kbd> is Home Assistant's entity search)</td></tr>
        <tr><td><kbd>/</kbd></td><td>jump to the find box</td></tr>
        <tr><td><kbd>→</kbd> <kbd>←</kbd></td><td>Min LQI one step up or down</td></tr>
        <tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>Min LQI to the next stop: 0 · redundant · connected · 255 (a mesh stop is then followed on every new map)</td></tr>
        <tr><td><kbd>D</kbd> <kbd>O</kbd> <kbd>h</kbd></td><td>devices, options, help (<kbd>Shift</kbd>-<kbd>d</kbd>, <kbd>Shift</kbd>-<kbd>o</kbd>; <kbd>H</kbd> works too)</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>close the card, an open menu, leave the find box, or clear the selection, in that order</td></tr>
        <tr><td><kbd>Ctrl</kbd>-<kbd>A</kbd></td><td>select every node shown; again: none · <kbd>Ctrl</kbd>-<kbd>Shift</kbd>-<kbd>A</kbd> clears</td></tr>
      </table>Home Assistant's own keys keep working here (e.g. <kbd>e</kbd>, <kbd>d</kbd>, <kbd>c</kbd>, <kbd>?</kbd>)</dd>
      <dt>drag background · wheel</dt><dd>pan · zoom (<kbd>Ctrl</kbd>-wheel is left to the browser)</dd>
      <dt><kbd>Ctrl</kbd>-drag · middle-drag · two-finger twist</dt><dd>rotate the whole map (around the centre of the view, or between the fingers); positions and pins turn with it</dd>
      <dt>drag node</dt><dd>disentangle; the node floats again when released, a pinned node stays pinned where you drop it. <kbd>Shift</kbd>-drag pins it (or turn on "drag pins nodes" in options)</dd>
      <dt>double-click node</dt><dd>pin / unpin. Pinned nodes carry a yellow halo and keep their place across scans and reloads</dd>
      <dt>click node · click background</dt><dd>show that node with all its links, including the ones the hide slider would hide (one-sided links too if "one-sided / stale on selected node" is ticked), and fade the rest · back to normal. <kbd>Ctrl</kbd>- or <kbd>Shift</kbd>-click adds or removes nodes, in the devices list too. <kbd>Ctrl</kbd>-<kbd>A</kbd> selects every node on the map (again: none), <kbd>Esc</kbd> or <kbd>Ctrl</kbd>-<kbd>Shift</kbd>-<kbd>A</kbd> clears the selection</dd>
      <dt>hover node / link</dt><dd>model, last seen, link count · both LQI directions, relationship, routes</dd>
      <dt>click / tap node: card</dt><dd>besides selecting the node, its card stays open with "Z2M" and "HA" links (as in the devices list). A click on the card, <kbd>Esc</kbd>, the background or another node closes it; clicking the selected node again brings it back</dd>
      <dt>routes</dt><dd>(slider in options) what the routing tables say, after a scan with "routes on pull": links carrying active routes are drawn thicker, the more routes the thicker, with an arrow at the end the traffic flows to; links without routes keep their width. The slider sets how strongly the number of routes shows, far left turns the overlay off. Select a router and its path to the coordinator is drawn extra thick; the node card names the hops. The routing tables hold where traffic actually goes, the neighbour tables only who hears whom</dd>
      <dt>devices ▾</dt><dd>the selected node with its neighbours and both LQI directions, or every device when nothing is selected (the "find" text filters it). Click a name to select it on the map, a column header to sort by it (again: reverse; LQI sorts by the weaker direction first). "HA" opens the device page in Home Assistant, "Z2M" the device in the Zigbee2MQTT frontend in a drawer over the map (Ctrl-click for a new tab): enter the frontend's URL as your browser reaches it in the integration's options, ⚙ top right (add-on: http://homeassistant:8099 once its frontend port is enabled; Core or Container: e.g. http://192.168.1.10:8080). On HAOS the add-on's sidebar path (/…_zigbee2mqtt) works too, through the add-on's ingress (administrators only), no port to expose. HA on https cannot embed a plain-http frontend; Ctrl-click opens a tab</dd>
      <dt>⚙</dt><dd>the integration's page in Home Assistant: options, entities, reload</dd>
    </dl>
    <h4>Reading the map</h4>
    <dl>
      <dt>a / b on a link</dt><dd>what the left-hand node hears from the right-hand one / what the right-hand node hears. LQI 0–255, higher is better: colour runs from <span style="color:var(--red)">red (0)</span> through <span style="color:var(--orange)">orange (50)</span> to <span style="color:var(--green)">green (80 and up)</span>. Colour follows the weaker direction</dd>
      <dt>dashed grey</dt><dd>only one side reported the link, or reported 0: usually a stale neighbour-table entry (hidden unless "one-sided / stale links" is on)</dd>
      <dt>sibling links</dt><dd>both sides report the relationship "sibling". Unticking "sibling links" in options hides them, which leaves parent/child links only; on an EmberZNet network that is most of the mesh, so it is on by default. Clicking a node reveals all of its links</dd>
      <dt>link length</dt><dd>strong links short, weak links long ("LQI contrast" in options sets how much; "spacing" scales all distances)</dd>
      <dt>ghosts</dt><dd>an address in a router's neighbour table that Zigbee2MQTT does not know: a removed device whose entries have not aged out (always LQI 0). Hidden unless "show ghost devices" is on in options; the devices list keeps them, with the routers that still hold them on the card</dd>
      <dt>shapes</dt><dd>yellow disc = coordinator · square = router · small dot = end device (hidden by default) · red dashed ring = not seen for more than 24 h · "device images" in options puts the zigbee2mqtt.io photo on each node, "node size" scales them, pictures or not (needs internet; the PNG export leaves them out) · grey node with grey links = removed from Zigbee2MQTT since the last scan (gone with the next scan) · a node parked at the edge without links = joined since the last scan, pull a map to see its links</dd>
      <dt>what a link is</dt><dd>an entry in a router's neighbour table, not a live route. These tables hold ~16 entries and age in and out, so links come and go between scans; judge a path over several scans</dd>
    </dl>
    <h4>Data</h4>
    <dl>
      <dt>background scan</dt><dd>the integration asks Zigbee2MQTT for the map at the interval set in options and keeps the answer, so the panel opens with the latest scan and updates itself when a scan finishes. The same three settings exist as entities of the "Zigbee2MQTT map" device, usable in automations</dd>
      <dt>scan while viewing</dt><dd>while this panel is open and visible it requests a scan at the second interval in options. Several open panels share one schedule: the integration runs one scan at a time and remembers the last request</dd>
      <dt>Z2M topic</dt><dd>the Zigbee2MQTT base topic the integration talks to, found on the broker when it was set up. Change it under Settings → Devices &amp; services → Zigbee2MQTT map → Configure (several instances: pick one there)</dd>
      <dt>⤓ button (before the status text)</dt><dd>starts a scan now; leaving the page is fine, the result is kept. "pull routes" also reads routing tables (slower, much slower on the first pull). Zigbee2MQTT scans one router after another (a 25-router mesh takes about 75 s); the <a href="https://github.com/omcular/zigbee2mqtt-map-panel#faster-scans-optional" target="_blank" rel="noopener">networkmap_fast extension</a> scans two at a time, puts dead routers last and reports progress here (16–22 s for the same mesh)</dd>
      <dt>mesh: connected ≥ C, redundant ≥ R</dt><dd>computed by the integration after every scan and also exposed as two sensors (a history graph of them is the mesh's health over time). C = highest LQI threshold at which every router still reaches the coordinator; R = highest threshold at which no single router is a point of failure. Weaker direction of each two-sided router link; routers without such a link are ignored. Hover for the limiting link or router, click to set Min LQI there</dd>
      <dt>Min LQI</dt><dd>the colour bar in the toolbar: press or drag on it. Shows only router links whose weaker direction is above the chosen LQI (the white marker); end-device links are never filtered; far left shows all. Hidden links still hold the layout together at a fraction of their pull, so moving the bar changes what you see, not where things sit; devices without any link at all are lined up along the bottom of the screen. Until you move it, it follows the "connected" threshold: the mesh first, marginal links on demand. Clicking "connected" or "redundant" in the status line sets it to that level and keeps following it on every new map; dragging the bar makes it a fixed value. Bad links are easiest found by colour with the slider at off</dd>
      <dt>find</dt><dd>highlights every node whose name contains the text; comma-separated terms match any of them (e.g. &quot;keller, thermo&quot;)</dd>
      <dt>permit join</dt><dd>the toolbar button opens the network for new devices for 254 s and counts down; click again to close it early. "permit join here" on a router's card opens it through that router only (the newcomer then takes it as parent); while a join is open, every card shows the countdown; "also here" opens that router too (each router keeps its own 254 s; the button lists every running countdown, soonest first); a dot circles every node the network is open through, "stop" closes the network everywhere. A join opened from the Zigbee2MQTT frontend shows without the router names. Zigbee2MQTT closes the network by itself when the time is up. Administrators only</dd>
      <dt>pairing feed</dt><dd>a bubble over the map: joined → interviewing → paired (or failed) → the device appears on the map at once (parked at the edge until a scan wires it) and is selected, so its card offers the Z2M link for naming it; renames and removals in Zigbee2MQTT reach the map the same way, without a scan</dd>
      <dt>stored in this browser</dt><dd>node positions and pins, zoom and pan, every option, the hide slider and the last map, so a revisit looks like you left it. Other browsers and devices have their own. "re-layout" shakes the layout, "reset view" the zoom</dd>
    </dl>
    <p class="ver">zigbee2mqtt-map-panel v${VERSION}</p>
  </div></details>
  <div id="stale"><span id="staleMsg"></span><button id="reload">reload</button></div>`;


// d3 force: keep nodes off links they do not belong to. A node closer than its clearance to the middle part of a foreign
// link is pushed out along the link's normal, and the link's two ends get the opposite push (split by where the node sits),
// so the link bends away as the node moves. Action and reaction are equal, otherwise every wake turns the whole map a little. O(nodes x links) per tick, fine for a few hundred of each.
// d3 force: links as springs with EQUAL and opposite pulls on both ends. d3's forceLink splits the correction by degree
// (a router with ten links moves a tenth, its end device nine tenths); those unequal pulls along one line add up to a net
// torque on the layout, which showed as the whole map turning a little on every wake. Same accessors as the d3 one where
// the panel uses them: id, links, distance, strength.
function forceLinkSym() {
  let nodes = [], links = [], id = d => d.index, distance = () => 30, strength = () => 0.5, dists = [], strs = [];
  function force(alpha) {
    for (let i = 0; i < links.length; i++) {
      const l = links[i], s = l.source, t = l.target;
      if (typeof s !== 'object' || typeof t !== 'object') continue;
      let x = t.x + (t.vx || 0) - s.x - (s.vx || 0), y = t.y + (t.vy || 0) - s.y - (s.vy || 0);
      let len = Math.sqrt(x * x + y * y); if (len === 0) { x = 1e-6; y = 1e-6; len = Math.sqrt(2) * 1e-6; }
      const k = (len - dists[i]) / len * alpha * strs[i] * 0.5;   // half to each end
      x *= k; y *= k;
      t.vx -= x; t.vy -= y; s.vx += x; s.vy += y;
    }
  }
  function initialize() {
    if (!nodes.length) return;
    const byId = new Map(nodes.map(n => [id(n), n]));
    for (const l of links) { if (typeof l.source !== 'object') l.source = byId.get(l.source); if (typeof l.target !== 'object') l.target = byId.get(l.target); }
    dists = links.map(distance); strs = links.map(strength);
  }
  force.initialize = ns => { nodes = ns; initialize(); };
  force.links = l => l === undefined ? links : (links = l, initialize(), force);
  force.id = f => f === undefined ? id : (id = f, force);
  force.distance = f => f === undefined ? distance : (distance = typeof f === 'function' ? f : () => f, dists = links.map(distance), force);
  force.strength = f => f === undefined ? strength : (strength = typeof f === 'function' ? f : () => f, strs = links.map(strength), force);
  return force;
}

// d3 force: collision with EQUAL and opposite pushes (d3's forceCollide splits the overlap by radius, another source of net
// torque). Pairwise, fine for tens of nodes. Accessor: radius.
function forceCollideSym() {
  let nodes = [], radius = () => 10, radii = [];
  function force() {
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = nodes[i], ra = radii[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j], rr = ra + radii[j];
        let dx = b.x + (b.vx || 0) - a.x - (a.vx || 0), dy = b.y + (b.vy || 0) - a.y - (a.vy || 0), d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        let d = Math.sqrt(d2); if (d === 0) { dx = 1e-3; dy = 1e-3; d = Math.sqrt(2) * 1e-3; }
        const k = (rr - d) / d * 0.5;   // half the overlap to each
        dx *= k; dy *= k; b.vx += dx; b.vy += dy; a.vx -= dx; a.vy -= dy;
      }
    }
  }
  force.initialize = ns => { nodes = ns; radii = nodes.map(radius); };
  force.radius = f => f === undefined ? radius : (radius = typeof f === 'function' ? f : () => f, radii = nodes.map(radius), force);
  force.strength = () => force;   // d3 compatibility, unused
  return force;
}

// d3 force: node repulsion with a steeper fall-off than d3's forceManyBody (which is 1/r). Pairwise, O(n²) per tick: a
// Zigbee mesh has tens of nodes, not thousands, so a quadtree would buy nothing. Strength is per node, as in d3, and is
// normalised so that at `ref` px the push equals d3's for the same strength: closer pairs push harder than before, farther
// pairs weaker, and the exponent sets how much.
function forceRepel(exponent = 1.5, ref = 100) {
  let nodes = [], strengthFn = () => -30, strengths = [];
  const norm = Math.pow(ref, exponent - 1), rmin = 12;   // rmin: no singularity when two nodes land on each other (collide separates them)
  let pairS = [];   // -sqrt(|s_i| * |s_j|), computed once per strength change
  const pairs = () => { pairS = strengths.map(si => strengths.map(sj => -Math.sqrt(Math.abs(si) * Math.abs(sj)))); };
  function force(alpha) {
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y, r = Math.hypot(dx, dy);
        if (r < rmin) { if (r === 0) { dx = 0.01; dy = 0.01; } r = rmin; }
        // equal and opposite (Newton's third law), the pair's strength the geometric mean of the two: unequal pushes along one
        // line, as d3's own charge gives, add up to a net torque on the whole layout, and every wake turns the map a little
        const f = alpha * norm * pairS[i][j] / Math.pow(r, exponent + 1);   // × displacement below = unit vector × 1/r^exponent
        a.vx += dx * f; a.vy += dy * f;   // pairS is negative: a moves away from b, b away from a
        b.vx -= dx * f; b.vy -= dy * f;
      }
    }
  }
  force.initialize = ns => { nodes = ns; strengths = nodes.map(strengthFn); pairs(); };
  force.strength = fn => { if (fn === undefined) return strengthFn; strengthFn = typeof fn === 'function' ? fn : () => fn; strengths = nodes.map(strengthFn); pairs(); return force; };
  return force;
}

function forceAvoidLinks() {
  let nodes = [], links = [], strength = 1, clearance = d => 30;
  function force(alpha) {
    if (!strength) return;
    const k = strength * alpha;
    for (const l of links) {
      if (l.revealed) continue;   // drawn because of a selection, not part of the layout
      const a = l.source, b = l.target; if (typeof a !== 'object' || typeof b !== 'object') continue;
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy; if (len2 < 1) continue;
      const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
      for (const n of nodes) {
        if (n === a || n === b) continue;
        const c = clearance(n);
        if (n.x < minX - c || n.x > maxX + c || n.y < minY - c || n.y > maxY + c) continue;   // cheap reject
        const t = ((n.x - a.x) * dx + (n.y - a.y) * dy) / len2; if (t <= 0.05 || t >= 0.95) continue;
        const px = a.x + t * dx - n.x, py = a.y + t * dy - n.y, d = Math.hypot(px, py) || 0.01; if (d >= c) continue;
        const push = k * (c - d) / d * 5, fx = -px * push, fy = -py * push;   // away from the link
        n.vx += fx; n.vy += fy;
        a.vx -= fx * (1 - t); a.vy -= fy * (1 - t); b.vx -= fx * t; b.vy -= fy * t;   // the full reaction, split by where the node sits: no net force and no net torque, so the layout does not drift or turn
      }
    }
  }
  force.initialize = n => { nodes = n; };
  force.links = l => { links = l; return force; };
  force.strength = v => { strength = v; return force; };
  force.clearance = f => { clearance = f; return force; };
  return force;
}

class ZigbeeMapPanel extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }); this._hass = null; this._built = false; this.sel = new Set(); this.data = null; }
  // selection: a set of nodes (plain click = only this one, Ctrl/Shift-click = add or remove); `selected` is its first node
  get selected() { return this.sel.size ? this.sel.values().next().value : null; }
  set selected(n) { this.sel = n ? new Set([n]) : new Set(); }
  isSel(n) { return this.sel.has(n); }
  touchesSel(l) { return this.sel.has(l.s) || this.sel.has(l.t); }
  // plain click toggles a single selection, a modifier click toggles membership
  clickSelect(n, e) { if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) { if (this.sel.has(n)) this.sel.delete(n); else this.sel.add(n); } else this.selected = (this.sel.size === 1 && this.sel.has(n)) ? null : n; this._selOnly = true; this.render(); }
  set hass(h) { this._hass = h; const mb = this.shadowRoot.querySelector('ha-menu-button'); if (mb) { mb.hass = h; mb.narrow = this._narrow; } this.syncSched(); }
  get hass() { return this._hass; }
  set narrow(n) { this._narrow = n; const mb = this.shadowRoot.querySelector('ha-menu-button'); if (mb) mb.narrow = n; }
  set panel(p) { this._panel = p; this.checkStale(); }
  // HA pushes the panel list again after a restart; a different module URL (hash) or a different integration version than this
  // file means newer panel code is on the server. A page cannot swap a custom element's class, so all we can do is ask for a reload.
  checkStale() {
    if (!this.$ || !this.$('stale')) return;
    const reg = this._panel?.config?._panel_custom?.module_url; let urlStale = false;
    if (reg) { try { const a = new URL(reg, location.href), b = new URL(import.meta.url); urlStale = a.pathname !== b.pathname || a.searchParams.get('v') !== b.searchParams.get('v'); } catch (e) {} }
    const verStale = this.S.version && this.S.version !== VERSION;
    // a changed module URL: the server serves a newer panel file than this page runs, a reload gets it (whatever the versions
    // say: after a release both differ, and the reload fixes both). The same URL with a different integration version means
    // new files on disk but Home Assistant not restarted since (HACS update without restart, or a downgrade): only a restart helps
    const needRestart = verStale && !urlStale;
    this.$('staleMsg').textContent = needRestart ? `Home Assistant runs version ${this.S.version} of the integration, this panel file is ${VERSION}: restart Home Assistant`
      : 'the panel was updated on the server, this page still runs the old version';
    this.$('reload').style.display = needRestart ? 'none' : '';
    this.$('stale').classList.toggle('show', !!(urlStale || verStale));
  }
  // panel config wins; otherwise the helper the package fills from the retained <base>/bridge/state message; last resort the Z2M default
  get S() { return this._status || {}; }           // last status event from the integration
  get E() { return this.S.entities || {}; }         // entity ids of the settings entities: bg, live
  get baseTopic() { return this.S.base_topic || this._panel?.config?.base_topic || '?'; }
  get fast() { return !!this.S.settings?.[SET.parallel]; }
  setting(k) { const v = parseFloat(this.S.settings?.[k]); return Number.isFinite(v) ? v : null; }
  lastRequestMs() { const t = this.S.last_request ? Date.parse(this.S.last_request) : NaN; return Number.isFinite(t) ? t : 0; }

  _join = { all: 0, via: {} };   // see joinLink
  connectedCallback() { if (!this._built) { this._built = true; this.build(); } else { if (this._onKey) window.addEventListener('keydown', this._onKey, true); this.watchStore(); if (!this._liveT) this._liveT = setInterval(() => this.liveTick(), 15000); } }   // HA may re-attach the same element

  async build() {
    const r = this.shadowRoot;
    r.innerHTML = `<style>${STYLE}</style><div id="wrap"><div id="bar">${BAR}</div><div id="foot">${FOOT}</div><div id="canvas"><svg></svg><div id="tip"></div><div id="toast"></div><div id="side"><div class="sidebar"><span id="sideTitle"></span><a id="sideExt" target="_blank" rel="noopener" title="open this page in a new tab">↗ new tab</a><button id="sideClose" title="back to the map">✕ close</button></div><iframe id="sideFrame" title="Zigbee2MQTT"></iframe></div></div></div>`;
    const mb = r.querySelector('ha-menu-button'); mb.hass = this._hass; mb.narrow = this._narrow;
    this.$ = id => r.getElementById(id);
    this.$('pull').onclick = () => this.pull();
    this.$('join').onclick = () => this.permitJoin(this._joinEnd ? 0 : JOIN_SECONDS);
    this.$('reload').onclick = () => location.reload();
    // help: each term with its explanation as one block, so a column break never separates them
    for (const dl of r.querySelectorAll('details#help dl')) for (const dt of [...dl.querySelectorAll(':scope > dt')]) {
      const item = document.createElement('div'); dl.insertBefore(item, dt); item.append(dt);
      while (item.nextElementSibling?.tagName === 'DD') item.append(item.nextElementSibling);
    }
    this.$('gear').onclick = e => { e.preventDefault(); this.navTo(this.$('gear').getAttribute('href')); };
    this.$('sideClose').onclick = () => this.closeSide();
    // remember how the last press came in: on touch the tooltip is opened by a tap and then sits under the finger, so it
    // catches the next tap itself and closes, instead of letting it through to the map
    this.$('canvas').addEventListener('pointerdown', e => { this._lastPtr = e.pointerType; }, true);
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click']) this.$('tip').addEventListener(type, e => {
      e.stopPropagation(); const onLink = !!e.target.closest?.('a');
      if (onLink) { if (type === 'click' && e.target.closest('a').hasAttribute('data-nav')) setTimeout(() => this.hideTip(), 0); return; }   // the link's own handler does the work; the Z2M drawer keeps the card
      if (type !== 'touchstart') e.preventDefault();
      if (type === 'click' || (!this._pinned && (type === 'pointerdown' || type === 'touchstart'))) this.hideTip();
    }, { passive: false });
    // keys: Esc closes the Zigbee2MQTT drawer, else an open dropdown, else clears the selection · Ctrl-A selects every node
    // on the map · Ctrl-Shift-A clears the selection. Not while typing in a field. Keys typed inside the drawer stay in its
    // frame (another origin): click the map or the drawer's title bar first
    this._onKey = e => {
      if (!this.isConnected || !this.data) return;
      const tgt = e.composedPath()[0], typing = tgt && (/^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName) || tgt.isContentEditable);
      if (e.key === 'Escape') {   // one step per press: side panel, menu, card, selection; the handled press stops here (Home Assistant must not see it again)
        const took = () => { e.preventDefault(); e.stopPropagation(); };
        if (this.$('side').classList.contains('show')) { this.closeSide(); took(); return; }
        let closed = false; for (const d of dds) if (d.open) { d.open = false; closed = true; }
        if (closed) { took(); return; }
        if (this._pinned) { this.hideTip(); took(); return; }
        if (typing) { if (tgt === this.$('find')) { tgt.blur(); took(); } return; }   // leave the find box (the text stays, the keys work again)
        if (this.sel.size) { this.selected = null; this._selOnly = true; this.render(); took(); }
        return;
      }
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {   // single keys on the map
        const k = e.key;
        if (k === 'f' || k === 'F') { this.fitView({ rotate: k === 'f' }); e.preventDefault(); e.stopPropagation(); return; }   // F: fit without turning
        if (k === 'r') { this.wake(0.8); e.preventDefault(); e.stopPropagation(); return; }
        if (k === 'E') { const c = this.$('showEnd'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); e.preventDefault(); e.stopPropagation(); return; }   // Shift-e: plain e is Home Assistant's entity search
        if (k === '/') { this.$('find').focus(); this.$('find').select(); e.preventDefault(); e.stopPropagation(); return; }
        const menu = { 'D': 'devs', 'O': 'opts', 'h': 'help', 'H': 'help' }[k];   // shifted letters: the plain ones are Home Assistant's (d devices, o?, e entities)
        if (menu) { const d = this.$(menu); d.open = !d.open; e.preventDefault(); e.stopPropagation(); return; }
        if (k === 'ArrowRight' || k === 'ArrowLeft') { this.nudgeMinLqi(k === 'ArrowRight' ? 5 : -5); e.preventDefault(); e.stopPropagation(); return; }
        if (k === 'ArrowUp' || k === 'ArrowDown') { this.cycleMinLqi(k === 'ArrowUp' ? 1 : -1); e.preventDefault(); e.stopPropagation(); return; }
      }
      if (typing || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'a') return;
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) this.selected = null;
      else { const shown = new Set(); this.gn.selectAll('g.node').each(d => shown.add(d)); this.sel = [...shown].every(n => this.sel.has(n)) ? new Set() : shown; }
      this._selOnly = true; this.render();
    };
    window.addEventListener('keydown', this._onKey, true);   // capture: before Home Assistant's own shortcut handler, which otherwise swallows Ctrl-A
    const dds = [this.$('devs'), this.$('opts'), this.$('help')];
    // a click on the map while a dropdown is open only closes it: the press, the click and a double-click that start outside are eaten
    // in the capture phase, so the map underneath neither deselects nor drags, pans or pins
    const outside = e => { const p = e.composedPath(); return p.includes(this.$('canvas')) ? dds.find(d => d.open && !p.includes(d)) : undefined; };   // map area only; the toolbar keeps working
    r.addEventListener('click', e => { for (const d of dds) if (d.open && !e.composedPath().includes(d)) d.open = false; });
    let eating = false;
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) r.addEventListener(type, e => {
      if (type === 'pointerdown') eating = false;
      const d = outside(e); if (!d && !eating) return;
      eating = true; e.stopPropagation(); if (type !== 'touchstart') e.preventDefault();
    }, true);
    for (const type of ['click', 'dblclick']) r.addEventListener(type, e => {
      const d = outside(e);
      if (d) for (const o of dds) if (!e.composedPath().includes(o)) o.open = false;
      if (eating || d) { e.stopPropagation(); e.preventDefault(); if (type === 'dblclick' || !d) eating = false; }
    }, true);
    for (const d of dds) d.addEventListener('toggle', () => { if (d.open) { for (const o of dds) if (o !== d) o.open = false; this.placeMenu(d); } });
    window.addEventListener('resize', () => { for (const d of dds) if (d.open) this.placeMenu(d); });
    this.$('devs').addEventListener('toggle', () => { if (this.$('devs').open) { this.fillDevices(); this.loadRegistry().then(() => { if (this.$('devs').open) this.fillDevices(); }); } });
    try { await loadD3(); } catch (e) { this.$('status').textContent = e.message; return; }
    this.initGraph();
    const cached = lsGet(LS.map, null);
    if (cached) { this.setMap(cached.map, cached.fetchedAt, cached.updatedAt || cached.fetchedAt, cached.mesh ?? null); }
    else this.$('status').textContent = 'no map yet, press ⤓ to scan';
    this.watchStore();
    new ResizeObserver(() => this.onResize()).observe(this.$('canvas'));
    this.onResize();
    for (const [id, key] of [['bgInt', 'bg'], ['liveInt', 'live']]) this.$(id).onchange = () => {
      const v = parseFloat(this.$(id).value); if (!Number.isFinite(v) || !this._hass || !this.E[key]) return;
      this._hass.callService('number', 'set_value', { entity_id: this.E[key], value: v }).catch(e => { this.$('schedNote').textContent = 'could not set ' + this.E[key] + ': ' + (e.message || e); });
    };
    this.syncSched(); this.checkStale();
    if (!this._liveT) this._liveT = setInterval(() => this.liveTick(), 15000);
  }
  // mirror the HA interval entities into the options menu (they may be edited anywhere in HA)
  syncSched() {
    if (!this.$ || !this.$('bgInt')) return;
    const bg = this.setting(SET.bg), live = this.setting(SET.live), have = !!this._status;
    for (const [id, v] of [['bgInt', bg], ['liveInt', live]]) { const el = this.$(id); if (this.shadowRoot.activeElement !== el) { el.value = v == null ? '' : v; el.disabled = !have; } }
    this.$('schedNote').textContent = !have ? 'waiting for the Zigbee2MQTT map integration…' :
      (bg > 0 ? `background: every ${bg} h` : 'background: off') + ' · ' + (live > 0 ? `viewing: every ${live} min` : 'viewing: off') + (this.fast ? ' · networkmap_fast topic' : '') + ` · Z2M topic: ${this.baseTopic}`;
  }
  // while the panel is open and visible: request a scan once the live interval has passed since the last request anywhere
  // the map's age in the status line ("33m ago"), the exact time on hover; refreshed by the 15 s tick
  tickAge() { const a = this.$?.('mapAge'); if (!a) return; const ms = Date.now() - +a.dataset.t;
    a.textContent = ms < 60e3 ? 'just now' : ms < 3600e3 ? `${Math.floor(ms / 60e3)}m ago` : ms < 86400e3 ? `${Math.floor(ms / 3600e3)}h ago` : `${Math.floor(ms / 86400e3)}d ago`; }
  liveTick() {
    this.tickAge();
    if (!this.isConnected || document.visibilityState !== 'visible' || !this._hass || this._scan) return;
    const live = this.setting(SET.live); if (!(live > 0)) return;
    const last = Math.max(this.lastRequestMs(), this.data ? (Date.parse(this.data.fetchedAt) || 0) : 0);
    if (Date.now() - last >= live * 60000) this.pull();
  }
  onResize() { const bar = this.$('bar'); if (bar) { const h = bar.offsetHeight + 'px'; if (this._barh !== h) { this._barh = h; this.style.setProperty('--barh', h); } } if (this.sim && this.data) { const c = this.$('canvas'), cx = c.clientWidth / 2, cy = c.clientHeight / 2; this.sim.force('center', d3.forceCenter(cx, cy)); this.applyGravity(); this.draw(); } }

  // live link to the integration: a status event first, then the stored map, then every new map, progress count and error
  async watchStore() {
    const h = this._hass; if (!h || this._storeSub) return;
    try { this._storeSub = await h.connection.subscribeMessage(ev => this.onEvent(ev), { type: WS.subscribe }); }
    catch (e) { this.$('status').textContent = 'cannot reach the Zigbee2MQTT map integration: ' + (e.message || JSON.stringify(e)); }
  }
  onEvent(ev) {
    const st = this.$('status');
    switch (ev.type) {
      case 'status':
        this._status = ev; this.syncSched(); this.checkStale(); this.syncJoin(ev);
        if (this._pinned && this._refill) this._refill();   // the card's 'permit join here' line follows the countdown
        if (ev.scanning && !this._scan) this.beginScan(ev.scanning); else if (!ev.scanning && this._scan) this.endScan();
        // first status of this visit and the integration has never scanned (the integration also scans by itself ~20 s
        // after a fresh install; whichever comes first wins, the other is refused as "already scanning")
        if (!this._gotStatus) { this._gotStatus = true; if (!ev.last_request && !ev.scanning) this.pull(); }
        break;
      case 'scan_started': if (!this._scan) this.beginScan(ev.kind); break;
      case 'progress': if (this._scan) this._scan.progress = ` · ${ev.done}/${ev.total} routers${ev.failed ? `, ${ev.failed} not answering` : ''}`; break;
      case 'map': {
        // updatedAt moves when the integration patched names from Zigbee2MQTT's device list (a rename, no new scan)
        const key = ev.updatedAt || ev.fetchedAt;
        if (this.data && this.data.key === key) break;
        this.endScan();
        lsSet(LS.map, { fetchedAt: ev.fetchedAt, updatedAt: ev.updatedAt, map: ev.map, mesh: ev.mesh ?? null });
        this.setMap(ev.map, ev.fetchedAt, key, ev.mesh ?? null);
        if (this._pinned) { const n = this.data.byId[this._pinned.id]; if (n) { this._pinned = n; this._refill?.(); } else this.hideTip(); }   // the open card follows a rename, closes on removal
        if (ev.duration) st.append(` · scan took ${ev.duration} s`);   // append, not textContent +=: that would flatten the clickable mesh numbers into plain text
        break;
      }
      case 'error': this.endScan(); st.textContent = 'Zigbee2MQTT: ' + ev.message; break;
      case 'z2m_event': this.onZ2mEvent(ev); break;
    }
  }
  beginScan(kind) {
    const st = this.$('status'), t0 = Date.now(), scan = this._scan = { progress: '' };
    this.$('pull').disabled = true;
    scan.tick = setInterval(() => { st.textContent = `scan running (${kind})… ${Math.round((Date.now() - t0) / 1000)} s${scan.progress} (leaving the page is fine, the result is kept by Home Assistant)`; }, 1000);
  }
  endScan() { if (!this._scan) return; clearInterval(this._scan.tick); this._scan = null; this.$('pull').disabled = false; }
  disconnectedCallback() { window.removeEventListener('keydown', this._onKey, true); clearInterval(this._liveT); this._liveT = null; clearInterval(this._joinT); this._joinT = null; clearTimeout(this._feedT); this._feedT = null; clearInterval(this._ingressT); this._ingressT = null; this._ingress = null; this.savePos(); this.saveView(); lsSet(LS.sel, [...this.sel].map(n => n.id)); if (this._storeSub) { try { this._storeSub(); } catch (e) {} this._storeSub = null; } }

  // permit join: the request goes to Zigbee2MQTT through the integration; the countdown comes back in the status events
  // (permit_join_end from Zigbee2MQTT's bridge info), so a reload or a second browser shows the same clock
  async permitJoin(seconds, device = null) {
    const h = this._hass; if (!h) return;
    this.joinBusy(seconds > 0 ? 'opening…' : 'closing…');
    try { await h.callWS({ type: WS.permitJoin, time: seconds, ...(device ? { device } : {}) }); }
    catch (e) { this.joinBusy(null); this.feed('permit join failed: ' + (e.message || JSON.stringify(e)) + (e.code === 'unauthorized' ? ' (administrators only)' : ''), true); }
  }
  // between the tap and Zigbee2MQTT's bridge info the button says what it is doing and ignores taps (a few seconds at most)
  joinBusy(text) {
    const b = this.$?.('join'); if (!b) return;
    clearTimeout(this._joinBusyT); this._joinBusyT = null;
    if (!text) { b.disabled = false; return; }
    b.textContent = text; b.disabled = true;
    this._joinBusyT = setTimeout(() => { b.disabled = false; this.syncJoin(this._status); }, 5000);   // no info came: back to what Zigbee2MQTT last said
  }
  // every running countdown, soonest first: the broadcast's, or one per router asked; Zigbee2MQTT's own stamp is appended when
  // it belongs to none of them (a join opened elsewhere)
  joinClocks(now = Date.now()) {
    const J = this._join, ends = J.all > now ? [J.all] : Object.values(J.via).filter(t => t > now).sort((a, b) => a - b);
    if (this._joinEnd && !ends.includes(this._joinEnd)) ends.push(this._joinEnd);
    return ends.map(t => mmss(t - now));
  }
  // nodes the network is open through right now (the broadcast: every router and the coordinator) get the orbiting dot
  markJoinOpen() {
    if (!this.gn) return;
    const J = this._join, now = Date.now(), all = J.all > now, late = J.late || new Set();   // late: joined after the broadcast started, it never reached them
    this.gn.selectAll('g.node').classed('joinopen', d => !d.isEnd && d.type !== 'Unknown' && !d.removed && ((all && !late.has(d.id)) || J.via[d.id] > now));
  }
  syncJoin(st) {
    const J = this._join, now = Date.now(), end = st?.permit_join_end ? Date.parse(st.permit_join_end) : 0;
    this.joinBusy(null);
    this._joinEnd = end > now ? end : 0;
    J.all = this._joinEnd && st?.permit_join_all ? Date.parse(st.permit_join_all) : 0;
    J.via = {}; if (this._joinEnd) for (const [id, iso] of Object.entries(st?.permit_join_via || {})) { const t = Date.parse(iso); if (t > now) J.via[id] = t; }
    J.late = new Set(st?.permit_join_late || []);
    const b = this.$?.('join'); if (!b) return;
    const tick = () => {
      const now = Date.now(), left = this._joinEnd - now;
      for (const id of Object.keys(J.via)) if (J.via[id] <= now) delete J.via[id];   // that router's own timer ran out
      if (J.all <= now) J.all = 0;
      if (left <= 0) { this._joinEnd = 0; J.via = {}; clearInterval(this._joinT); this._joinT = null; b.textContent = 'permit join'; b.classList.remove('open'); this.markJoinOpen(); if (this._pinned && this._refill) this._refill(); return; }
      this.markJoinOpen();
      b.textContent = `join open ${this.joinClocks(now).join(' ')} ✕`; b.classList.add('open');
      if (this._pinned && this._refill) this._refill();   // a card's join line counts down too
    };
    clearInterval(this._joinT); this._joinT = null;
    tick(); if (this._joinEnd) this._joinT = setInterval(tick, 1000);
  }
  // the pairing feed from Zigbee2MQTT: what happens to a newcomer, in the footer next to the scan status
  onZ2mEvent(ev) {
    const name = ev.friendly_name || ev.ieee_address || 'device';
    switch (ev.event) {
      case 'permit_join': this.feed(ev.time ? `Zigbee2MQTT: join OK, ${ev.time} s` : 'Zigbee2MQTT: join closed'); break;   // the answer to a request; the button follows bridge/info
      case 'device_joined': this.feed(`joined: ${name}`); break;
      case 'device_announce': this.feed(`${name} announced itself`); break;
      case 'device_interview':
        if (ev.status === 'started') this.feed(`interviewing ${name}…`, false, 0);
        else if (ev.status === 'successful') { this.feed(ev.supported === false ? `${name} paired, not supported by Zigbee2MQTT` : `${name} paired${ev.model ? ` (${ev.vendor ? ev.vendor + ' ' : ''}${ev.model})` : ''}`, ev.supported === false); this._selectNext = ev.ieee_address; }
        else this.feed(`interview of ${name} failed`, true);
        break;
      case 'device_leave': this.feed(`${name} left the network`); break;
    }
  }
  feed(text, bad = false, ttl = 15000) {
    const f = this.$?.('toast'); if (!f) return;
    f.textContent = text; f.classList.toggle('bad', bad); f.classList.add('show');
    clearTimeout(this._feedT); this._feedT = null;
    if (ttl) this._feedT = setTimeout(() => { if (f.textContent === text) f.classList.remove('show'); }, ttl);
  }

  // ask the integration for a scan; the result, progress and errors arrive as events on the subscription
  async pull() {
    const h = this._hass; if (!h || this._scan) return;
    const st = this.$('status'); st.textContent = `requesting a scan on ${this.baseTopic}…`;
    try {
      const r = await h.callWS({ type: WS.scan, routes: !!this.$('routes').checked });
      if (!r.started && !this._scan) st.textContent = 'a scan is already running';
    } catch (e) { this.endScan(); st.textContent = 'scan request failed: ' + (e.message || JSON.stringify(e)) + (e.code === 'unauthorized' ? ' (administrators only)' : ''); }
  }

  setMap(map, fetchedAt, key = fetchedAt, mesh = null) {
    const { nodes, links } = mergeMap(map);
    const saved = lsGet(LS.pos, {}), now = Date.now(); let seeded = 0;
    // keep live positions of nodes that already exist
    const firstMap = !this.data;   // first map of this visit: restore the selection the last visit left behind
    const old = this.data ? Object.fromEntries(this.data.nodes.map(n => [n.id, n])) : {};
    for (const n of nodes) {
      n.isEnd = n.type === 'EndDevice' || n.type === 'Unknown';
      n.stale = n.type !== 'Coordinator' && n.lastSeen && (now - n.lastSeen) > 86400e3;   // the coordinator has no meaningful last-seen
      n.joinedUnscanned = n.type !== 'Coordinator' && !n.lastSeen && !n.removed && !links.some(l => l.source === n.id || l.target === n.id);   // came from the device list, not from a scan
      const o = old[n.id], sv = saved[n.id];
      if (o) { n.x = o.x; n.y = o.y; n.fx = o.fx; n.fy = o.fy; n._parked = o._parked; n._userPinned = o._userPinned; }   // parked ≠ pinned: a docked node must not come back as a pin
      else if (sv) { n.x = sv[0]; n.y = sv[1]; if (sv[2]) { n.fx = sv[0]; n.fy = sv[1]; } seeded++; }
    }
    if (seeded > 0 && !this.data) { this.warm = true; this._gentle = true; }   // first map of this visit, positions known: no warm-up, no shake
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    for (const l of links) {
      l.s = byId[l.source]; l.t = byId[l.target];
      // an end device has no neighbour table, so its link is reported by the parent only: that is normal, not stale
      l.endLink = l.s.isEnd || l.t.isEnd;
      l.removed = !!(l.s.removed || l.t.removed);   // the device left Zigbee2MQTT after this scan: drawn grey, out of the mesh numbers
      const vals = [l.lqS, l.lqT].filter(v => v != null && v > 0);
      l.min = l.endLink ? (vals.length ? Math.min(...vals) : 0) : Math.min(l.lqS ?? 999, l.lqT ?? 999);
      l.oneSided = !l.endLink && (l.lqS == null || l.lqT == null || l.lqS === 0 || l.lqT === 0);
      const rels = [l.relS, l.relT].filter(r => r != null); l.sibling = rels.length > 0 && rels.every(r => r === 2);
    }
    // routes: active entries per link, which end holds them (direction), and every router's next hop toward the coordinator
    const coord = nodes.find(n => n.type === 'Coordinator'), coordNwk = coord?.nwk ?? 0, uplink = {};
    for (const l of links) {
      l.rA = l.routes.filter(r => r.status === 'ACTIVE'); l.rVia = new Set(l.rA.map(r => r.via));
      if (!l.removed) for (const r of l.rA) if (r.to === coordNwk && !uplink[r.via]) uplink[r.via] = r.via === l.s.id ? l.t : l.s;
    }
    this._uplink = uplink; this._hasRoutes = links.some(l => l.routes.length > 0);
    this.data = { nodes, links, byId, fetchedAt, key };
    let wantSel = [...this.sel].map(n => n.id);   // a new scan keeps the current selection if the nodes still exist
    if (firstMap) { const saved = lsGet(LS.sel, null); wantSel = Array.isArray(saved) ? saved : saved ? [saved] : []; }
    this.sel = new Set(wantSel.map(id => byId[id]).filter(Boolean));
    if (this._selectNext && byId[this._selectNext]) { this.sel = new Set([byId[this._selectNext]]); this._selectNext = null; }   // a device that just paired: show where it landed
    if (firstMap && this.sel.size) this._selOnly = true;
    const routers = nodes.filter(n => !n.isEnd && n.type !== 'Coordinator').length, ends = nodes.filter(n => n.isEnd).length;
    this.mesh = mesh;
    const st = this.$('status'); st.textContent = 'scanned ';
    const age = document.createElement('span'); age.id = 'mapAge'; age.dataset.t = new Date(fetchedAt).getTime(); age.title = new Date(fetchedAt).toLocaleString();
    st.append(age, ` · ${routers} routers, ${ends} end devices, ${links.length} links`); this.tickAge();
    if (mesh) {
      const nm = id => byId[id]?.name ?? id;
      const tipC = `every router reaches the coordinator over links of LQI ${mesh.connected} or better (weaker direction)` +
        (mesh.bottleneck ? `\nweakest necessary link: ${nm(mesh.bottleneck.source)} – ${nm(mesh.bottleneck.target)} (${mesh.connected}); without it ${mesh.bottleneck.lost.length} router${mesh.bottleneck.lost.length === 1 ? '' : 's'} would be cut off` : '') +
        (mesh.ignored.length ? `\nignored (no two-sided link): ${mesh.ignored.join(', ')}` : '') + `\nclick: set Min LQI to this level`;
      const tipR = `no single router is a point of failure at LQI ${mesh.redundant} or better: remove any one router and the rest still reach the coordinator` +
        (mesh.spof ? `\njust above that, ${nm(mesh.spof.id)} becomes a single point of failure for ${mesh.spof.lost.map(nm).join(', ')}` : mesh.redundant === mesh.connected ? '\nlimited by the same link as "connected"' : '') + `\nclick: set Min LQI to this level`;
      st.append(' · mesh: ');
      const mk = (label, v, tip) => { const b = document.createElement('span'); b.className = 'mesh'; b.textContent = `${label} ≥ ${v}`; b.title = tip + `\nclick: set Min LQI to this level and keep following it on every new map`; b.onclick = () => { lsSet(LS.hideMode, label); this.setMinLqi(v, false, label); }; st.append(b); };
      mk('connected', mesh.connected, tipC); st.append(', '); mk('redundant', mesh.redundant, tipR);
    }
    if (!(seeded > 0)) this.warm = false;
    // a first look should show the mesh, not every marginal link: until the user picks a Min LQI, follow the "connected"
    // threshold (every router still reaches the coordinator over the links shown)
    const mode = this.hideMode(), thr = mode === 'redundant' ? 'redundant' : 'connected';
    if (mesh && mode !== 'manual' && mesh[thr] >= 0) this.setMinLqi(mesh[thr], true, mode);
    this.render();
    if (firstMap && !lsGet(LS.view, null)) {   // nothing saved for this browser: show the whole map, turned to the window when the layout is fresh
      const fresh = !(seeded > 0); this.fitView({ rotate: fresh, animate: false });
      this._fitOnSettle = { rotate: fresh };   // and once more when the simulation has settled, since a fresh layout keeps moving for seconds
    }
  }

  initGraph() {
    const r = this.shadowRoot, $ = this.$;
    this.svg = d3.select($('canvas').querySelector(':scope > svg')); this.tip = d3.select($('tip'));
    this.g = this.svg.append('g'); this.gl = this.g.append('g'); this.glq = this.g.append('g'); this.gn = this.g.append('g');
    // Ctrl is excluded on purpose: Ctrl-wheel stays browser zoom, Ctrl-drag rotates (below); middle button rotates too
    this.zoom = d3.zoom().scaleExtent([0.15, 6]).on('zoom', e => { if (e.sourceEvent) this._fitOnSettle = null; /* the user took over the view: no fit behind their back */ this._zoomT = e.transform; this.g.attr('transform', e.transform); this.dockParked(); this.draw(); }).on('end', () => this.saveView()).filter(e => (e.type === 'wheel' || !e.target.closest?.('.node')) && !e.button && !e.ctrlKey);   // nodes are for dragging, but the wheel zooms everywhere
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
    // two fingers turn the map as well as pinch it: rotation around the point between the fingers, after a ~8° dead zone so
    // a plain pinch does not wobble. d3.zoom keeps handling the pinch (scale) and the pan at the same time. Capture phase on
    // the canvas: d3.zoom stops the touch events on the svg itself
    const ang = t => Math.atan2(t[1].clientY - t[0].clientY, t[1].clientX - t[0].clientX);
    let ta0 = null, tTurned = false;
    $('canvas').addEventListener('touchstart', e => { if (e.touches.length === 2) { ta0 = ang(e.touches); tTurned = false; } else ta0 = null; }, { passive: true, capture: true });
    $('canvas').addEventListener('touchmove', e => {
      if (ta0 == null || e.touches.length !== 2 || !this.data) return;
      let d = ang(e.touches) - ta0; d = Math.atan2(Math.sin(d), Math.cos(d));
      if (!tTurned && Math.abs(d) < 0.14) return;
      const c = $('canvas').getBoundingClientRect(), t = e.touches;
      const centre = d3.zoomTransform(svgEl).invert([(t[0].clientX + t[1].clientX) / 2 - c.left, (t[0].clientY + t[1].clientY) / 2 - c.top]);
      this.rotateAll(d, centre); ta0 += d; tTurned = true;
    }, { passive: true, capture: true });
    $('canvas').addEventListener('touchend', e => { if (e.touches.length < 2) { if (tTurned) { this._rotated = true; this.savePos(); } ta0 = null; tTurned = false; } }, { passive: true, capture: true });
    const v = lsGet(LS.view, null); if (v && v.k > 0) this.svg.call(this.zoom.transform, d3.zoomIdentity.translate(v.x, v.y).scale(v.k));
    this.svg.on('click', () => { if (this._rotated) { this._rotated = false; return; } this.hideTip(); if (this.sel.size) { this.selected = null; this._selOnly = true; this.render(); } else this.applySel(); });
    this.spring = Math.min(2, +lsGet(LS.spring, 0.7) || 0.7);
    // rest length follows link quality (weaker direction): LQI 255 -> short, LQI 0 / one-sided -> long
    const q = l => (l.oneSided || !(l.min >= 0) || l.min > 255) ? 0 : l.min / 255;
    this.lqilen = Math.min(3, +lsGet(LS.lqilen, 1)); if (!(this.lqilen >= 0)) this.lqilen = 1;
    this.avoid = Math.min(2, +lsGet(LS.avoid, 1)); if (!(this.avoid >= 0)) this.avoid = 1;
    // k = 0: fixed lengths (210 / 60) · k = 1: 120..300 / 40..100 by LQI · linear in k, floored so strong links never collapse at high contrast
    const dist = l => { const k = this.lqilen, end = l.s.isEnd || l.t.isEnd; return Math.max(end ? 25 : 50, end ? ((60 - 20 * k) + 60 * k * (1 - q(l))) : ((210 - 90 * k) + 180 * k * (1 - q(l)))) * this.spring; };
    const charge = d => (d.isEnd ? -150 : -1100) * this.spring;
    this.sim = d3.forceSimulation().force('link', forceLinkSym().id(d => d.id).distance(dist).strength(l => this.linkPull(l)))
      .force('charge', forceRepel(CHARGE_EXPONENT, CHARGE_REF).strength(charge)).force('center', d3.forceCenter(400, 300)).force('collide', forceCollideSym().radius(d => d.isEnd ? 18 : 42))
      .force('avoid', forceAvoidLinks().strength(this.avoid).clearance(d => (d.isEnd ? 16 : 30) * Math.max(0.6, this.spring)))
      .on('tick', () => { this.tickRamp(); this.draw(); this.savePosSoon(); if ((this._tickN = (this._tickN || 0) + 1) % 30 === 0) this.applyGravity(); if (this._fitOnSettle && this.sim.alpha() < SETTLE_ALPHA) this.fitOnSettle(); })
      .on('end', () => { this.savePos(); if (this._fitOnSettle) this.fitOnSettle(); });
    // remembered controls (this browser): checkboxes and the hide slider; spacing / LQI contrast / pin mode have their own keys
    const PREFS = ['swapBars', 'showRoutes', 'hoverTips', 'showGhosts', 'showEnd', 'showOne', 'selOne', 'showSib', 'showLql', 'names', 'showImg', 'routes', 'hide', 'imgsize'];
    const prefs = lsGet(LS.prefs, {});
    if (!('names' in prefs) && 'showNames' in prefs) prefs.names = prefs.showNames ? 'all' : 'none';   // older stored prefs
    for (const id of PREFS) { const el = $(id); if (!(id in prefs)) continue; if (el.type === 'checkbox') el.checked = !!prefs[id]; else el.value = prefs[id]; }
    if (+$('hide').value < 0) $('hide').value = 0;   // older stored prefs had a two-sided slider
    $('hideV').textContent = hideLabel(+$('hide').value);
    this.imgsize = +$('imgsize').value || 24; $('imgsizeV').textContent = this.imgsize;
    $('imgsize').oninput = () => { this.imgsize = +$('imgsize').value; $('imgsizeV').textContent = this.imgsize; this.applyImgSize(); this.draw(); };
    const savePrefs = () => { const o = {}; for (const id of PREFS) { const el = $(id); o[id] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : +el.value; } lsSet(LS.prefs, o); };
    for (const id of PREFS) $(id).addEventListener($(id).type === 'checkbox' ? 'change' : 'input', savePrefs);
    $('showEnd').onchange = () => { this._filterOnly = true; this.render(); }; $('showGhosts').onchange = () => this.render();
    const routesLabel = () => { const v = +$('showRoutes').value; $('showRoutesV').textContent = v > 0 ? v.toFixed(1) : 'off'; };
    $('showRoutes').oninput = () => { routesLabel(); this.render(); }; routesLabel();
    const syncRoutesCtl = () => { $('routesCtl').style.display = $('routes').checked ? '' : 'none'; };   // the overlay slider only makes sense with routes in the scan
    $('routes').addEventListener('change', () => { if ($('routes').checked && +$('showRoutes').value === 0) { $('showRoutes').value = 1; $('showRoutes').dispatchEvent(new Event('input')); } syncRoutesCtl(); });   // turning routes on with the overlay off: show them
    this._syncRoutesCtl = syncRoutesCtl; $('showOne').onchange = () => this.render(); $('showSib').onchange = () => this.render(); $('selOne').onchange = () => { if (this.selected) { this._selOnly = true; this.render(); } };
    $('showLql').onchange = () => { this.glq.selectAll('g.lql').style('display', $('showLql').checked ? null : 'none'); this.sizeLabels(); };
    $('names').onchange = () => this.applyNames();
    $('showImg').onchange = () => { const on = $('showImg').checked; this.gn.selectAll('image.img, circle.imgbg').style('display', on ? null : 'none'); this.gn.classed('imgs', on); this.applyImgSize(); this.draw(); };
    this.gn.classed('imgs', $('showImg').checked);
    // Min LQI: the LQI colour bar is the slider, a marker shows the setting, press or drag on the bar sets it
    this.updLegendMk = () => { const mk = $('lq').querySelector('b.mk'); if (!mk) return; const v = +$('hide').value; mk.style.left = (v / 2.55) + '%';
      $('lq').title = `Min LQI: ${$('hideV').textContent} · shows only links whose weaker direction is above it · press or drag on the bar · far left: show all`; };
    const setFromBar = (g, x) => { const r = g.getBoundingClientRect(), v = Math.max(0, Math.min(255, Math.round(((x - r.left) / r.width) * 255 / 5) * 5)), h = $('hide');
      if (+h.value === v && this.hideMode() === 'manual') return; h.value = v; lsSet(LS.hideMode, 'manual'); h.dispatchEvent(new Event('input')); };
    $('lq').addEventListener('pointerdown', e => {
      const g = e.target.closest?.('span.grad'); if (!g || e.button > 0) return;
      e.preventDefault(); try { g.setPointerCapture(e.pointerId); } catch (err) {} g.classList.add('drag'); setFromBar(g, e.clientX);
      // the value moves in steps of 5, so a full sweep re-renders at most ~50 times: no throttling needed
      const move = ev => setFromBar(g, ev.clientX);
      const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up); g.classList.remove('drag'); };
      g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
    });
    this.updLegendMk();
    $('hide').oninput = e => { if (e.isTrusted) lsSet(LS.hideMode, 'manual'); $('hideV').textContent = hideLabel(+$('hide').value); this.updLegendMk(); this._filterOnly = true; this.render(); };
    $('spring').value = this.spring; $('springV').textContent = this.spring.toFixed(1);
    $('spring').oninput = () => { this.spring = +$('spring').value; $('springV').textContent = this.spring.toFixed(1); lsSet(LS.spring, this.spring); this.sim.force('link').distance(dist); this.sim.force('charge').strength(charge); this.sim.alpha(0.5).restart(); };
    $('avoid').value = this.avoid; $('avoidV').textContent = this.avoid.toFixed(1);
    $('avoid').oninput = () => { this.avoid = +$('avoid').value; $('avoidV').textContent = this.avoid.toFixed(1); lsSet(LS.avoid, this.avoid); this.sim.force('avoid').strength(this.avoid); this.sim.alpha(0.5).restart(); };
    $('lqilen').value = this.lqilen; $('lqilenV').textContent = this.lqilen.toFixed(2).replace(/0$/, '');
    $('lqilen').oninput = () => { this.lqilen = +$('lqilen').value; $('lqilenV').textContent = this.lqilen.toFixed(2).replace(/0$/, ''); lsSet(LS.lqilen, this.lqilen); this.sim.force('link').distance(dist); this.sim.alpha(0.5).restart(); };
    this.pinMode = !!lsGet(LS.pin, false); $('pinmode').checked = this.pinMode;
    $('pinmode').onchange = () => { this.pinMode = $('pinmode').checked; lsSet(LS.pin, this.pinMode); };
    // controls at the bottom: the bars swap places; HA's sidebar button always goes into the bar at the top
    const applySwap = () => { const on = $('swapBars').checked; this.shadowRoot.getElementById('wrap').classList.toggle('swap', on);
      const mb = this.shadowRoot.querySelector('ha-menu-button'); (on ? $('foot') : $('bar')).prepend(mb); this.onResize(); };
    $('swapBars').addEventListener('change', applySwap); applySwap();
    $('find').oninput = () => { this.applySel(); if ($('devs').open) this.fillDevices(); };
    $('unpin').onclick = () => { if (!this.data) return; for (const n of this.data.nodes) n.fx = n.fy = null; this.savePos(); this.sim.alpha(0.6).restart(); this.draw(); };
    $('relayout').onclick = () => this.wake(0.8);
    $('resetview').onclick = e => this.fitView({ rotate: !e.shiftKey });
    $('png').onclick = () => this.savePng();
    $('resetall').onclick = () => {
      this._devSort = null;
      for (const k of [LS.prefs, LS.spring, LS.lqilen, LS.pin, LS.pos, LS.view, LS.sel, LS.avoid, LS.devSort, LS.hideSet, LS.hideMode]) { try { localStorage.removeItem(k); } catch (e) {} }
      this.sim.stop(); clearTimeout(this._posT); this.data = null; this.selected = null; this.warm = false; this._zoomT = null;
      if (this._storeSub) { try { this._storeSub(); } catch (e) {} this._storeSub = null; }
      this.build();   // rebuilds the bar and the graph with defaults; the cached map is re-read from storage
    };
  }
  // turn every node (positions, pins and velocities) by da radians around a point in graph coordinates
  rotateAll(da, [ox, oy]) {
    const c = Math.cos(da), s = Math.sin(da);
    for (const n of this.data.nodes) {
      if (n.x == null || n._parked) continue;   // docked nodes are anchored to the screen, not to the graph
      const dx = n.x - ox, dy = n.y - oy; n.x = ox + dx * c - dy * s; n.y = oy + dx * s + dy * c;
      if (n.fx != null) { const fx = n.fx - ox, fy = n.fy - oy; n.fx = ox + fx * c - fy * s; n.fy = oy + fx * s + fy * c; }
      if (n.vx) { const vx = n.vx, vy = n.vy || 0; n.vx = vx * c - vy * s; n.vy = vx * s + vy * c; }
    }
    this.draw();
  }
  fitOnSettle() { const o = this._fitOnSettle; this._fitOnSettle = null; this.fitView(o); }   // the deferred fit after a fresh layout, once the simulation is mostly settled
  // the find box: comma-separated terms, case-insensitive; a name matches when it contains any of them
  findTerms() { return this.$('find').value.toLowerCase().split(',').map(t => t.trim()).filter(Boolean); }
  nameMatches(n, terms) { const nm = n.name.toLowerCase(); return terms.some(t => nm.includes(t)); }
  // fit the drawn graph into the window: optionally turn it so its long axis follows the window's long axis (principal axis of
  // the node positions; pins and velocities turn with it, as with a manual rotation), then zoom and pan so the bounding box
  // of the drawn, undocked nodes fills the canvas with room for labels
  fitView({ rotate = false, animate = true } = {}) {
    if (!this.data || !this.svg) return;
    const cv = this.$('canvas'), W = cv.clientWidth, H = cv.clientHeight;
    const ns = this.data.nodes.filter(n => n.x != null && !n._parked && n._drawn !== false);
    if (ns.length < 2 || W < 50 || H < 50) return;
    const mean = f => ns.reduce((a, n) => a + f(n), 0) / ns.length, mx = mean(n => n.x), my = mean(n => n.y);
    let da = 0;
    if (rotate && ns.length >= 3) {
      const sxx = mean(n => (n.x - mx) ** 2), syy = mean(n => (n.y - my) ** 2), sxy = mean(n => (n.x - mx) * (n.y - my));
      const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);   // direction of the long axis
      da = (W >= H ? 0 : Math.PI / 2) - theta; while (da > Math.PI / 2) da -= Math.PI; while (da < -Math.PI / 2) da += Math.PI;   // the smaller turn (an axis has no sign)
      if (Math.abs(da) < 0.02) da = 0;
    }
    // the target view is computed on the positions as they will be after the turn, so turn and zoom can run as one motion
    const c = Math.cos(da), sn = Math.sin(da), after = n => da ? [mx + (n.x - mx) * c - (n.y - my) * sn, my + (n.x - mx) * sn + (n.y - my) * c] : [n.x, n.y];
    const pts = ns.map(after), pad = 80;   // graph units: labels below the nodes, pictures, a little air
    const x0 = Math.min(...pts.map(p => p[0])) - pad, x1 = Math.max(...pts.map(p => p[0])) + pad, y0 = Math.min(...pts.map(p => p[1])) - pad, y1 = Math.max(...pts.map(p => p[1])) + pad + 20;
    const k = Math.max(0.15, Math.min(6, Math.min(W / (x1 - x0), H / (y1 - y0))));
    const t = d3.zoomIdentity.translate(W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k);
    if (!animate) { if (da) { this.rotateAll(da, [mx, my]); this.savePos(); } this.svg.call(this.zoom.transform, t); return; }
    let turned = 0;   // the turn is dealt out in increments along the same eased clock as the zoom
    this.svg.interrupt('fit').transition('fit').duration(FIT_MS).ease(d3.easeCubicOut)
      .tween('turn', () => p => { if (!da) return; const want = da * p; this.rotateAll(want - turned, [mx, my]); turned = want; })
      .call(this.zoom.transform, t)
      .on('end', () => { if (da) this.savePos(); });
  }
  // graph state: every node's last position (pinned ones flagged) + the zoom/pan view, so a revisit starts where you left off
  savePos() { const o = {}; if (this.data) for (const n of this.data.nodes) if (n.x != null && !n._parked) o[n.id] = [Math.round(n.x), Math.round(n.y), n.fx != null ? 1 : 0]; lsSet(LS.pos, o); }
  savePosSoon() { clearTimeout(this._posT); this._posT = setTimeout(() => this.savePos(), 1500); }
  saveView() { if (this._zoomT) lsSet(LS.view, { k: this._zoomT.k, x: this._zoomT.x, y: this._zoomT.y }); }
  visible() {
    const $ = this.$, se = $('showEnd').checked, so = $('showOne').checked, sr = $('selOne').checked, ss = $('showSib').checked, hv = +$('hide').value;
    const sg = $('showGhosts').checked;
    // end devices hidden from view stay in the physics (they keep their place and their parent's neighbourhood), so the
    // toggle is a filter like Min LQI; ghosts are in or out of the layout with their switch
    const physNodes = this.data.nodes.filter(n => sg || n.type !== 'Unknown');
    const nodes = physNodes.filter(n => se || !n.isEnd);
    const inPhys = new Set(physNodes.map(n => n.id)), vis = new Set(nodes.map(n => n.id));
    for (const n of this.data.nodes) n._drawn = vis.has(n.id);
    const sel = this.selected;
    const links = [], phys = [];
    for (const l of this.data.links) {
      if (!inPhys.has(l.s.id) || !inPhys.has(l.t.id)) continue;
      const kind = (so || !l.oneSided) && (ss || !l.sibling);
      const shown = vis.has(l.s.id) && vis.has(l.t.id);   // both ends drawn   // the type filters (one-sided, sibling) decide what is part of the layout at all
      // Min LQI is a statement about the router mesh: end-device links (one direction by nature, often 40-60) are not filtered
      const normal = kind && (l.oneSided || l.endLink || hideOk(l.min, hv));
      l.revealed = !normal && !!sel && this.touchesSel(l) && (so || sr || !l.oneSided);   // shown only because of the selection: drawn, but no force
      // Min LQI is a filter, not a layout: a link it hides stays in the physics at a fraction of its pull, so the slider never
      // rewires the graph and nodes keep their places (and a node whose links all fall below the threshold is not parked)
      l.faded = kind && !normal;
      if (shown && (normal || l.revealed)) links.push(l);
      if (kind) phys.push(l);
    }
    return { nodes, links, phys, physNodes };
  }
  render() {
    if (!this.data) return;
    const { nodes, links, phys, physNodes } = this.visible(), self = this, byId = this.data.byId, $ = this.$;
    const color = l => l.oneSided ? LQ.grey : lqColor(l.min);
    const width = l => this.linkWidth(l);
    const fmt = v => v == null ? '–' : v, key = l => l.s.id + '|' + l.t.id;
    // routing-table entries, identical ones collapsed (tables often hold a dozen inactive entries for one destination)
    // routes over a link, one line per direction: "A → B → destinations". A route entry sits in A's table (via) and names the
    // next hop, which is the other end of this link; the destination is a network address, named when we know the device
    const STATUS = { ACTIVE: '', DISCOVERY_UNDERWAY: 'discovering', DISCOVERY_FAILED: 'failed', INACTIVE: 'inactive', VALIDATION_UNDERWAY: 'validating' };
    const byNwk = {}; for (const n of this.data.nodes) if (n.nwk != null) byNwk[n.nwk] = n;
    const routesHtml = l => {
      const dirs = new Map();   // via ieee -> Map(dest label -> count)
      for (const r of l.routes) {
        const d = dirs.get(r.via) ?? new Map(); dirs.set(r.via, d);
        const st = STATUS[r.status] ?? String(r.status).toLowerCase(), label = `${byNwk[r.to]?.name ?? `nwk ${r.to}`}${st ? ` <span class="muted">(${st})</span>` : ''}`;
        d.set(label, (d.get(label) || 0) + 1);
      }
      const rows = [];
      for (const [via, d] of dirs) {
        const from = byId[via], to = from === l.s ? l.t : l.s; if (!from) continue;
        rows.push(`<div class="rt"><b>${esc(from.name)}</b> → <b>${esc(to.name)}</b> → ${[...d].map(([k, n]) => n > 1 ? `${k} ×${n}` : k).join(', ')}</div>`);
      }
      return rows.length ? `<div class="routes"><div class="h">routes over this link</div>${rows.join('')}</div>` : '';
    };
    // each link = a group with the visible line and a wide invisible "hit" line for hovering
    const link = this.gl.selectAll('g.link').data(links, key); link.exit().remove();
    const le = link.enter().append('g').attr('class', 'link');
    le.append('line').attr('class', 'vis'); le.append('line').attr('class', 'hit');
    le.append('path').attr('class', 'arr arrS').attr('d', 'M-9,-5 L0,0 L-9,5 Z'); le.append('path').attr('class', 'arr arrT').attr('d', 'M-9,-5 L0,0 L-9,5 Z');
    const lm = le.merge(link).classed('removed', l => l.removed);
    lm.select('line.vis').attr('stroke', color).attr('stroke-width', width).attr('stroke-dasharray', l => l.oneSided ? '4 4' : null);
    const ro = this.routesOn();
    lm.select('path.arrS').attr('fill', color).style('display', l => ro && l.rVia?.has(l.s.id) ? null : 'none');
    lm.select('path.arrT').attr('fill', color).style('display', l => ro && l.rVia?.has(l.t.id) ? null : 'none');
    $('routesNote').textContent = ro && !this._hasRoutes ? 'this map has no routes: scan with "routes on pull"' : '';
    this._syncRoutesCtl?.();
    lm.select('line.hit')
      .on('mouseenter', (e, l) => this._pinned || !$('hoverTips').checked || this.showTip(e, `<div class="big"><span style="color:${lqColor(l.lqS)}">${fmt(l.lqS)}</span> <span style="color:var(--muted)">/</span> <span style="color:${lqColor(l.lqT)}">${fmt(l.lqT)}</span></div>` +
        esc(`${l.s.name}  ⟷  ${l.t.name}\n${l.s.name} hears ${l.t.name}: ${fmt(l.lqS)}  (${REL[l.relS] ?? '–'})\n${l.t.name} hears ${l.s.name}: ${fmt(l.lqT)}  (${REL[l.relT] ?? '–'})`) + (l.routes.length ? routesHtml(l) : ''), true))
      .on('mousemove', e => { if (!this._pinned) this.moveTip(e); }).on('mouseleave', () => { if (!this._pinned) this.hideTip(); });
    // LQI label: a pill in the link's colour with the two values, centred on the link and turned along it
    const lql = this.glq.selectAll('g.lql').data(links, key); lql.exit().remove();
    const lqe = lql.enter().append('g').attr('class', 'lql'); lqe.append('rect').attr('rx', 4); lqe.append('text').attr('text-anchor', 'middle').attr('dominant-baseline', 'central');
    const lqm = lqe.merge(lql).classed('removed', l => l.removed).style('display', $('showLql').checked ? null : 'none');
    lqm.select('rect').attr('fill', color); lqm.select('text').text(l => `${fmt(l.lqS)} / ${fmt(l.lqT)}`);
    this.sizeLabels();
    const node = this.gn.selectAll('g.node').data(nodes, n => n.id); node.exit().remove();
    const ne = node.enter().append('g').attr('class', 'node').call(d3.drag()
      .on('start', (e, d) => { d._moved = false; d._wasPinned = d.fx != null; d._x0 = e.x; d._y0 = e.y; d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { if (!d._moved) { if (Math.hypot(e.x - d._x0, e.y - d._y0) < 4) return; d._moved = true; self.hideTip(); self.sim.alphaTarget(0.25).restart(); } d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => {
        if (!d._moved) { if (!d._wasPinned) { d.fx = d.fy = null; } return; }   // plain click: nothing moved, nothing heats
        if (!e.active) self.sim.alphaTarget(0);
        if (!(self.pinMode || e.sourceEvent?.shiftKey || d._wasPinned)) { d.fx = d.fy = null; }   // a pinned node stays pinned
        self.savePos(); self.draw();
      }))
      // single click (delayed so a double-click does not also select) toggles the neighbour view, double-click toggles the pin
      .on('click', (e, d) => { e.stopPropagation(); clearTimeout(self._clickT); const mod = e.ctrlKey || e.metaKey || e.shiftKey, pos = { clientX: e.clientX, clientY: e.clientY };
        self._clickT = setTimeout(() => {
          // plain click on the selected node with its card closed (closed by a click, Esc, or the drawer): bring the card back
          if (!mod && self.sel.size === 1 && self.sel.has(d) && self._pinned !== d) { self.pinTip(d, pos); return; }
          self.clickSelect(d, { ctrlKey: mod });
          if (self.sel.has(d)) self.pinTip(d, pos); else self.hideTip();   // also drops a hover preview a phone tap left behind
        }, 260); })
      .on('dblclick', (e, d) => { e.stopPropagation(); clearTimeout(self._clickT); if (d.fx != null) { d.fx = d.fy = null; self.sim.alpha(0.3).restart(); } else { d.fx = d.x; d.fy = d.y; } self.savePos(); self.draw(); })
      .on('mouseenter', (e, d) => { if (!this._pinned && $('hoverTips').checked) this.showTip(e, this.nodeTipHtml(d), true); })
      .on('mousemove', e => { if (!this._pinned) this.moveTip(e); }).on('mouseleave', () => { if (!this._pinned) this.hideTip(); });
    ne.append('circle').attr('class', 'halo').attr('r', d => d.type === 'Coordinator' ? 22 : d.isEnd ? 14 : 19);
    ne.append('circle').attr('class', 'ring').attr('r', d => d.type === 'Coordinator' ? 15 : d.isEnd ? 9 : 12).attr('fill', 'none').attr('stroke', 'none').attr('stroke-width', 2);
    ne.each(function (d) {
      const s = d3.select(this);
      if (d.type === 'Coordinator') s.append('circle').attr('class', 'shape').attr('r', 11).attr('fill', 'var(--yellow)').attr('stroke', '#000');
      else if (d.isEnd) s.append('circle').attr('class', 'shape').attr('r', 7).attr('fill', '#9aa3b2').attr('stroke', '#000');
      else s.append('rect').attr('class', 'shape').attr('x', -8).attr('y', -8).attr('width', 16).attr('height', 16).attr('rx', 3).attr('fill', 'var(--blue)').attr('stroke', '#000');
    });
    const withImg = ne.filter(d => d.type !== 'Coordinator' && imgUrl(d.model)).classed('hasimg', true);
    withImg.append('circle').attr('class', 'imgbg').attr('r', d => d.isEnd ? 14 : 21).style('display', $('showImg').checked ? null : 'none');
    withImg.append('image').attr('class', 'img')
      .attr('href', d => imgUrl(d.model)).attr('preserveAspectRatio', 'xMidYMid meet').style('display', $('showImg').checked ? null : 'none')
      .on('error', function () { const g = this.parentNode; this.remove(); g.querySelector('circle.imgbg')?.remove(); g.classList.remove('hasimg'); d3.select(g).select('text').attr('dy', g.__data__.isEnd ? 14 : 22); g.__data__._r = g.__data__.isEnd ? 7 : 12; });
    ne.append('g').attr('class', 'orbit').append('circle').attr('class', 'dot').attr('r', 7.8)
      .each(function () { const a = document.createElementNS('http://www.w3.org/2000/svg', 'animateTransform'); a.setAttribute('attributeName', 'transform'); a.setAttribute('type', 'rotate'); a.setAttribute('from', '0 0 0'); a.setAttribute('to', '360 0 0'); a.setAttribute('dur', '1.6s'); a.setAttribute('repeatCount', 'indefinite'); this.parentNode.appendChild(a); });   // an electron around a node open for joining
    ne.append('text').attr('dy', d => d.isEnd ? 17 : 22).attr('text-anchor', 'middle');
    // labels follow renames: rewrite the text whenever the node's name differs from what is drawn (covers new nodes too)
    this.gn.selectAll('g.node').each(function (d) { const t = this.querySelector('text'); if (t.__label !== d.name) { t.__label = d.name; wrapLabel(t, d.name, d.isEnd ? 90 : 100); } });
    this.gn.selectAll('g.node').classed('end', d => d.isEnd).classed('stale', d => d.stale).classed('removed', d => d.removed);
    this.markJoinOpen();
    this.applyImgSize(); this.applyNames();
    const deg = {}; for (const l of phys) { deg[l.s.id] = (deg[l.s.id] || 0) + 1; deg[l.t.id] = (deg[l.t.id] || 0) + 1; }   // parking: no link in the layout at all, whatever Min LQI says
    this._deg = deg;
    const cv = $('canvas'), cx = cv.clientWidth / 2, cy = cv.clientHeight / 2;
    this.sim.nodes(physNodes); this.sim.force('link').links(phys); this.sim.force('avoid').links(links);   // physics: every link of the layout; clearance: only drawn links
    this.applyGravity();
    for (const n of physNodes) if (n.x == null) { n.x = cx + (Math.random() - 0.5) * 80; n.y = cy + (Math.random() - 0.5) * 80; }
    if (!this.warm) { this.warm = true; this.sim.force('center', d3.forceCenter(cx, cy)); this.sim.alpha(1); for (let i = 0; i < 250; i++) this.sim.tick(); }
    if (this._selOnly) { for (const l of links) { l.source = l.s; l.target = l.t; } this.draw(); }   // selection: redraw in place, no physics
    else if (this._filterOnly) this.wake(0.2);   // Min LQI: a gentle resettle, forces fading in (the wiring did not change, only what is drawn)
    else this.wake(this._gentle ? 0.15 : 0.5);
    this._selOnly = false; this._gentle = false; this._filterOnly = false;
    this.applySel();
  }
  // image, backing disc, label offset and collision radius follow the image-size slider
  applyImgSize() {
    if (!this.gn) return;
    const on = this.$('showImg').checked, S0 = this.imgsize || 24;
    this.gn.selectAll('g.node').each(function (d) {
      const S = d.isEnd ? Math.round(S0 * 0.67) : S0, r = S / 2 + 6, g = d3.select(this), has = !!this.querySelector('image.img');
      g.select('image.img').attr('width', S).attr('height', S).attr('x', -S / 2).attr('y', -S / 2);
      g.select('circle.imgbg').attr('r', r);
      // without a picture the generic shape scales with the same slider (30 = the original size)
      const f = S0 / 30, shape = g.select('.shape');
      if (d.type === 'Coordinator') shape.attr('r', 11 * f); else if (d.isEnd) shape.attr('r', 7 * f); else shape.attr('x', -8 * f).attr('y', -8 * f).attr('width', 16 * f).attr('height', 16 * f).attr('rx', 3 * f);
      g.select('text').attr('dy', has && on ? r + 11 : (d.isEnd ? 9 : 11) * f + 10);
      d._r = has && on ? r + 1 : (d.type === 'Coordinator' ? 14 : d.isEnd ? 9 : 12) * f;   // where this node's own links end
      // the stale ring and the pin halo follow the image size, otherwise they sit inside a large picture
      const ringR = has && on ? r : (d.type === 'Coordinator' ? 15 : d.isEnd ? 9 : 12) * f;
      g.select('circle.ring').attr('r', ringR); g.select('circle.halo').attr('r', ringR + 7);
      g.select('g.orbit circle.dot').attr('cx', ringR).attr('r', Math.max(3.5, 0.26 * S));   // the electron rides on the selection ring and scales with the node
    });
    const f = S0 / 30;
    this.sim?.force('collide')?.radius(d => d.isEnd ? Math.max(18 * f, on ? S0 * 0.33 + 10 : 0) : Math.max(42 * f, on ? S0 / 2 + 14 : 0));
  }
  // weak gravity toward the canvas centre so nodes that lose all visible links do not fly off; nodes WITHOUT any visible
  // link take no part in the layout at all, they are docked at the bottom of the screen (dockParked)
  applyGravity() {
    if (!this.sim || !this._deg || !this.data) return;
    const cv = this.$('canvas'), cx = cv.clientWidth / 2, cy = cv.clientHeight / 2, deg = this._deg, iso = d => !deg[d.id];
    this.sim.force('x', d3.forceX(cx).strength(d => iso(d) ? 0 : 0.03)).force('y', d3.forceY(cy).strength(d => iso(d) ? 0 : 0.03));
    this.dockParked();
  }
  // nodes without any visible link are docked in rows along the bottom of the SCREEN (not of the graph), whatever the zoom,
  // pan or rotation: they are not part of the layout, they are a list. Their fx/fy are set from screen coordinates every
  // time the view changes; a node that gains a link again is released (unless the user had pinned it)
  dockParked() {
    if (!this.sim || !this._deg || !this.data) return;
    const cv = this.$('canvas'), W = cv.clientWidth, H = cv.clientHeight, deg = this._deg;
    const parked = this.sim.nodes().filter(d => !deg[d.id] && d._drawn).sort((a, b) => Number(a.isEnd) - Number(b.isEnd) || a.name.localeCompare(b.name));
    const t = this._zoomT || d3.zoomIdentity;
    const perRow = Math.max(1, Math.floor((W - 24) / 64)), rows = Math.ceil(parked.length / perRow);
    parked.forEach((d, i) => {
      const row = Math.floor(i / perRow), n = Math.min(perRow, parked.length - row * perRow), col = i - row * perRow;
      const sx = 12 + (col + 0.5) * ((W - 24) / n), sy = H - 48 - (rows - 1 - row) * 48;   // last row at the bottom, room for the label below the node
      const [gx, gy] = t.invert([sx, sy]);
      if (!d._parked) { d._parked = true; d._userPinned = d.fx != null; }
      d.fx = d.x = gx; d.fy = d.y = gy; d.vx = d.vy = 0;
    });
    for (const d of this.sim.nodes()) if (d._parked && deg[d.id]) { d._parked = false; if (!d._userPinned) d.fx = d.fy = null; }
  }
  // constant width: colour alone carries the LQI; one-sided links are hairlines
  // routes overlay: links carrying active routes get thicker, the more routes the thicker; the rest keep their width
  linkWidth(l) { if (l.oneSided) return 0.8; const k = this.routesOn(), n = k ? (l.rA?.length || 0) : 0; return n ? Math.min(3 + 4 * k, 3 + 0.5 * k * n) : 3; }
  routesOn() { const v = +(this.$('showRoutes')?.value || 0); return v > 0 ? v : 0; }   // 0: overlay off · else the thickness factor
  // the chain of next hops from a router to the coordinator, as [links], or null when the map holds no such route
  pathHome(n) {
    const links = [], seen = new Set(); let cur = n;
    while (cur && cur.type !== 'Coordinator' && !seen.has(cur)) { seen.add(cur); const nx = this._uplink?.[cur.id]; if (!nx) return null;
      const l = this.data.links.find(l => (l.s === cur && l.t === nx) || (l.t === cur && l.s === nx)); if (!l) return null; links.push(l); cur = nx; }
    return cur?.type === 'Coordinator' ? links : null;
  }
  // labels: none / routers (coordinator included) / all
  // auto: set by the panel (no render here, the caller renders) · otherwise a user choice, remembered
  // 'manual' (bar dragged) · 'connected' / 'redundant' (mesh number clicked: re-applied on every new map) · null: automatic = connected
  hideMode() { const m = lsGet(LS.hideMode, null); return m || (lsGet(LS.hideSet, false) ? 'manual' : null); }
  // auto: applied by the panel on a new map (no render here, the caller renders) · otherwise a click on a mesh number
  // a restart whose forces fade in over RAMP_MS: the first ticks move nodes gently instead of yanking them into the new
  // wiring (the link pull and "keep nodes off links" start near zero and reach their set values at the end of the ramp)
  // Only links whose pull CHANGED ramp: one the slider just revealed goes from its hidden fifth to full over RAMP_TICKS, one
  // just hidden goes the other way, a new link on a fresh map starts near zero; every other link keeps its pull, so nothing
  // it holds moves. (Ramping all links let the repulsion win for half a second: the whole graph swelled and shrank back.)
  linkPull(l) {
    const base = l.oneSided ? 0.15 : 0.5, k1 = l.faded ? FADED_PULL : 1;
    const r = this._ramp ? 1 - this._ramp / RAMP_TICKS : 1, k0 = l._k0 ?? k1;
    l._pull = k0 + (k1 - k0) * r;
    return base * l._pull;
  }
  wake(alpha) {
    for (const l of this.sim.force('link').links()) l._k0 = l._pull ?? 0.1;   // where each link's pull starts: its current value, new links near zero
    this._ramp = RAMP_TICKS; this.tickRamp(true); this.sim.alpha(alpha).restart();
  }
  tickRamp(start = false) {   // counted in ticks, not time: a throttled tab still ramps
    if (!this._ramp) return;
    if (!start) this._ramp--;
    this.sim.force('avoid').strength(this.avoid * (1 - this._ramp / RAMP_TICKS));
    this.sim.force('link').strength(this.sim.force('link').strength());   // d3 caches strengths: re-set so linkPull() is read again
  }
  // keyboard: ← → move Min LQI by one step (manual from then on); ↑ ↓ jump between the stops 0 · redundant · connected · 255
  // (a mesh stop is followed on every new map, like clicking the footer number)
  nudgeMinLqi(d) { const h = this.$('hide'), v = Math.max(0, Math.min(255, +h.value + d)); if (v === +h.value) return; h.value = v; lsSet(LS.hideMode, 'manual'); h.dispatchEvent(new Event('input')); }
  cycleMinLqi(dir) {
    const h = this.$('hide'), cur = +h.value, m = this.mesh, slider = v => Math.max(0, Math.floor((v - 1) / 5) * 5);
    const stops = [{ v: 0 }, { v: 255 }]; if (m) { stops.push({ v: slider(m.redundant), mode: 'redundant', raw: m.redundant }); stops.push({ v: slider(m.connected), mode: 'connected', raw: m.connected }); }
    const next = stops.filter(st => dir > 0 ? st.v > cur : st.v < cur).sort((a, b) => dir > 0 ? a.v - b.v : b.v - a.v)[0];
    if (!next) return;
    if (next.mode) { lsSet(LS.hideMode, next.mode); this.setMinLqi(next.raw, false, next.mode); }
    else { h.value = next.v; lsSet(LS.hideMode, 'manual'); h.dispatchEvent(new Event('input')); }
  }
  setMinLqi(v, auto = false, mode = null) { const h = this.$('hide'); h.value = Math.max(0, Math.floor((v - 1) / 5) * 5);
    const note = mode ? ` (follows ${mode})` : ' (automatic: the connected threshold)';
    if (auto) { this.$('hideV').textContent = hideLabel(+h.value) + note; this.updLegendMk?.(); return; }
    h.dispatchEvent(new Event('input')); this.$('hideV').textContent = hideLabel(+h.value) + note; this.updLegendMk?.(); }
  applyNames() {
    const mode = this.$('names').value;
    this.gn?.selectAll('g.node text').style('display', d => mode === 'all' || (mode === 'routers' && !d.isEnd) ? null : 'none');
  }
  // the label pill takes the size of its text (measured once per render; a hidden text has no size, so only when shown)
  sizeLabels() {
    if (!this.$('showLql').checked) return;
    this.glq.selectAll('g.lql').each(function (l) { const t = this.querySelector('text'), r = this.querySelector('rect'); let w = 30, h = 11;
      try { const b = t.getBBox(); if (b.width > 0) { w = b.width + 8; h = b.height + 2; } } catch (e) {}
      l._lw = w; l._lh = h;
      r.setAttribute('x', -w / 2); r.setAttribute('y', -h / 2); r.setAttribute('width', w); r.setAttribute('height', h); });
  }
  // label pills slide along their own link when they overlap another pill (hubs), and drift back to the middle when free.
  // Pills are treated as discs of half their width; a few small steps per frame, so they move smoothly
  spaceLabels() {
    if (!this.$('showLql').checked || !this.data) return;
    const ls = this.data.links.filter(l => l._lw && l.source.x != null), P = [];
    // a pill grows with its link's width (routes overlay), half as fast as the line, like the arrows
    for (const l of ls) {
      const t = l._lt ?? 0.5; l._lhit = false; l._lf = Math.min(1.8, 1 + Math.max(0, this.linkWidth(l) / 3 - 1) / 3);
      // the stretch a pill may use: clear of both nodes by a margin; too short for the pill at all -> hidden (l._lroom = false)
      const len = Math.hypot(l.target.x - l.source.x, l.target.y - l.source.y) || 1, half = l._lw * 0.5 * l._lf + 5;
      l._lmin = ((l.source._r ?? 10) + half) / len; l._lmax = 1 - ((l.target._r ?? 10) + half) / len; l._lroom = l._lmin <= l._lmax;
      if (!l._lroom) continue;
      if (l._lt != null) l._lt = Math.max(l._lmin, Math.min(l._lmax, l._lt));
      P.push({ l, x: l.source.x + (l.target.x - l.source.x) * t, y: l.source.y + (l.target.y - l.source.y) * t, r: l._lw * 0.5 * l._lf }); }
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const a = P[i], b = P[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = (a.r + b.r) * 0.85;
      if (d >= min || d === 0) continue;
      // each pill moves along its own link, away from the other pill. The direction is remembered while the pill keeps
      // colliding, so two pills do not take turns flipping sides (that oscillated); steps shrink as the overlap shrinks
      for (const [p, sx, sy] of [[a, -dx, -dy], [b, dx, dy]]) {
        const l = p.l, ux = l.target.x - l.source.x, uy = l.target.y - l.source.y, len = Math.hypot(ux, uy) || 1;
        if (!l._ldir) l._ldir = Math.sign(sx * ux + sy * uy) || 1;
        const t = (l._lt ?? 0.5) + l._ldir * Math.min(0.02, 0.4 * (min - d) / len);
        l._lt = Math.max(l._lmin, Math.min(l._lmax, t)); l._lhit = true;   // at the end of the allowed stretch it simply stays (no flipping back and forth)
      }
    }
    // free pills drift back toward the middle, but only into space that is free (with a margin), so a pill never moves
    // back into the collision that pushed it out: the arrangement settles instead of cycling
    const clear = (l, t) => { const x = l.source.x + (l.target.x - l.source.x) * t, y = l.source.y + (l.target.y - l.source.y) * t, r = l._lw * 0.5 * (l._lf || 1);
      for (const q of P) if (q.l !== l && Math.hypot(q.x - x, q.y - y) < (r + q.r) * 0.95) return false; return true; };
    for (const l of ls) if (l._lroom && !l._lhit) { l._lfree = (l._lfree || 0) + 1; if (l._lfree > 30) l._ldir = 0;
      if (l._lt != null && l._lfree > 10 && Math.abs(l._lt - 0.5) > 0.002) { const t = Math.max(l._lmin, Math.min(l._lmax, l._lt + (0.5 - l._lt) * 0.03)); if (clear(l, t)) l._lt = t; } } else l._lfree = 0;
  }
  draw() {
    // each link runs from rim to rim of its own two nodes (gap = node radius), so a link passing under a third node is not cut
    const ro = this.routesOn(), self = this;
    this.gl.selectAll('g.link').each(function (l) {
      const s = l.source, t = l.target, dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1, rs = s._r ?? 10, rt = t._r ?? 10;
      let x1 = s.x, y1 = s.y, x2 = t.x, y2 = t.y;
      const ux = dx / len, uy = dy / len;
      if (len > rs + rt + 4) { x1 += ux * rs; y1 += uy * rs; x2 -= ux * rt; y2 -= uy * rt; } else { x2 = x1; y2 = y1; }
      // route arrows: scaled with the line's width, tip at the far rim, and the line stops where the arrow starts
      const aS = ro && l.rVia?.has(l.s.id), aT = ro && l.rVia?.has(l.t.id), k = (aS || aT) ? 1 + Math.max(0, (this.classList.contains('onpath') ? 12 : self.linkWidth(l)) / 3 - 1) / 2 : 1, aLen = 9 * k - 1, deg = Math.atan2(dy, dx) * 180 / Math.PI;
      const tipS = [x2, y2], tipT = [x1, y1];
      if (aS) { x2 -= ux * aLen; y2 -= uy * aLen; }
      if (aT) { x1 += ux * aLen; y1 += uy * aLen; }
      for (const ln of this.children) {
        if (ln.tagName === 'line') { ln.setAttribute('x1', x1); ln.setAttribute('y1', y1); ln.setAttribute('x2', x2); ln.setAttribute('y2', y2); }
        else if (ln.classList.contains('arrS')) ln.setAttribute('transform', `translate(${tipS[0]},${tipS[1]}) rotate(${deg}) scale(${k})`);   // s -> t: tip at t's rim
        else if (ln.classList.contains('arrT')) ln.setAttribute('transform', `translate(${tipT[0]},${tipT[1]}) rotate(${deg + 180}) scale(${k})`);   // t -> s: tip at s's rim
      }
    });
    // label text: what the left-hand node hears / what the right-hand node hears, whichever end that is on screen
    const fmt = v => v == null ? '–' : v;
    this.spaceLabels();
    this.glq.selectAll('g.lql').style('visibility', l => l._lroom === false ? 'hidden' : null).attr('transform', l => { const dx = l.target.x - l.source.x, dy = l.target.y - l.source.y; let a = Math.atan2(dy, dx) * 180 / Math.PI; if (a > 90 || a < -90) a += 180;   // never upside down
      const t = l._lt ?? 0.5; return `translate(${l.source.x + dx * t},${l.source.y + dy * t}) rotate(${a}) scale(${l._lf || 1})`; })
      .select('text').text(l => l.source.x <= l.target.x ? `${fmt(l.lqS)} / ${fmt(l.lqT)}` : `${fmt(l.lqT)} / ${fmt(l.lqS)}`);
    this.gn.selectAll('g.node').attr('transform', d => `translate(${d.x},${d.y})`).classed('pinned', d => d.fx != null && !d._parked);
  }
  applySel() {
    if (!this.data) return;
    const terms = this.findTerms(), sel = this.selected;
    const matches = terms.length ? new Set(this.data.nodes.filter(n => this.nameMatches(n, terms)).map(n => n.id)) : null;
    const keep = new Set();
    if (sel) { for (const n of this.sel) keep.add(n.id); this.gl.selectAll('g.link').each(l => { if (this.sel.has(l.s)) keep.add(l.t.id); if (this.sel.has(l.t)) keep.add(l.s.id); }); }
    const path = sel && this.routesOn() && this.sel.size === 1 ? this.pathHome(sel) : null, onPath = new Set(path || []);
    if (path) for (const l of path) { keep.add(l.s.id); keep.add(l.t.id); }
    const active = sel ? keep : matches;
    const linkOn = l => !active || (sel ? (this.touchesSel(l) || onPath.has(l)) : (active.has(l.s.id) || active.has(l.t.id)));
    this.gl.selectAll('g.link').classed('onpath', l => onPath.has(l));
    this.gn.selectAll('g.node').classed('dim', d => active && !active.has(d.id)).classed('sel', d => this.sel.has(d) || (matches && matches.has(d.id) && !sel));
    this.gl.selectAll('g.link').classed('dim', l => !linkOn(l));
    this.glq.selectAll('g.lql').classed('dim', l => !linkOn(l));
    this.draw();   // arrow size and line ends depend on the on-path class set just now; a selection change restarts no physics, so nothing else would redraw
    if (this.$('devs')?.open) this.fillDevices();
  }
  // keep a dropdown inside the panel: as wide as it wants up to the panel width (minus a margin), shifted left when it would
  // stick out on the right. On a phone the panel is narrower than the menu's preferred width, so the menu shrinks and wraps.
  placeMenu(d) {
    const m = d?.querySelector('.menu'); if (!m || !d.open) return;
    const host = this.getBoundingClientRect(), right = Math.min(host.right, document.documentElement.clientWidth), margin = 8;
    m.style.left = '0px'; m.style.setProperty('--avail', Math.max(160, right - host.left - 2 * margin) + 'px');
    const r = m.getBoundingClientRect(), swap = this.shadowRoot.getElementById('wrap').classList.contains('swap');
    // height: down to the panel's bottom edge, or up to its top edge when the menu opens upwards; the menu scrolls inside
    const bottom = Math.min(host.bottom, document.documentElement.clientHeight);
    m.style.setProperty('--availH', Math.max(120, swap ? r.bottom - host.top - margin : bottom - r.top - margin) + 'px');
    let shift = Math.max(0, r.right - (right - margin));
    shift = Math.min(shift, r.left - (host.left + margin));   // never past the panel's left edge
    m.style.left = -Math.max(0, shift) + 'px';
  }
  // HA is a single-page app: navigate without a page load; the panel keeps its state through savePos/saveView/selection on disconnect
  navTo(href) { history.pushState(null, '', href); window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true })); }
  // Zigbee2MQTT's frontend in a drawer over the map (the map keeps running underneath); Ctrl/middle click still opens a tab
  openSide(url, title) { this.$('sideTitle').textContent = title; this.$('sideExt').href = url; const f = this.$('sideFrame'); if (f.src !== url) f.src = url; this.$('side').classList.add('show'); }
  closeSide() { this.$('side').classList.remove('show'); this.$('sideFrame').src = 'about:blank'; }
  // the Zigbee2MQTT device page in the drawer. Frontend URL: directly. Add-on sidebar path: the same dance Home Assistant's own
  // ingress view does (session cookie + the add-on's ingress url), which lets the drawer address the device page; needs an
  // administrator (Supervisor API), otherwise it falls back to opening the add-on's page in place.
  async openZ2m(n, href) {
    if (!n) return;
    const z2m = this.z2mUrl, title = n.name + ' · Zigbee2MQTT';
    if (!z2m.startsWith('/')) { this.openSide(href, title); return; }
    const slug = z2m.replace(/^\/+/, '').split('/')[0], h = this._hass;
    try {
      if (!this._ingress) {
        const r = await h.callApi('POST', 'hassio/ingress/session'), session = (r?.data ?? r)?.session;
        if (!session) throw new Error('no ingress session');
        document.cookie = `ingress_session=${session};path=/api/hassio_ingress/;SameSite=Strict${location.protocol === 'https:' ? ';Secure' : ''}`;
        const info = await h.callApi('GET', `hassio/addons/${slug}/info`), url = (info?.data ?? info)?.ingress_url;
        if (!url) throw new Error('no ingress url');
        this._ingress = { session, url: url.replace(/\/+$/, '') };
        this._ingressT = setInterval(() => h.callApi('POST', 'hassio/ingress/validate_session', { session }).catch(() => {}), 60000);
      }
      this.openSide(`${this._ingress.url}/#/device/0/${encodeURIComponent(n.id)}`, title);
    } catch (e) { this.navTo(z2m); }
  }
  // ---- devices list: the selected node and its neighbours, or everything ----
  get z2mUrl() { return String(this._panel?.config?.z2m_url || '').trim().replace(/\/+$/, ''); }
  // HA device ids of the Zigbee2MQTT devices: Z2M's discovery identifiers are "zigbee2mqtt_<ieee>" (the bridge: "zigbee2mqtt_bridge_<ieee>")
  async loadRegistry() {
    if (!this._hass?.callWS) return;
    try {
      const list = await this._hass.callWS({ type: 'config/device_registry/list' }), m = {};
      for (const d of list) for (const ident of d.identifiers || []) { const id = ident?.[1]; if (ident?.[0] === 'mqtt' && typeof id === 'string' && id.startsWith('zigbee2mqtt_')) m[id.replace(/^zigbee2mqtt_(bridge_)?/, '')] = d.id; }
      this._reg = m;
    } catch (e) { this._reg ??= {}; }
  }
  fillDevices() {
    const box = this.$('devMenu'); if (!box) return;
    if (!this.data) { box.innerHTML = '<div class="muted">no map yet</div>'; return; }
    const sel = this.selected, reg = this._reg || {}, z2m = this.z2mUrl, terms = this.findTerms();
    // zigbee-herdsman stamps the coordinator's lastSeen once, at start-up, and never on traffic: it is the Z2M start time
    const seen = n => !n.lastSeen ? (n.type === 'Coordinator' ? '' : '?') : n.type === 'Coordinator' ? `Z2M up ${ago(Date.now() - n.lastSeen).replace(' ago', '')}` : ago(Date.now() - n.lastSeen);
    const linksFor = n => this.devLinks(n);
    const row = (n, extra = '') => `<tr data-id="${esc(n.id)}" class="${this.sel.has(n) ? 'sel' : ''}${n.removed ? ' removed' : ''}"><td class="name" title="${esc(n.id)}">${esc(n.name)}</td><td>${linksFor(n)}</td><td class="muted">${esc(n.type === 'EndDevice' ? 'end device' : n.type.toLowerCase())}${n.removed ? ' · removed' : ''}</td>${extra}<td class="muted">${esc(seen(n))}</td></tr>`;
    // sorting: click a header (name, type, LQI, last seen); again reverses. LQI compares the weaker direction first, then the
    // stronger one; last seen puts the most recent first. Without a choice: devices by type then name, neighbours by LQI.
    const st = this._devSort ??= lsGet(LS.devSort, null) || { key: null, dir: 1 };
    const TYPE = { Coordinator: 0, Router: 1, EndDevice: 2, Unknown: 3 };
    const age = n => n.type === 'Coordinator' || !n.lastSeen ? Infinity : Date.now() - n.lastSeen;
    const cmpBy = (key, a, b) => key === 'name' ? a.n.name.localeCompare(b.n.name)
      : key === 'type' ? (TYPE[a.n.type] ?? 9) - (TYPE[b.n.type] ?? 9)
      : key === 'seen' ? age(a.n) - age(b.n)
      : key === 'lqi' ? ((b.lo ?? -2) - (a.lo ?? -2)) || ((b.hi ?? -2) - (a.hi ?? -2)) : 0;
    const sortRows = (rows, dflt) => { const key = st.key && (st.key !== 'lqi' || rows.some(r => r.lo !== undefined)) ? st.key : dflt, dir = st.key === key ? st.dir : 1;
      return rows.sort((a, b) => (cmpBy(key, a, b) * dir) || cmpBy('type', a, b) || cmpBy('name', a, b)); };
    const th = (label, key) => !key ? `<th>${label}</th>` : `<th data-sort="${key}" class="${st.key === key ? 'sorted' : ''}" title="sort by ${key === 'seen' ? 'last seen' : key}; click again to reverse">${label}${st.key === key ? (st.dir > 0 ? ' ▾' : ' ▴') : ''}</th>`;
    let html;
    if (sel) {
      const lq = v => v == null ? '–' : v, multi = this.sel.size > 1, short = n => n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name;
      // neighbours of every selected node, merged: one row per device; with several selected, the best link and its partner
      const nb = new Map();
      for (const s of this.sel) for (const l of this.data.links) {
        const other = l.s === s ? l.t : l.t === s ? l.s : null; if (!other || this.sel.has(other)) continue;
        const hear = l.s === s ? l.lqS : l.lqT, heard = l.s === s ? l.lqT : l.lqS, min = l.min || 0;
        const e = nb.get(other);
        const v = [hear, heard].map(x => x ?? -1), lo = Math.min(...v), hi = Math.max(...v);
        if (!e || min > e.best) nb.set(other, { n: other, best: min, lo, hi, cell: `${lq(hear)} / ${lq(heard)}${multi ? ` <span class="muted">${esc(short(s))}</span>` : ''}` });
      }
      const rows = sortRows([...nb.values()], 'lqi'), selRows = sortRows([...this.sel].map(n => ({ n })), 'name');
      html = `<table><tr class="head">${th(`selected (${this.sel.size})`, 'name')}<th>links</th>${th('type', 'type')}<th></th>${th('last seen', 'seen')}</tr>` +
        selRows.map(x => row(x.n, '<td></td>')).join('') +
        `<tr class="head sub">${th(`neighbours (${rows.length})`, 'name')}<th>links</th>${th('type', 'type')}${th(`LQI hears / is heard${multi ? ' · partner' : ''}`, 'lqi')}${th('last seen', 'seen')}</tr>` +
        rows.map(x => row(x.n, `<td class="lq">${x.cell}</td>`)).join('') + '</table>';
    } else {
      const list = sortRows(this.data.nodes.filter(n => !terms.length || this.nameMatches(n, terms)).map(n => ({ n })), 'type');
      html = `<table><tr class="head">${th(`device (${list.length})`, 'name')}<th>links</th>${th('type', 'type')}${th('last seen', 'seen')}</tr>` + list.map(x => row(x.n)).join('') + '</table>';
    }
    if (!z2m) html += '<div class="muted">Zigbee2MQTT links: enter the frontend URL in the integration\'s options (⚙ top right)</div>';
    box.innerHTML = html; this.placeMenu(this.$('devs'));
    for (const h of box.querySelectorAll('th[data-sort]')) h.onclick = e => { e.stopPropagation(); const k = h.dataset.sort; this._devSort = st.key === k ? { key: k, dir: -st.dir } : { key: k, dir: 1 }; lsSet(LS.devSort, this._devSort); this.fillDevices(); };
    for (const td of box.querySelectorAll('td.name')) td.onclick = e => { const n = this.data.byId[td.parentElement.dataset.id]; if (n) this.clickSelect(n, e); };
    this.wireLinks(box, () => { this.$('devs').open = false; });
  }
  nodeTipHtml(d) {
    return `<div class="title">${esc(d.name)}</div>` + esc(`${d.removed ? 'removed from Zigbee2MQTT after this scan\n' : d.joinedUnscanned ? 'joined after this scan: pull a map to see its links\n' : ''}${d.type}${d.vendor ? ` · ${d.vendor} ${d.model}` : ''}${d.desc ? `\n${d.desc}` : ''}\nIEEE ${d.id}${d.nwk != null ? `  nwk ${d.nwk}` : ''}${d.lastSeen ? `\n${d.type === 'Coordinator' ? 'Zigbee2MQTT running since' : 'last seen'} ${new Date(d.lastSeen).toLocaleString()}` : ''}\nlinks: ${this.data.links.filter(l => l.s === d || l.t === d).length}`) + this.ghostHtml(d) + this.pathHomeHtml(d);
  }
  // a node that is in somebody's neighbour table but not in Zigbee2MQTT's device list: a device that left or was removed;
  // the entries stay until the routers holding them rebuild their tables (Tuya devices keep the parent they joined through for good)
  ghostHtml(d) {
    if (d.type !== 'Unknown') return '';
    const holders = this.data.links.filter(l => l.s === d || l.t === d).map(l => { const o = l.s === d ? l.t : l.s, lq = l.s === d ? l.lqT : l.lqS, rel = l.s === d ? l.relT : l.relS; return `${esc(o.name)} (${lq ?? '–'}${rel === 0 ? ', as its parent' : rel === 1 ? ', as its child' : ''})`; });
    return `<div class="path"><span class="muted">not in the device list: a removed device that is still in the neighbour table of</span> ${holders.join(', ')}<br><span class="muted">LQI 0 = nobody hears it. The entries go away when those routers rebuild their tables, usually after a power cycle</span></div>`;
  }
  pathHomeHtml(d) {
    if (d.type !== 'Router') return '';
    const p = this.pathHome(d);
    if (!p) return !this._hasRoutes ? '' : d.failed?.includes('routingTable') ? '<div class="muted">routing table not available: the device does not answer the request (Tuya modules)</div>' : '<div class="muted">no active route to the coordinator in its table</div>';
    let cur = d; const names = [esc(d.name)]; for (const l of p) { cur = l.s === cur ? l.t : l.s; names.push(esc(cur.name)); }
    return `<div class="path"><span class="muted">path to coordinator</span> ${names.join(' → ')}</div>`;
  }
  // HA / Z2M links for one device, as used in the devices list and on a pinned card
  devLinks(n) {
    const z2m = this.z2mUrl, reg = this._reg || {};
    // Z2M 2.x route: #/device/<source index>/<ieee>, source 0 = the first (only) instance. On a fresh load the frontend
    // honours exactly this form; with a tab suffix (/info) it falls back to the device list
    const z = !z2m || n.type === 'Unknown' ? '' : z2m.startsWith('/')
      ? `<a href="${esc(z2m)}" data-side="${esc(n.id)}" title="open the device in the Zigbee2MQTT add-on, here over the map">Z2M</a>`
      : `<a href="${esc(z2m)}/#/device/0/${encodeURIComponent(n.id)}" data-side="${esc(n.id)}" target="_blank" rel="noopener" title="open the device in the Zigbee2MQTT frontend, here over the map (Ctrl-click: new tab)">Z2M</a>`;
    return z + (reg[n.id] ? `<a href="/config/devices/device/${reg[n.id]}" data-nav title="open the device page in Home Assistant">HA</a>` : '');
  }
  // "permit join here": open the network through this router (or the coordinator); while open that way, the countdown and a stop
  // join state, as the radios see it: Zigbee2MQTT keeps ONE timer (the latest request), but a request through a router is a
  // single unicast to that router and closes nothing elsewhere, so routers opened one after another are all open, each with
  // its own 254 s; a close (time 0) is always a broadcast. The integration remembers what it was asked (broadcast end, one end
  // per router), so every panel shows the same; a join opened elsewhere (the Zigbee2MQTT frontend) shows without a router.
  joinLink(n) {
    if (n.isEnd || n.type === 'Unknown' || n.removed) return '';
    const J = this._join, now = Date.now(), via = Object.keys(J.via).filter(id => J.via[id] > now);
    const stop = `<a data-join="stop" title="close the network everywhere (Zigbee2MQTT closes with a broadcast)">stop</a>`;
    if (J.all > now) return `<span class="muted">join open everywhere · ${mmss(J.all - now)}</span>${stop}`;
    if (J.via[n.id] > now) return `<span class="muted">joining here · ${mmss(J.via[n.id] - now)}</span>${stop}`;
    if (!this._joinEnd) return `<a data-join="${esc(n.id)}" title="let new devices join through this ${n.type === 'Coordinator' ? 'coordinator' : 'router'} for 254 s (administrators only)">permit join here</a>`;
    const names = via.map(id => this.data?.byId[id]?.name ?? id).join(', ');
    return `<span class="muted">join open${names ? ` via ${esc(names)}` : ''} · ${mmss(this._joinEnd - now)}</span><a data-join="${esc(n.id)}" title="open this ${n.type === 'Coordinator' ? 'coordinator' : 'router'} too, for 254 s; the others stay open for their own remaining time">also here</a>${stop}`;
  }
  wireLinks(box, before = () => {}) {
    for (const a of box.querySelectorAll('a[data-nav]')) a.onclick = e => { e.preventDefault(); before(); this.navTo(a.getAttribute('href')); };
    for (const a of box.querySelectorAll('a[data-join]')) a.onclick = e => { e.preventDefault(); a.dataset.join === 'stop' ? this.permitJoin(0) : this.permitJoin(JOIN_SECONDS, a.dataset.join); };
    for (const a of box.querySelectorAll('a[data-side]')) a.onclick = e => { if (a.target === '_blank' && (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1)) return; e.preventDefault(); before(); this.openZ2m(this.data.byId[a.dataset.side], a.getAttribute('href')); };
  }
  // click / tap on a node: its card stays until clicked, Esc, a click on the background or another node; it carries the links
  pinTip(d, e) {
    const fill = () => { const n = this._pinned; if (!n) return;   // re-pointed by a map event when the node is renamed
      this.showTip(e, this.nodeTipHtml(n) + `<div class="tiplinks">${this.devLinks(n) || '<span class="muted">no links (set the Zigbee2MQTT URL in the options, ⚙)</span>'}</div>${this.joinLink(n) ? `<div class="tiplinks tipjoin">${this.joinLink(n)}</div>` : ''}<div class="tiphint">click to close</div>`, true);
      this.tip.classed('pinned', true); this.wireLinks(this.tip.node()); };
    this._pinned = d; this._refill = fill; fill();
    if (!this._reg) this.loadRegistry().then(() => { if (this._pinned?.id === d.id) fill(); });
  }
  showTip(e, text, html = false) { const t = this.tip.style('display', 'block').classed('touch', this._lastPtr === 'touch'); if (html) t.html(text); else t.text(text); this.moveTip(e); }
  // tooltip next to the pointer, flipped to the other side when it would leave the canvas, and never outside it (phones)
  moveTip(e) {
    const c = this.$('canvas').getBoundingClientRect(), t = this.tip.node(), w = t.offsetWidth, h = t.offsetHeight, m = 4;
    const x = e.clientX - c.left, y = e.clientY - c.top;
    let left = x + 14; if (left + w > c.width - m) left = x - 14 - w; left = Math.max(m, Math.min(left, c.width - w - m));
    let top = y + 14; if (top + h > c.height - m) top = y - 14 - h; top = Math.max(m, Math.min(top, c.height - h - m));
    this.tip.style('left', left + 'px').style('top', top + 'px');
  }
  hideTip() { this._pinned = null; this._refill = null; this.tip.classed('pinned', false).style('display', 'none'); }
  savePng() {
    const svgEl = this.svg.node(), c = this.$('canvas'), w = c.clientWidth, h = c.clientHeight;
    const cs = getComputedStyle(this), bg = cs.getPropertyValue('--primary-background-color').trim() || '#1c2027';
    const vars = ['--red', '--orange', '--green', '--blue', '--yellow', '--bgc', '--muted', '--primary-text-color'].map(v => `${v}:${cs.getPropertyValue(v).trim()}`).join(';');
    let xml = new XMLSerializer().serializeToString(svgEl).replace(/<image\b[^>]*\/>|<image\b[^>]*>.*?<\/image>/gs, '');   // remote images would taint the canvas
    const css = STYLE.replace(/:host\s*{[^}]*}/, '').replace(/#\w+\s*{[^}]*}/g, '');
    // the serializer adds xmlns itself in current browsers; a second one makes the XML invalid and the image never loads
    xml = xml.replace('<svg', `<svg${/<svg[^>]*\sxmlns=/.test(xml) ? '' : ' xmlns="http://www.w3.org/2000/svg"'} width="${w}" height="${h}" style="${vars};background:${bg};font:13px system-ui,sans-serif"`).replace('>', `><style>${css}</style>`);
    const img = new Image(), cv = document.createElement('canvas'); cv.width = w * 2; cv.height = h * 2;
    img.onload = () => { const ctx = cv.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height); ctx.scale(2, 2); ctx.drawImage(img, 0, 0); const a = document.createElement('a'); a.download = `zigbee_map_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`; a.href = cv.toDataURL('image/png'); a.click(); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  }
}
// HACS also loads this file as a dashboard resource under another URL; HA is a single-page app, so the element may already exist
if (!customElements.get('zigbee-map-panel')) customElements.define('zigbee-map-panel', ZigbeeMapPanel);
