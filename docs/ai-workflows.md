# AI Workflows — task recipes for agents

Concrete command sequences for common requests. All offline-testable with
`--fixtures`. JSON is omitted here for brevity — agents should always add
`--json`.

## Example 1 — "Add a realistic tree to my Unreal game"

```bash
asset-hub project --json                                   # detect the project (engine: unreal)
asset-hub recommend "realistic tree" --engine unreal --json
asset-hub acquire "realistic tree" --engine unreal --dry-run --json
asset-hub acquire "realistic tree" --engine unreal --yes --json
```

Report: chosen asset + license (from `asset.license`), file paths
(`download.path`, `export.files`), attribution obligations
(`attribution.required`, files generated), mesh stats (`inspection`).

## Example 2 — "Find me a free CC0 medieval sword"

```bash
asset-hub search "medieval sword" --cc0 --json
```

Nothing is downloaded; each result's `id` is the handle the user (or you) can
`download` / `acquire` later. Non-CC0 results are filtered; unknown-license
results appear marked `download_available: false`.

## Example 3 — "Import a low-poly zombie character into my Godot project"

```bash
asset-hub project --path ./MyGodotGame --json              # or run inside it
asset-hub acquire "low-poly zombie character" --engine godot --output ./MyGodotGame --dry-run --json
asset-hub acquire "low-poly zombie character" --engine godot --output ./MyGodotGame --yes --json
# or, if the user already picked an asset:
asset-hub import polyhaven:<asset-id> --project ./MyGodotGame --json
```

"low-poly" is parsed as ≤ 10k triangles (override with `--max-poly`); the
plan shows the budget interpretation in `parsed.max_poly`.

## Example 4 — "Find the best free forest assets but don't download anything"

```bash
asset-hub recommend "free forest environment" --dry-run --json
# --dry-run is implicit for recommend (it never downloads); acquire adds explicit planning:
asset-hub acquire "free forest environment" --dry-run --json
```

## Example 5 — "Convert this FBX to GLB and put it in Unity"

```bash
asset-hub convert ./Downloads/knight.fbx --format glb --json
asset-hub import ./Downloads/knight.fbx --project ./MyUnityGame --provider kenney --license "CC0" --json
```

FBX conversion needs assimp or Blender on PATH (or configured):
`asset-hub config set converters.assimpPath /usr/bin/assimp`. Local-file
imports **require** `--license` (+ `--provider`); the license is recorded in
`asset.json` and drives attribution.

## Example 6 — audit the library's licenses and refresh them

```bash
asset-hub list --json
asset-hub update --dry-run --json      # see what changed at the sources
asset-hub update --json                # apply re-checks (DB + asset.json updated)
asset-hub attributions --json          # regenerate ATTRIBUTIONS.txt/.md
```

## Example 7 — batch acquire from a list

```bash
printf 'polyhaven:castle\nmock:mock-tree-01\n' > assets.txt   # provider:asset-id lines
asset-hub batch assets.txt --json
```

Per-item states (`completed`, `skipped_duplicate`, `blocked_license`,
`failed` with `error.code`) + a summary; exit 4 if anything failed.

## Example 8 — rehearsal without network (CI, demos, prompt tests)

```bash
asset-hub --fixtures search castle --cc0 --json
asset-hub --fixtures recommend "medieval castle for unity" --json
asset-hub --fixtures acquire "medieval castle" --engine unity --output ./Demo --yes --json
```

The fixture provider ships a CC0 castle, CC-BY assets, a non-commercial mech,
a duplicate pair and an unknown-license crate — enough to exercise every
branch (blocked downloads exit 3 with `LICENSE_UNKNOWN`, etc.).

## Guardrails that apply to every workflow

- Unknown/restricted license → command refuses; you get `source_url` for the
  human. Never scrape or hand-fetch instead.
- `--yes` never overrides license/provider restrictions.
- Attribution files are generated automatically on download and export;
  report their paths whenever `attribution.required` is true.
- Downloaded assets never belong in the repository — only in the library
  (`--library`) or the user's project.
