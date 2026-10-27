#!/usr/bin/env bash
# Copies this working copy of the integration to a Home Assistant host over SSH and restarts Core: the dev loop.
#   HA_HOST=root@homeassistant tools/dev_deploy.sh            copy, then `ha core restart` (needs the SSH add-on's `ha` CLI)
#   tools/dev_deploy.sh -n                                    dry run: show what would change
#   tools/dev_deploy.sh --no-restart                          copy only (a wrapper restarts; HA still needs a restart for Python changes)
#   tools/dev_deploy.sh --backup-dir /config/release_backup/x keep replaced files there (rsync --backup)
# Prints one line per changed file on stdout (nothing when nothing changed), everything else on stderr, so a wrapper can
# use the output to decide whether a restart is needed. rsync on the host gives change detection and backups
# (`apk add rsync` in the SSH add-on); without it scp copies everything.
# Do not combine with a HACS download of the same integration on that host: both write /config/custom_components/zigbee2mqtt_map.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${HA_HOST:-root@homeassistant}; DRY=0; RESTART=1; BACKUP=
while [ $# -gt 0 ]; do case $1 in
  -n|--dry-run) DRY=1;; --no-restart) RESTART=0;; --backup-dir) BACKUP=$2; shift;;
  -h|--help) sed -n '2,10p' "$0"; exit 0;; *) echo "unknown option $1" >&2; exit 2;; esac; shift; done
SRC=custom_components/zigbee2mqtt_map; DST=/config/custom_components/zigbee2mqtt_map
SSH="ssh -o BatchMode=yes -o ConnectTimeout=8 -o ForwardX11=no $HOST"
$SSH 'test -d /config' 2>/dev/null || { echo "cannot reach $HOST or no /config there (HA_HOST=user@host, SSH key needed)" >&2; exit 1; }
if $SSH 'command -v rsync >/dev/null' 2>/dev/null; then
  opts=(-rlptci --delete --exclude '__pycache__' --exclude '.*' --out-format='  %i %n')
  [ -n "$BACKUP" ] && opts+=(--backup --backup-dir="$BACKUP")
  [ $DRY = 1 ] && opts+=(-n)
  $SSH 'mkdir -p /config/custom_components' 2>/dev/null
  rsync "${opts[@]}" "$SRC/" "$HOST:$DST/"
else
  echo "no rsync on $HOST: scp copies everything, no change detection ('apk add rsync' there)" >&2
  if [ $DRY = 1 ]; then echo "  would copy $SRC -> $HOST:$DST"; else $SSH "mkdir -p $DST" && scp -qr "$SRC"/. "$HOST:$DST/" && echo "  copied $SRC"; fi
fi
if [ $RESTART = 1 ] && [ $DRY = 0 ]; then
  if $SSH 'command -v ha >/dev/null' 2>/dev/null; then
    echo "restarting Home Assistant Core on $HOST" >&2; $SSH 'ha core restart' >&2
    echo "done; reload the browser tab when the panel shows its update banner" >&2
  else
    echo "no 'ha' CLI on $HOST: restart Home Assistant yourself" >&2
  fi
fi
