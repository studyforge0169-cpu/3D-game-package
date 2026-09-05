#!/usr/bin/env bash
# =============================================================================
# Poly Haven LIVE integration test for `asset-hub mirror` (steps 2–13 of the
# test plan). Runs against the REAL https://api.polyhaven.com / dl.polyhaven.org.
#
#   - discovers the real catalog (metadata only)
#   - curates a small CC0 batch (12 assets: 8 models, 2 textures, 2 HDRIs)
#   - downloads ONLY redistribution-permitted assets (Poly Haven is CC0,
#     verified per-asset against official API data)
#   - sha256/md5-verifies every file (multi-file gltf/mtlx packages included)
#   - writes asset.json + attribution metadata, audits, commits LOCALLY
#   - exercises library search + import into temp Godot/Unity/Unreal projects
#   - prints the exact proposed commit contents, sizes and licenses
#
# It NEVER pushes. Push happens only after explicit human approval:
#   asset-hub mirror push --repo "$MIRROR_REPO"
#
# Usage:
#   scripts/polyhaven-live-test.sh [MIRROR_REPO_DIR]
# Env:   ASSET_HUB_HOME (data dir, default ./polyhaven-mirror-test/.live-home)
#        MAX_FILE_BYTES (default 33554432 = 32 MiB)
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="node $ROOT/bin/asset-hub.js"
MIRROR_REPO="${1:-$ROOT/polyhaven-mirror-test}"
export ASSET_HUB_HOME="${ASSET_HUB_HOME:-$MIRROR_REPO/.live-home}"
MAX_FILE_BYTES="${MAX_FILE_BYTES:-33554432}"

# Curated batch — all CC0 (Poly Haven publishes every asset under CC0;
# per-asset license corroborated by official API metadata/descriptions).
BATCH=(
  polyhaven:ArmChair_01          # model, furniture   (gltf 1k pkg ≈ 0.8 MB, live-verified)
  polyhaven:BarberShopChair_01   # model, furniture
  polyhaven:Barrel_01            # model, industrial prop
  polyhaven:Barrel_02            # model, industrial prop
  polyhaven:Camera_01            # model, electronics (113k downloads)
  polyhaven:CashRegister_01      # model, retail prop
  polyhaven:Chandelier_01        # model, lighting
  polyhaven:Chandelier_02        # model, lighting
  polyhaven:concrete_floor_01    # texture (blend 1k pkg ≈ 5.5 MB, live-verified)
  polyhaven:aerial_grass_rock    # texture
  polyhaven:sunset_jhbcentral    # hdri (1k hdr = 1,573,705 B, live-verified)
  polyhaven:abandoned_bakery     # hdri
)

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "0. Connectivity + provider verification (live)"
curl -fsS -m 20 -H 'User-Agent: asset-hub-live-test/1.0' \
  'https://api.polyhaven.com/assets?t=models&future=max' -o /dev/null \
  || { echo 'BLOCKED: api.polyhaven.com unreachable from this machine — run where outbound HTTPS is allowed.'; exit 2; }
"$HUB" sources --json --home "$ASSET_HUB_HOME" | head -40

mkdir -p "$MIRROR_REPO" "$ASSET_HUB_HOME"
if [ ! -d "$MIRROR_REPO/.git" ]; then git init -q "$MIRROR_REPO"; fi

say "1. Config: 32 MiB per-file budget for this test batch"
"$HUB" config set mirror.maxFileBytes "$MAX_FILE_BYTES" --home "$ASSET_HUB_HOME"

say "2. mirror discover (real catalog enumeration — metadata only)"
"$HUB" mirror discover --repo "$MIRROR_REPO" --provider polyhaven --home "$ASSET_HUB_HOME" --json

say "3. Curate state to the test batch (full catalog backed up)"
node - "$MIRROR_REPO/.asset-hub-mirror/state.json" "${BATCH[@]}" <<'EOF'
const fs = require('fs');
const [file, ...keep] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const total = Object.keys(d.entries).length;
fs.copyFileSync(file, file + '.full-backup.json');
const entries = {};
for (const ref of keep) if (d.entries[ref]) entries[ref] = d.entries[ref];
const missing = keep.filter((r) => !entries[r]);
d.entries = entries;
fs.writeFileSync(file, JSON.stringify(d, null, 2));
console.log(`curated ${Object.keys(entries).length}/${total} entries (backup: state.json.full-backup.json)`);
if (missing.length) { console.error('NOT FOUND in catalog:', missing.join(', ')); process.exit(3); }
EOF

say "4. mirror download — license gate → verify → dedup → organize"
"$HUB" mirror download --repo "$MIRROR_REPO" --provider polyhaven --home "$ASSET_HUB_HOME" --json

say "5. mirror commit — LOCAL ONLY (never pushed by this script)"
"$HUB" mirror commit --repo "$MIRROR_REPO" --home "$ASSET_HUB_HOME" --json

say "6. mirror audit — integrity (every packaged file), licenses, attribution"
"$HUB" mirror audit --repo "$MIRROR_REPO" --home "$ASSET_HUB_HOME" --json

say "7. mirror capacity"
"$HUB" mirror capacity --repo "$MIRROR_REPO" --home "$ASSET_HUB_HOME" --json

say "8. library search (offline, over the local index)"
"$HUB" library search 'chair' --repo "$MIRROR_REPO" --home "$ASSET_HUB_HOME" --json
"$HUB" library search --cc0 --category hdri --repo "$MIRROR_REPO" --home "$ASSET_HUB_HOME" --json
"$HUB" library info polyhaven:ArmChair_01 --repo "$MIRROR_REPO" --home "$ASSET_HUB_HOME" --json

say "9. library import into temp engine projects"
ENG=$(mktemp -d)
mkdir -p "$ENG/godot-proj" "$ENG/unity-proj/Assets" "$ENG/unity-proj/ProjectSettings" "$ENG/unreal-proj"
printf 'config_version=5\n' > "$ENG/godot-proj/project.godot"
printf 'm_EditorVersion: 6000.0.0\n' > "$ENG/unity-proj/ProjectSettings/ProjectVersion.txt"
printf '{\n  "EngineAssociation": "5.4",\n  "Modules": []\n}\n' > "$ENG/unreal-proj/MyGame.uproject"
"$HUB" library import polyhaven:ArmChair_01    --repo "$MIRROR_REPO" --home "$ASSET_HUB_HOME" --project "$ENG/godot-proj"  --engine godot --json
"$HUB" library import polyhaven:Barrel_01      --repo "$MIRROR_REPO" --home "$ASSET_HUB_HOME" --project "$ENG/unity-proj"  --engine unity --json
"$HUB" library import polyhaven:Chandelier_02  --repo "$MIRROR_REPO" --home "$ASSET_HUB_HOME" --project "$ENG/unreal-proj" --engine unreal --json
echo "engine projects under: $ENG"

say "10. Proposed commit contents — exact files, sizes, licenses, URLs"
git -C "$MIRROR_REPO" show --stat --oneline HEAD | head -80
echo '--- name-only:'
git -C "$MIRROR_REPO" show --name-only --format= HEAD
echo '--- disk: '; du -sh "$MIRROR_REPO/assets"; du -sh "$MIRROR_REPO/.git"
echo '--- git objects: '; git -C "$MIRROR_REPO" count-objects -vH
echo '--- per-asset license + source (from ASSET_INDEX.jsonl):'
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
for (const a of lines) console.log(`${a.id.padEnd(34)} ${String(a.license).padEnd(8)} ${(a.size_bytes ?? 0).toString().padStart(9)} B  ${a.source_url}`);
' "$MIRROR_REPO/ASSET_INDEX.jsonl"

say "DONE — nothing pushed. Review the above, then (only if approved):"
echo "  asset-hub mirror push --repo \"$MIRROR_REPO\" --home \"$ASSET_HUB_HOME\""
