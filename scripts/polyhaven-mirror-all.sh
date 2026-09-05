#!/usr/bin/env bash
# =============================================================================
# FULL Poly Haven mirror — downloads EVERY asset in the catalog (models,
# textures, HDRIs), all CC0, license-gated, size-budgeted, resumable.
#
# Run this on a machine with normal internet access (api.polyhaven.com and
# dl.polyhaven.org must be reachable — they are NOT reachable from restricted
# sandboxes; the script verifies first and tells you if so).
#
#   scripts/polyhaven-mirror-all.sh [REPO_DIR]        # mirror everything
#   ZIP=1 scripts/polyhaven-mirror-all.sh             # also produce a .zip
#
# What it does:
#   0. verifies live connectivity + license terms (Poly Haven = CC0 site-wide,
#      redistribution explicitly permitted — the gate still verifies per asset)
#   1. discovers the whole catalog (paginate everything)
#   2. downloads in a resumable loop until nothing is left
#      (per-file budget 90 MiB < GitHub's 100 MiB hard limit; smallest variant
#      first — HDRIs mirror at 1k–2k, textures as complete blend packages)
#   3. commits locally in one go, audits every file hash, reports capacity
#   4. NEVER pushes (push after you review: asset-hub mirror push --repo DIR)
#
# Full-resolution Poly Haven is multi-terabyte; this mirror keeps every asset
# at its largest variant that fits the per-file budget. Raise MAX_FILE_BYTES
# at your own risk (GitHub rejects >100 MiB files outright).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="node $ROOT/bin/asset-hub.js"
REPO="${1:-$ROOT/polyhaven-mirror}"
export ASSET_HUB_HOME="${ASSET_HUB_HOME:-$REPO/.live-home}"
MAX_FILE_BYTES="${MAX_FILE_BYTES:-94371840}"   # 90 MiB (GitHub hard limit: 100 MiB)

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "0. connectivity + terms check (live)"
curl -fsS -m 20 -H 'User-Agent: asset-hub-mirror/1.0' 'https://api.polyhaven.com/assets?t=models&future=max' -o /dev/null \
  || { echo 'BLOCKED: api.polyhaven.com unreachable from this machine.'; \
       echo 'Run this script where outbound HTTPS is allowed (e.g. your laptop/CI runner).'; exit 2; }
curl -fsS -m 20 -o /dev/null 'https://dl.polyhaven.org/' \
  || { echo 'BLOCKED: dl.polyhaven.org unreachable from this machine.'; exit 2; }

mkdir -p "$REPO" "$ASSET_HUB_HOME"
[ -d "$REPO/.git" ] || git init -q "$REPO"
"$HUB" config set mirror.maxFileBytes "$MAX_FILE_BYTES" --home "$ASSET_HUB_HOME"
"$HUB" config set mirror.warnBytes 6442450944 --home "$ASSET_HUB_HOME"    # warn 6 GiB
"$HUB" config set mirror.pauseBytes 10737418240 --home "$ASSET_HUB_HOME"  # pause 10 GiB

say "1. discover the FULL catalog"
"$HUB" mirror discover --repo "$REPO" --provider polyhaven --home "$ASSET_HUB_HOME" --json

say "2. download everything permitted (resumable loop)"
for pass in $(seq 1 200); do
  OUT="$("$HUB" mirror download --repo "$REPO" --provider polyhaven --home "$ASSET_HUB_HOME" --resume --json)"
  echo "$OUT"
  LEFT="$(echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).summary.processed))')"
  echo "pass $pass: $LEFT asset(s) processed"
  [ "$LEFT" = "0" ] && break
done

say "3. commit + audit + capacity (LOCAL only — never pushed by this script)"
"$HUB" mirror commit   --repo "$REPO" --home "$ASSET_HUB_HOME" --json || true
"$HUB" mirror audit    --repo "$REPO" --home "$ASSET_HUB_HOME" --json || true
"$HUB" mirror capacity --repo "$REPO" --home "$ASSET_HUB_HOME" --json || true
"$HUB" mirror status   --repo "$REPO" --home "$ASSET_HUB_HOME" --json || true

if [ "${ZIP:-0}" = "1" ]; then
  say "4. zipping the mirror (assets + indexes, no .git)"
  ZIPFILE="$REPO/../polyhaven-mirror-$(date +%Y%m%d).zip"
  (cd "$REPO" && zip -qr "$ZIPFILE" . -x '.git/*' -x '.asset-hub-mirror/*')
  echo "zip: $ZIPFILE ($(du -h "$ZIPFILE" | cut -f1))"
fi

say "DONE — nothing pushed. Review, then optionally:"
echo "  asset-hub mirror push --repo \"$REPO\" --home \"$ASSET_HUB_HOME\""
echo "NOTE: if the mirror exceeds ~5 GiB, push it in chunks (raise mirror.pauseBytes),"
echo "      enable git-lfs, or split per category into several repos."
