#!/usr/bin/env bash
# Sets the integration version in the three places that must agree: manifest.json, const.py, the panel's VERSION.
#   tools/bump_version.sh 2.0.1
set -euo pipefail
cd "$(dirname "$0")/.."
v=${1:?version, e.g. 2.0.1}
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a plain x.y.z version: $v" >&2; exit 2; }
d=custom_components/zigbee2mqtt_map
sed -i -E "s/\"version\": \"[0-9.]+\"/\"version\": \"$v\"/" $d/manifest.json
sed -i -E "s/^VERSION = \"[0-9.]+\"/VERSION = \"$v\"/" $d/const.py
sed -i -E "s/^const VERSION = '[0-9.]+';/const VERSION = '$v';/" $d/frontend/zigbee2mqtt-map-panel.js
grep -H "\"version\"" $d/manifest.json; grep -H "^VERSION" $d/const.py; grep -H "^const VERSION" $d/frontend/zigbee2mqtt-map-panel.js
echo "now: git commit -am \"v$v: ...\" && git push, wait for the workflows, then: gh release create v$v --generate-notes --title v$v"
