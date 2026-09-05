---
name: asset-hub
description: Find, license-check, download, process and import 3D game assets from legitimate sources (Poly Haven, Sketchfab, Kenney, …) into Unreal/Unity/Godot/Blender projects — one local CLI, machine-readable JSON.
---

# Skill: add a 3D asset to a game with `asset-hub`

`asset-hub` is a local CLI gateway over 16 asset sources with per-asset
license verification. Always use it instead of browsing asset websites.
Always pass `--json` and rely on `schemas/` for shapes.

## Recommended procedure

```text
1. Detect project        asset-hub project --json
2. Determine engine      from detection, or ask the user / use the request
3. Search                asset-hub search "<terms>" --json      (or: find "<request>")
4. Filter licenses       --cc0 / --commercial / --free / --license <id>
5. Inspect candidates    asset-hub info <provider:asset-id> --json
6. Select candidate      asset-hub recommend "<request>" --engine <engine> --json
7. Dry-run acquisition   asset-hub acquire "<request>" --engine <engine> --output <project> --dry-run --json
8. Acquire / import      asset-hub acquire ... --yes --json     (or: asset-hub import <ref> --project <dir> --json)
9. Verify files          download.path exists · sha256 present · inspect <file> --json matches expectations
10. Verify integration   export.files land inside the project's asset directory; engine imports are the user's step
11. Generate attribution automatic on every download/export (ATTRIBUTIONS.txt/.md); verify attribution.files
12. Report result        asset · source · license · attribution obligations · paths
```

## Commands you will actually use

```bash
# What can be automated where (honest per-provider capabilities):
asset-hub sources --json
asset-hub library search "<terms>" --repo <mirror-dir> --cc0 --json   # offline mirror library
asset-hub library import <id> --repo <mirror-dir> --project <dir> --json
# → providers[].{search,download,license_verification,automation}
#   automation "manual" ⇒ browser-only; give the user source_url instead.

# Search with license safety:
asset-hub search "medieval castle" --cc0 --json
asset-hub search "zombie" --rigged --engine unity --json
# → results[].id = "provider:asset-id", .license.unknown, .download_available,
#   .formats, .polygon_count, .engine_compatibility

# Natural language → structured criteria (deterministic, no LLM):
asset-hub find "I need a realistic medieval castle for my Unreal Engine game" --json

# Ranked candidates with reasoning:
asset-hub recommend "low-poly zombie character" --engine godot --json
# → candidates[].score.factors[] (license_safety, relevance, engine_compatibility…)
#   excluded[] (why unsafe candidates were dropped) — never pick from excluded[].

# Plan before acting:
asset-hub acquire "forest environment" --engine unreal --output ./MyGame --dry-run --json

# Execute (license re-verified from official data immediately before download):
asset-hub acquire "forest environment" --engine unreal --output ./MyGame --yes --json

# Import one known asset (or a local file — local files need --license + --provider):
asset-hub import mock:mock-tree-01 --project ./GodotGame --json
asset-hub import ./house.glb --project ./UnityGame --provider kenney --license CC0 --json

# Processing:
asset-hub inspect Assets/Characters/Zombie.glb --json
asset-hub convert model.fbx --format glb --json        # fbx needs assimp/Blender configured
asset-hub optimize model.glb --json
```

## Decision rules

- `license.unknown === true` or `download_available === false` → **stop**;
  offer `source_url` to the user. No flag lifts this.
- `attribution_required === true` → tell the user credits are mandatory;
  ATTRIBUTIONS files are already generated — list their paths in your report.
- `commercial_use === false` → warn loudly; most game projects cannot ship it.
- Scores: use `score.factors`, don't invent quality claims. Missing metadata
  is `null` and must be reported as unknown, never estimated.
- Duplicates: `download.duplicate: true` on re-acquire is a success — reuse,
  don't force re-downloads.

## Error handling

Failures arrive as `{ "success": false, "error": { "code", "message",
"exit_code" } }` on stdout. React by code:

| code | meaning | your move |
|---|---|---|
| `LICENSE_UNKNOWN` / `LICENSE_RESTRICTED` | cannot auto-download | give `source_url`, stop |
| `DOWNLOAD_UNAVAILABLE` | manual-tier source or robots-blocked | give `source_url`, stop |
| `AUTH_REQUIRED` | provider API key missing | tell user: `asset-hub key set <provider> <key>` |
| `RATE_LIMITED` | provider limit (never bypassed) | wait, retry later |
| `INVALID_ASSET` | bad ref / not found | re-run `search --json` for a fresh id |
| `CONVERSION_FAILED` | format unsupported natively | needs assimp/Blender (`config set converters.*`) or different format |
| `CONFIRMATION_REQUIRED` | `--require-confirmation` without TTY | re-run with `--yes` if permitted, or ask the human |
| `NOT_FOUND` | no results | broaden the query or another provider |

## Offline/demo mode

`--fixtures` runs the identical pipeline against a bundled fixture provider
(`mock:mock-castle-01` is CC0) — use it to rehearse a workflow without
network access.
