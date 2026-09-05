# Usage — `asset-hub` CLI

The CLI is the primary interface. Every command runs the same core as the
desktop app; both can share one data directory and library.

```
asset-hub <command> [arguments] [--json] [--home DIR] [--library DIR] [--fixtures]
```

Global flags: `--json` machine-readable output · `--home` data directory
override · `--library` library root override (per-invocation, never saved) ·
`--fixtures` offline demo mode · `--verbose` debug logging.

---

## Search

```bash
asset-hub search "medieval castle"
asset-hub search "sci fi soldier" --cc0
asset-hub search "forest" --commercial --format glb --max-poly 20000
asset-hub search "zombie" --provider sketchfab,polyhaven --sort newest
```

Output (one block per result — name, source, license, formats, poly/texture
detail, download availability, official URL):

```
1. Medieval Castle
   Source: polyhaven
   Creator: …
   License: CC0-1.0  (commercial use: YES)
   Format: GLB / FBX / BLEND
   Detail: poly 18,500 · 3.2 MB
   Download: free
   URL: https://polyhaven.com/a/…
```

Filters: `--cc0` · `--commercial` · `--free` · `--no-attribution` ·
`--license <id-substring>` (e.g. `cc-by-4.0`) · `--format <ext>` ·
`--kind <model|texture|material|hdri>` · `--topic <t>` · `--max-poly/--min-poly <n>`
· `--min-res <px>` · `--max-size <MB>` · `--pbr` · `--rigged` · `--animated`
· `--sort <relevance|quality|popularity|polygons|textureResolution|fileSize|newest>`
· `--limit n` · `--page n` · `--provider id,id2`.

Sources without API search print a **browser fallback line** with their
official search URL instead of fake results — by design.

## Asset info

```bash
asset-hub info polyhaven:castle_ruins
```

Full metadata: description, creator, license screen (id, name, URL, commercial
use, attribution, share-alike, verification date), every download option with
format/size, and provider metadata. `--json` for scripting.

## Download

```bash
asset-hub download polyhaven:castle_ruins
asset-hub download polyhaven:castle_ruins --output ./GameAssets
asset-hub download mock:mock-castle-01 --category environment   # demo mode
```

Manual-tier sources (Kenney, Quaternius, Mixamo, …) have **no automated
download by design** — `asset-hub info <id>` / search results link you to the
official page, and the desktop app's Import wizard registers what you
downloaded yourself (license confirmation required).

What happens automatically:

- the **individual asset's license is fetched and shown**; unknown ⇒ blocked
- duplicate detection (SHA-256 / source URL / filename) ⇒ already-have-it is
  skipped, never re-downloaded
- disk-space check, official endpoint only, polite rate limits
- file is placed under `GameAssets/<Category>/<Asset>/Original/` — the
  original file is **never modified**
- `asset.json` sidecar (name, creator, source, license, URLs, hash, date)
  is written next to the file
- `ATTRIBUTIONS.md` + `ATTRIBUTIONS.txt` are regenerated at the library root

Exit codes: `0` success/duplicate · `3` license blocked · `4` failed · `1` usage.

## Batch downloads

```bash
asset-hub download-list assets.txt      # alias: asset-hub batch assets.txt
```

`assets.txt` — one `provider:asset-id` per line, `#` comments allowed:

```
polyhaven:castle
quaternius:knight
kenney:medieval-props
```

Queue with safe concurrency (config `downloads.globalConcurrency`), retries,
live progress, per-item status, and a final summary (completed / duplicates
skipped / failed). Non-zero exit if anything failed.

## Local library

```bash
asset-hub list                          # everything, with export-ready IDs
asset-hub list --category Characters --favorite
asset-hub attributions                  # regenerate ATTRIBUTIONS files
asset-hub update [--dry-run]            # re-check licenses against sources
```

Library layout (auto-categorized, offline-safe):

```
GameAssets/
    ATTRIBUTIONS.md · ATTRIBUTIONS.txt
    Assets/Characters/… /Creatures/… /Weapons/… /Vehicles/… /Buildings/…
          /Environment/… /Props/… /Vegetation/… /Materials/… /Textures/…
          /HDRIs/… /Animations/… /VFX/… /Other/…
        <Asset Name_xxxx>/
            Original/    (immutable, as downloaded)
            Processed/   (converted)
            GameReady/   (LODs, collision)
            asset.json   (portable metadata)
```

## Game-ready processing

```bash
asset-hub inspect model.glb                 # meshes/verts/tris/materials/animations/bbox
asset-hub optimize model.glb                # weld + normals + prune + jpeg textures
asset-hub convert model.fbx --format glb    # FBX via assimp/Blender if configured
asset-hub convert model.obj --format glb --lods 0.5,0.25 --collision bbox
asset-hub convert model.glb --format gltf --texture-max 2048 --out dir/
```

Native support: GLB ⇄ GLTF, OBJ(+MTL), STL, PLY. FBX / BLEND / DAE are
converted through optional external tools (configure once):

```bash
asset-hub config set converters.assimpPath /usr/bin/assimp
asset-hub config set converters.blenderPath "C:/Program Files/Blender Foundation/Blender 4.2/blender.exe"
```

Nothing is ever corrupted to "claim" support — if a conversion can't be done
faithfully, the command fails honestly and says why.

## Engine export

```bash
asset-hub export <library-id> --engine unreal --output ./MyGame
asset-hub export mock:mock-castle-01 --engine unity --output ./MyGame   # downloads first
asset-hub export <id> <id2> --engine godot --output ./MyGame --on-conflict rename
```

`--output` is your game project root; `--project` overrides the project name
(default: the folder name). Layouts: Unreal `Content/<Category>/`, Unity
`Assets/<Category>/`, Godot `assets/<category>/`, Blender plain folders.
Existing files are **never overwritten silently** — `--on-conflict
skip|rename|overwrite` (default `skip`). Every export writes
`ATTRIBUTIONS.txt/.md` into the project.

## Sources & licenses

```bash
asset-hub sources        # what every provider supports (search/download/API/license)
asset-hub licenses       # the license registry and its permissions
asset-hub key list       # API keys (Sketchfab / Poly Pizza / BlenderKit)
asset-hub key set sketchfab <your-token>
```

Manual-tier sources (Kenney, Quaternius, TurboSquid, …) intentionally have no
automated download. The CLI opens their official page; use the desktop app's
**Import** wizard to register the file you downloaded yourself — it requires
you to confirm the license, which is recorded in `asset.json`.

## Configuration

```bash
asset-hub config path
asset-hub config list                     # all keys, types, current values
asset-hub config set downloads.globalConcurrency 5
asset-hub config set enabledProviders polyhaven,ambientcg
asset-hub config set downloads.preferredFormats glb,fbx
asset-hub config set network.respectRobots false   # → refused, by design
```

See `config/config.example.json` for the full annotated schema. Data lives in
`~/.universal-game-asset-hub/` (override: `--home` / `UGAH_DATA_DIR`).

## AI-native commands

```bash
asset-hub find "I need a realistic medieval castle for my Unreal game"   # parse → structured search
asset-hub recommend "zombie character" --engine unity --json             # ranked candidates + factor metadata
asset-hub project --json                                                 # detect the project in cwd (read-only)
asset-hub acquire "forest environment" --engine godot --output ./MyGame --dry-run --json
asset-hub acquire "forest environment" --engine godot --output ./MyGame --yes --json
asset-hub import polyhaven:<id> --project ./MyGame --json                 # or a local file (+ --license --provider)
asset-hub mcp                                                            # optional local MCP server (stdio)
```

Deterministic parsing (no external LLM), license re-verification before every
download, `--dry-run` plans, `--require-confirmation` / `--yes` approval
semantics. Full contract: [ai-integration.md](ai-integration.md);
agent instructions: [../AGENTS.md](../AGENTS.md),
[../skills/asset-hub/SKILL.md](../skills/asset-hub/SKILL.md).

## Mirroring & the offline library

Build a Git-backed mirror of legally redistributable assets in a dedicated
repository, then use it as a fast offline library:

```bash
asset-hub mirror discover          # enumerate provider catalogues
asset-hub mirror download          # license gate → download → verify → dedup → organize
asset-hub mirror commit            # regenerate indexes/registries + git commit
asset-hub mirror push              # push (capacity-checked, LFS-aware)
asset-hub mirror update            # incremental sync (license changes, removals)
asset-hub mirror audit             # full integrity/license/attribution audit
asset-hub mirror status | report | capacity
asset-hub mirror remediate <id> [--remove]   # explicit license-revocation workflow

asset-hub library search "castle" --cc0 --category buildings
asset-hub library info polyhaven:<id>
asset-hub library import polyhaven:<id> --project ./MyGame   # engine-aware, integrity-checked
```

Assets whose license is unknown or forbids redistribution are **never**
mirrored — they stay in the catalogue as metadata with their official URL.
All commands support `--json` and `--repo DIR`. Details:
[docs/mirroring.md](docs/mirroring.md).

## Desktop app

`npm start` (or the installed `UniversalGameAssetHub-Setup.exe`) runs the GUI
(same library, plus a 3D viewer, collections, projects UI). See
[USER_MANUAL.md](USER_MANUAL.md).
