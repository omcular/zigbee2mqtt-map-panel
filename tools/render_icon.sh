#!/usr/bin/env bash
# Renders brand/icon.svg to the PNG sizes HACS (repo root brand/) and Home Assistant (custom_components/<domain>/brand/,
# served at /api/brands/integration/zigbee2mqtt_map/ since HA 2026.3) want: 256 and 512 px, plus the 128 px docs copy.
set -euo pipefail
cd "$(dirname "$0")/.."
svg=$PWD/brand/icon.svg
render() {  # size, output
  local html; html=$(mktemp --suffix=.html)
  printf '<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>%s</body></html>' \
    "$(sed -E "s/width=\"128\" height=\"128\"/width=\"$1\" height=\"$1\"/" "$svg")" > "$html"
  chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 \
    --window-size="$1,$1" --screenshot="$2" "file://$html" >/dev/null 2>&1
  rm -f "$html"
}
render 256 brand/icon.png; cp brand/icon.png brand/logo.png
render 512 brand/icon@2x.png; cp brand/icon@2x.png brand/logo@2x.png
render 128 docs/icon.png
cp brand/icon.png brand/icon@2x.png brand/logo.png brand/logo@2x.png custom_components/zigbee2mqtt_map/brand/
ls -la brand/*.png custom_components/zigbee2mqtt_map/brand/*.png docs/icon.png
