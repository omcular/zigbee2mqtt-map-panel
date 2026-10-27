#!/usr/bin/env bash
# Public release of the Zigbee2MQTT map integration, step by step with confirmations:
#   tools/release_map.sh 2.0.1 ["commit subject"]
#   tools/release_map.sh -n 2.0.1      dry run: shows what would happen, changes nothing
#   tools/release_map.sh -y 2.0.1      no questions (still stops on red workflows)
# Steps: bump the three version strings -> run the tests -> commit -> push -> wait for the GitHub workflows -> create
# the GitHub release (tag vX.Y.Z, generated notes). Local tests need PYTEST_PYTHON=<venv>/bin/python with
# pytest-homeassistant-custom-component and home-assistant-frontend installed; without it the GitHub workflow is the gate. HACS picks the release up on its next refresh ("Update information"
# in HACS shows it at once); users then see it under Settings -> Updates.
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=0; YES=0
while [[ ${1:-} == -* ]]; do case $1 in -n|--dry-run) DRY=1;; -y|--yes) YES=1;; -h|--help) sed -n '2,8p' "$0"; exit 0;; *) echo "unknown option $1" >&2; exit 2;; esac; shift; done
v=${1:?version, e.g. 2.0.1}; subject=${2:-}
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a plain x.y.z version: $v" >&2; exit 2; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run() { if [ $DRY = 1 ]; then printf '  (dry) %s\n' "$*"; else "$@"; fi; }
confirm() { [ $YES = 1 ] && return 0; local a; read -r -p "$1 [y/N] " a; [[ $a == [yY]* ]]; }
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
git fetch -q --tags origin   # releases made with gh create their tags on GitHub only
branch=$(git rev-parse --abbrev-ref HEAD); [ "$branch" = main ] || { echo "on branch $branch, releases come from main" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$v" >/dev/null && { echo "tag v$v exists already" >&2; exit 1; }

say "what goes into v$v"
last=$(git describe --tags --abbrev=0 2>/dev/null || true)
if [ -n "$last" ]; then git log --oneline "$last"..HEAD | sed 's/^/  /'; else echo "  (no previous tag)"; fi
dirty=$(git status --short --untracked-files=no); [ -n "$dirty" ] && { echo "  uncommitted changes to tracked files, they become part of the release commit:"; echo "$dirty" | sed 's/^/    /'; }
untracked=$(git ls-files --others --exclude-standard); [ -n "$untracked" ] && { echo "  untracked files, NOT included (git add them first if they belong in):"; echo "$untracked" | sed 's/^/    /'; }
confirm "continue with v$v?" || exit 1

say "version strings"
if [ $DRY = 1 ]; then echo "  (dry) tools/bump_version.sh $v"; else tools/bump_version.sh "$v" | grep -v '^now:'; fi

say "tests"
PY=${PYTEST_PYTHON:-python3}
if "$PY" -c "import pytest_homeassistant_custom_component" 2>/dev/null; then
  "$PY" -m pytest -q -p no:cacheprovider || { echo "tests failed, nothing committed (fix, then run again)" >&2; exit 1; }
else
  echo "  pytest-homeassistant-custom-component not importable with $PY (set PYTEST_PYTHON=/path/to/venv/bin/python);"
  echo "  the Tests workflow on GitHub still runs them before the release is created"
  confirm "continue without local tests?" || exit 1
fi

say "commit"
[ -n "$subject" ] || subject="v$v"
run git add -u
[ $DRY = 1 ] || git diff --cached --stat | sed 's/^/  /'
confirm "commit as \"$subject\"?" || exit 1
run git commit -q -m "$subject"; [ $DRY = 1 ] || echo "  $(git log --oneline -1)"

say "push"
confirm "git push to $repo?" || exit 1
run git push -q origin main
sha=$(git rev-parse HEAD)

say "workflows for $sha"
url="https://github.com/$repo/actions"
echo "  $url"
if [ $DRY = 1 ]; then echo "  (dry) would wait for the runs of this commit to finish"; else
  for i in $(seq 1 120); do   # up to 20 min
    runs=$(gh run list --commit "$sha" --json name,status,conclusion -q '.[] | "\(.name)\t\(.status)\t\(.conclusion // "")"' 2>/dev/null || true)
    total=$(printf '%s\n' "$runs" | grep -c . || true)
    done_=$(printf '%s\n' "$runs" | grep -c $'\tcompleted\t' || true)
    if [ "$total" -ge 3 ] && [ "$done_" = "$total" ]; then break; fi
    printf '\r  waiting… %s of %s runs finished (%ds)' "$done_" "$total" $((i*10)); sleep 10
  done; echo
  printf '%s\n' "$runs" | sed 's/^/  /'
  if printf '%s\n' "$runs" | grep -qv $'\tcompleted\tsuccess$'; then
    echo "  not all green: $url" >&2; echo "  fix, commit, push, then create the release by hand: gh release create v$v --generate-notes --title v$v" >&2; exit 1
  fi
  echo "  all green"
fi

say "release v$v"
confirm "create the GitHub release v$v (tag + generated notes)?" || exit 1
run gh release create "v$v" --generate-notes --title "v$v"
[ $DRY = 1 ] || echo "  https://github.com/$repo/releases/tag/v$v"
echo "  HACS shows it after its next refresh; 'Update information' on the repository page fetches it now."
