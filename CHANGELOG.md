# Changelog

The "Unreleased" section collects changes since the last release; `tools/release_map.sh` turns it into the version's
section and uses it as the GitHub release notes.

## Unreleased

- Map: clicking or tapping a node also opens its card, which stays until clicked (or Esc, background, another node)
  and carries the device's "Z2M" and "HA" links; it stays while the Z2M drawer is open. Clicking the selected node
  again brings a closed card back.
- Toolbar: Min LQI is now the LQI colour bar itself (value on hover): a marker shows the setting, press or drag on the bar to change it
  (mouse and touch). The bottom legend box is gone; its notes are in the help.
- Options: "smooth link colours" removed; link colour always runs continuously from red through orange to green.
- Fresh install: the integration scans by itself about 20 s after setup, and the panel asks for a scan the moment it
  learns there has never been one, so a new user sees a map without pressing anything.
- "reset to defaults" with Shift held also forgets the cached map (exactly a first visit in this browser).
- Options are grouped under Show, Layout, Scans and Panel.
- Layout: the scan button and status line moved to a footer bar; option *controls at the bottom* swaps the two bars
  (status on top, controls within thumb reach on a phone; menus then open upwards).
- Devices not in Zigbee2MQTT's device list get no Z2M link (Zigbee2MQTT has no page for them).
- Toolbar: "pull fresh map" is now a download icon button right before the status text.
- Status line: "scanned 33m ago" / "scanned 2d ago" instead of the date and time; the exact time on hover.
- Min LQI starts at the mesh's "redundant" threshold (shown as *auto*) until you move the slider, so a first look
  shows the mesh instead of every marginal link. "reset to defaults" brings the automatic value back.
- Devices list: sortable by name, type, LQI (weaker direction first, then the stronger) and last seen.
- Help: each entry as a small heading with its explanation indented below (was a two-column table).
- Dropdowns stay inside the panel: shifted left when they would stick out, narrower and wrapping on a phone.
- Node and link tooltips stay inside the map area: flipped to the other side of the pointer near an edge, never cut off
  on a phone. On touch, a tap on an open tooltip closes it instead of reaching the map below.
- Two-finger twist rotates the map on touch screens (with a small dead zone, so a pinch does not wobble).
- Cursors: a hand on nodes (they are clicked more than dragged), no question mark on links.
- A click on the map while a dropdown is open only closes the dropdown (no deselect, drag or pan).
- Keys: Esc closes the Zigbee2MQTT drawer, else an open dropdown, else clears the selection; Ctrl-A selects every node
  on the map (again: none), Ctrl-Shift-A clears the selection (not while typing in a field).
- Layout: nodes are pushed off links they do not belong to, and those links bend away (options: *keep nodes off
  links*, 0 turns it off).
- README: `networkmap_fast` is merged into zigbee2mqtt-user-extensions, link to it there.
- Panel: **devices ▾** dropdown in the toolbar. With a node selected it lists that device and its neighbours with
  both LQI directions, otherwise every device (the "find" text filters it). Click a name to select it on the map;
  "HA" opens the device page in Home Assistant, "Z2M" the device in the Zigbee2MQTT frontend, in a drawer over the
  map (Ctrl-click for a new tab).
- Options: *Zigbee2MQTT frontend URL* (optional) for those Z2M links: the add-on's sidebar path (opened through the
  add-on's ingress, administrators only, nothing to expose) or the frontend's own URL.
- Panel: multi-select with Ctrl/Shift-click, on the map and in the devices list; the list shows one block per selected
  device. A few pixels of jitter during a click no longer count as a drag (a Shift-click used to pin the node).
- Panel: ⚙ top right opens the integration's page in Home Assistant (options, entities, reload).
- Panel: the selected node survives leaving and re-entering the panel (device page and back).
- Panel banner says whether a page reload or a Home Assistant restart is needed (files updated without a restart
  showed a permanent "reload" banner before).
- `tools/release_map.sh` waits for one workflow run per workflow file (it hung waiting for a third run).

## 2.0.1 – 2026-10-27

- Panel: banner with a reload button when the server has newer panel code than the page runs.
- README: My Home Assistant buttons for the HACS repository and the config flow; development section.
- GitHub issue templates (bug report, feature request).
- Tools: `release_map.sh` (release step by step with confirmations and a workflow gate), `bump_version.sh`,
  `dev_deploy.sh` (copy the working copy to a Home Assistant host); test that the three version strings agree.
- Brand icons inside the integration (Home Assistant 2026.3+ serves them itself).

## 2.0.0 – 2026-10-27

- Rewritten as a **custom integration** (`zigbee2mqtt_map`): config flow that finds the Zigbee2MQTT base topic on
  the broker, sidebar panel registered by the integration, scan scheduling and the last map held by the integration
  (number, switch, button and sensor entities instead of YAML helpers and automations). Nothing to paste into
  `configuration.yaml`; HACS category changed from dashboard plugin to integration.

## 1.1.0 – 2026-10-27

- The YAML package learns the Zigbee2MQTT base topic from the retained `bridge/state` message; nothing left to edit.
- README: clearer install steps; link to the `networkmap_fast` pull request and its branch.

## 1.0.0 – 2026-10-27

- First release as a HACS dashboard plugin plus a YAML package: pinnable d3 map, both LQI directions per link,
  weaker-direction colouring, hide slider, connected/redundant mesh thresholds, retained last map, background and
  while-viewing scans, progress with the `networkmap_fast` extension.
