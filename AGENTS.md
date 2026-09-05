# AGENTS.md — asset-hub for AI coding agents

`asset-hub` is a **local AI-friendly gateway for discovering and acquiring
legally available 3D game assets** from multiple sources. You (the agent)
only need to learn this one tool — never how individual asset websites work.

Everything runs locally. Every command has a stable `--json` contract
(`schemas/*.schema.json`), stable exit codes, and machine-readable errors.
License safety is enforced by the core and **cannot be bypassed by any flag**.

## Quick reference

```bash
asset-hub sources --json                                   # what each provider supports (honest)
asset-hub search "medieval castle" --cc0 --json            # unified search
asset-hub info polyhaven:<asset-id> --json                 # metadata + license + download options
asset-hub download polyhaven:<asset-id> --json             # license-checked download
asset-hub project --json                                   # detect the game project in cwd
asset-hub recommend "zombie character" --engine unity --json   # ranked candidates + reasoning
asset-hub acquire "realistic spaceship" --engine unreal --dry-run --json   # plan, no downloads
asset-hub acquire "realistic spaceship" --engine unreal --output ./MyGame --yes --json
asset-hub import polyhaven:<id> --project ./MyGame --json  # acquire into a specific project
asset-hub inspect model.glb --json                         # mesh stats
asset-hub convert model.fbx --format glb --json
asset-hub optimize model.glb --json
asset-hub export <library-id> --engine godot --output ./MyGame --json
asset-hub licenses --json
```

Global flags: `--json` (always prefer), `--library DIR`, `--home DIR`,
`--fixtures` (offline demo provider), `--verbose`.

## Interpreting output

- **Result identity**: every search result's `id` is `provider:asset-id` —
  that exact string is what `download` / `info` / `import` accept.
- **Unknown values are `null`**, never guesses: `"polygon_count": null` means
  the source does not report it. Do not infer numbers from absence.
- **License objects** (`schemas/license.schema.json`): `unknown: true` ⇒
  downloads are blocked by design; `commercial_use: null` = unknown;
  `attribution_required: true` ⇒ you must ship credits (the tool generates
  `ATTRIBUTIONS.txt/.md` automatically on download/export).
- **`download_available: false`** means automated download is not permitted —
  use `source_url` to direct the user to the official page. Never try to
  work around it (scraping, auth bypass, etc. is refused by design and would
  violate the license stance of this tool).
- **Exit codes**: `0` ok · `1` usage/invalid asset · `2` conversion/export ·
  `3` license blocked/restricted · `4` provider/download/network · `5`
  confirmation required. In `--json` mode, failures print
  `{ "success": false, "error": { "code", "message", "exit_code", … } }`
  to **stdout** (`schemas/error.schema.json`) — do not parse stderr.

## The safe workflow (use this order)

1. `asset-hub project --json` — detect engine (uproject / project.godot /
   Assets+ProjectSettings / *.blend). Detection never modifies anything.
2. `asset-hub recommend "<request>" --engine <engine> --json` — ranked
   candidates with transparent `score.factors`. Never fabricate quality
   judgments yourself; the scores carry only factors with real data.
3. `asset-hub acquire "<request>" --engine <engine> --output <project> --dry-run --json`
   — inspect the plan (selected asset, license, size, steps, destination,
   attribution requirements) before acting.
4. Execute: `acquire` (add `--yes`; add `--require-confirmation` for a human
   prompt). The command re-verifies the license from official data right
   before downloading and refuses unknown licenses (exit 3).
5. Verify the result: model exists at `download.path`, metadata at
   `download.metadata_path`, sha256 present, `export.files` in the project,
   attribution files listed. Re-check any time with `asset-hub list --json`,
   `asset-hub inspect <file> --json`, `asset-hub update --json`.
6. Report to the user: asset, source, license, attribution obligations.

## Never do these

- Never bypass `LICENSE_UNKNOWN` / `LICENSE_RESTRICTED` /
  `DOWNLOAD_UNAVAILABLE` — no scraping, URL fabrication, auth tricks, or
  manual HTTP fetches of the asset. Point the user to `source_url`.
- Never commit downloaded assets into the repository. They belong in the
  user's library (`--library`) or game project.
- Never re-implement providers manually; manual-tier sources are manual by
  design (legal constraints), see `asset-hub sources --json`.
- Never edit the ATTRIBUTIONS files to remove requirements — they are legal
  outputs of the licenses.

## More

- Full JSON contract + error codes: [docs/ai-integration.md](docs/ai-integration.md)
- Task recipes: [docs/ai-workflows.md](docs/ai-workflows.md)
- Agent skill instructions: [skills/asset-hub/SKILL.md](skills/asset-hub/SKILL.md)
- MCP server (optional, local stdio): `asset-hub mcp` —
  [docs/ai-integration.md](docs/ai-integration.md#mcp-server)
