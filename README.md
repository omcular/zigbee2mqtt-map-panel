# Zigbee2MQTT map

> DRAFT written by the maintainer's assistant. Rewrite in your own words before publishing; keep the facts.

[![release](https://img.shields.io/github/v/release/omcular/zigbee2mqtt-map-panel?label=release)](https://github.com/omcular/zigbee2mqtt-map-panel/releases)
[![HACS](https://img.shields.io/badge/HACS-custom-orange)](https://hacs.xyz)
[![validate](https://github.com/omcular/zigbee2mqtt-map-panel/actions/workflows/validate.yml/badge.svg)](https://github.com/omcular/zigbee2mqtt-map-panel/actions/workflows/validate.yml)
[![tests](https://github.com/omcular/zigbee2mqtt-map-panel/actions/workflows/tests.yml/badge.svg)](https://github.com/omcular/zigbee2mqtt-map-panel/actions/workflows/tests.yml)
[![licence](https://img.shields.io/github/license/omcular/zigbee2mqtt-map-panel)](LICENSE)

A Home Assistant integration that puts your Zigbee2MQTT network map in the sidebar, as a force graph you can actually
work with: nodes stay where you pin them, links are coloured by the weaker of their two LQI directions, and two numbers
tell you at a glance how strong the router mesh is. Installed from HACS, set up from the UI, no YAML.

![screenshot](docs/screenshot.png)

## What it does

- **Pinnable layout** — drag nodes apart, double-click to pin, and the arrangement survives scans and reloads (kept in
  the browser). Ctrl-drag rotates the whole map.
- **Weaker-direction colouring** — every router link has two LQI readings (what each side hears). The colour and the
  "Min LQI" filter use the weaker one, so a link that looks fine from one end but not the other shows as what it is.
- **Mesh numbers** — *connected ≥ C*: the highest LQI at which every router still reaches the coordinator; *redundant
  ≥ R*: the highest LQI at which no single router is a point of failure. Hover to see which link or router limits
  each number, click to set the filter there. The integration computes them after every scan, so the panel and the
  two sensors below always show the same values.
- **Last map, always** — the integration asks Zigbee2MQTT for the map on a schedule and keeps the answer, so the panel
  opens with the latest scan on any device, and a scan that finishes after you close the page is not lost.
- **Scan while viewing** — while the panel is open it can re-scan at a second, shorter interval; nothing happens when
  nobody is looking. Several open panels share one schedule.
- **Entities** — the scan intervals, a "Scan now" button, a "Last scan" timestamp sensor (with router, end-device
  and link counts) and three mesh sensors, "Mesh connected at LQI", "Mesh redundant at LQI" and "Mesh routers ignored", belong to a
  device "Zigbee2MQTT map". The mesh sensors get a value with every scan, so their history is the health of your mesh
  over time. "Mesh routers ignored" counts the routers that had no two-sided link in the scan, so a router that went
  dark shows there (the other two are computed over the routers still in the mesh); it reads 0 when all is well, which
  makes it the one to alert on. Their attributes name what limits each number (the bottleneck link,
  the single point of failure, the routers that would be cut off, the routers ignored for having no two-sided link).
  A history graph of both, for a dashboard:

  ```yaml
  type: history-graph
  hours_to_show: 168
  entities:
    - sensor.zigbee2mqtt_map_mesh_connected_at_lqi
    - sensor.zigbee2mqtt_map_mesh_redundant_at_lqi
    - sensor.zigbee2mqtt_map_mesh_routers_ignored
  ```
- **Pairing from the map** — a "permit join" button opens the network for 254 s with a countdown (click again to
  close), a router's card offers "permit join here" to join through that router, and a feed next to the scan status
  follows the newcomer: joined → interviewing → paired. The device appears on the map at once, parked at the edge
  until the next scan shows its links. Administrators only.
- **Follows Zigbee2MQTT's device list** — a rename shows at once, a removed device turns grey with its links until
  the next scan, no scan needed for either.
- **Device pictures** from zigbee2mqtt.io (optional), stale-device rings (not seen for 24 h), one-sided links on
  request, routes on request, label search, PNG export.

Everything stays local: the integration talks to Zigbee2MQTT over your MQTT broker, the panel talks to the integration
over Home Assistant's websocket. The only thing that leaves your network is the optional device pictures.

## Requirements

- Home Assistant 2025.1 or newer with the **MQTT integration** connected to the broker Zigbee2MQTT uses.
- Zigbee2MQTT 2.x (tested with 2.14 on an EmberZNet coordinator). Any adapter; the map comes from
  `bridge/request/networkmap`.
- [HACS](https://hacs.xyz).

## Install

Not in the HACS default store yet, so it is added as a custom repository. This button does that for you (it opens your
own Home Assistant through [My Home Assistant](https://my.home-assistant.io)):

[![Open your Home Assistant instance and open the repository inside HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=omcular&repository=zigbee2mqtt-map-panel&category=integration)

Or by hand: HACS → three-dot menu (top right) → **Custom repositories** → paste
`https://github.com/omcular/zigbee2mqtt-map-panel`, type **Integration**, Add.

Then, either way:

1. In HACS, open **Zigbee2MQTT map** and **Download**. Restart Home Assistant when HACS asks.
2. Add the integration:

   [![Open your Home Assistant instance and start setting up a new integration.](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=zigbee2mqtt_map)

   or Settings → Devices & services → **Add integration** → "Zigbee2MQTT map". The dialog shows the Zigbee2MQTT
   instances found on your broker and pre-fills the base topic; confirm it.
3. "Zigbee map" appears in the sidebar. Open it, press the **⤓** button (scan now, next to the status text), then set the two intervals in **options**
   (2 h background / 10 min while viewing is a sensible start). The **devices ▾** list links every device to its
   Home Assistant device page; for links into the Zigbee2MQTT frontend, enter its URL in the integration's options
   (Settings → Devices & services → Zigbee2MQTT map → Configure). A scan of a 25-router mesh takes about 75 s with
   Zigbee2MQTT's own sequential scan.

Without HACS: copy `custom_components/zigbee2mqtt_map/` from a [release](https://github.com/omcular/zigbee2mqtt-map-panel/releases)
into your `config/custom_components/` and restart.

The integration finds the base topic through the retained `<topic>/bridge/state` message Zigbee2MQTT publishes; only
an `online` one counts, stale `offline` states from old installs are ignored. With several instances, pick one in the
dialog. The base topic, the sidebar title and whether the panel is for administrators only can be changed later under
**Configure** on the integration's card.

## Update

HACS → Zigbee2MQTT map → Update, then restart Home Assistant. Browsers pick up the new panel on their own: the module
URL carries the file's hash. If HACS does not show the new version yet, three-dot menu → **Update information** and
reload the page.

## Faster scans (optional)

`networkmap_fast` is a Zigbee2MQTT external extension that scans two routers at a time, puts routers that did not
answer last, and reports progress. With it the same 25-router scan takes 16–22 s and the panel shows "n/m routers"
while it runs. It lives in the official
[zigbee2mqtt-user-extensions](https://github.com/Koenkk/zigbee2mqtt-user-extensions) collection:
[`unstable/networkmap_fast`](https://github.com/Koenkk/zigbee2mqtt-user-extensions/tree/main/unstable/networkmap_fast)
(the file and its README).
Load it in Zigbee2MQTT (Settings → Dev console → External extensions, needs `advanced.enable_external_js: true`); nothing
to change on the Home Assistant side, the extension answers the normal map request and the panel shows its progress.
Only if you turned the extension's takeover of the normal topic off (`replaceBuiltin: false`), enable the disabled-by-default
switch "Use the networkmap_fast topic" on the Zigbee2MQTT map device. Without the extension the panel works the same,
only slower.

## Reading the map

- A link is an entry in a router's **neighbour table**, not a live route. The tables hold about 16 entries and age in
  and out, so links come and go between scans; judge a path over several scans.
- End devices report nothing themselves; their single link is what the parent sees. They are hidden by default.
- *Dashed grey* = only one side reported the link (usually stale). *Red dashed ring* = not seen for more than 24 h.
- The help menu in the panel explains every control.

## Troubleshooting

- **"Zigbee2MQTT: no answer within 10 min"** — the base topic is wrong (Configure on the integration's card shows it),
  Zigbee2MQTT is not connected to the broker Home Assistant uses, or a scan never finishes (a router hanging in table
  paging; `networkmap_fast` has a breaker for that).
- **"scan request failed … administrators only"** — scans are limited to administrator accounts; the map itself is
  shown to everyone the panel is visible to.
- **"The MQTT integration is not set up"** in the dialog — add the MQTT integration first.
- **Nothing in the sidebar** — the panel appears when the integration is set up; check Settings → Devices & services
  for an error on the card and the Home Assistant log for `zigbee2mqtt_map`.

## Development

- Tests: `pip install pytest-homeassistant-custom-component home-assistant-frontend`, then `pytest` from the repo root.
- `tools/dev_deploy.sh`: copies the working copy to a Home Assistant host over SSH (`HA_HOST=root@homeassistant`)
  and restarts Core. Do not combine with a HACS download of the integration on that host, both write the same folder.
- `tools/release_map.sh 2.1.0`: version bump, CHANGELOG section, tests, commit, push, wait for the workflows, GitHub
  release with the integration zipped as the asset HACS downloads (hacs.json `zip_release`).
- `tools/render_icon.sh`: renders `brand/icon.svg` to the PNG sizes HACS and Home Assistant use.

## Credits

Graph layout by [D3.js](https://d3js.org) (ISC licence, shipped unmodified, see THIRD_PARTY.md). Device pictures by
[zigbee2mqtt.io](https://www.zigbee2mqtt.io).
