# AI Integration — the `asset-hub` machine contract

How AI agents and local automation consume asset-hub: JSON everywhere,
formal schemas, standardized errors, deterministic NL commands, engine
awareness, dry-run/approval semantics, and an optional local MCP server.

## 1. JSON mode (`--json`)

Every major command accepts `--json` and prints **only** a machine-readable
document to stdout (progress and human text are suppressed; errors also go to
stdout in JSON form):

```bash
asset-hub sources --json
asset-hub search "forest" --cc0 --json
asset-hub info <provider:asset-id> --json
asset-hub download <provider:asset-id> --json
asset-hub inspect model.glb --json
asset-hub convert model.fbx --format glb --json
asset-hub optimize model.glb --json
asset-hub export <library-id> --engine unreal --output ./MyGame --json
asset-hub licenses --json
asset-hub find|recommend|acquire|import|project … --json
```

Field naming is **snake_case, uniform across providers**. Unknown metadata is
`null` — never fabricated. The identity field `id` is always
`provider:asset-id`, accepted verbatim by `download` / `info` / `import`.

## 2. Schemas

Formal JSON Schema (draft-07) files live in [`schemas/`](../schemas/README.md)
and are enforced by the test suite (`tests/ai.test.ts` validates every
command's real output against them, offline).

## 3. Error contract

On failure (JSON mode) stdout carries exactly one document — see
[`schemas/error.schema.json`](../schemas/error.schema.json):

```json
{
  "success": false,
  "error": {
    "code": "LICENSE_UNKNOWN",
    "message": "License could not be established — download blocked. …",
    "exit_code": 3,
    "command": "download",
    "asset_id": "sketchfab:abcdef…",
    "source": "sketchfab"
  }
}
```

Codes → exit codes: `LICENSE_UNKNOWN`/`LICENSE_RESTRICTED` → 3 ·
`DOWNLOAD_UNAVAILABLE`/`PROVIDER_UNAVAILABLE`/`RATE_LIMITED`/`AUTH_REQUIRED`/
`DISK_SPACE`/`NETWORK_ERROR` → 4 · `CONVERSION_FAILED`/`EXPORT_FAILED` → 2 ·
`INVALID_ASSET`/`INVALID_USAGE`/`NOT_FOUND` → 1 · `DUPLICATE` → 0
(informational) · `CONFIRMATION_REQUIRED` → 5.
License-class failures cannot be overridden — not by `--yes`, not by anything.

## 4. Natural-language commands (deterministic — no external LLM)

- `find "<request>"` → parses engine/style/license/poly-budget/rigging from
  the sentence, returns `{ request, parsed, results }`.
- `recommend "<request>" [--engine …]` → ranked candidates. Scoring is a
  weighted mean **over factors with available data only** (license safety,
  download availability, relevance, engine compatibility, format support,
  polygon fit, texture quality, rigging/animation, source reliability, file
  size). Every factor is returned with name/weight/value/detail; the schema
  forbids invented scores. Unsafe candidates are listed in `excluded[]` with
  reasons — never selected.
- `acquire "<request>"` → the one-command pipeline:
  search → rank → select → **re-verify license from official data** →
  download (hash-verified, duplicate-safe) → inspect → convert (only when
  the engine needs a format the tool can produce) → optimize (`--optimize`)
  → export into the project (when engine/target known) → attribution files
  → full result JSON (`schemas/acquire-result.schema.json`).

## 5. Dry-run and approval

- `--dry-run`: executes nothing — returns candidates, plan (selected asset,
  license, estimated size, processing steps, destination, attribution
  requirements, alternatives). Zero side effects beyond config/db bootstrap.
- `--require-confirmation`: prints the plan and asks a human `[y/N]` (TTY
  only). Without a TTY it fails `CONFIRMATION_REQUIRED` (exit 5).
- `--yes`: skips the prompt for permitted operations. It **never** weakens
  license checks, provider restrictions, or robots/rate compliance.

## 6. Project detection

`asset-hub project [--path DIR] --json` → `schemas/project.schema.json`:
engine from `*.uproject` / `project.godot` / `Assets/`+`ProjectSettings/` /
`*.blend`, plus the conventional asset directory (`Content`, `Assets`,
`assets`). Detection is read-only — a project is never modified merely by
being detected. `acquire`/`import` use it automatically when run inside a
project (or with `--project`), and `--engine` always wins when explicit.

## 7. Engine awareness

`search --engine <id>` annotates every result with
`engine_compatibility: { status: preferred | convertible | incompatible |
unknown, note }` (preferred = direct import format; convertible = asset-hub
converts natively pre-export). `recommend`/`acquire` fold the same signal
into ranking/planning, and exports land in engine-correct layouts
(Unreal `Content/`, Unity `Assets/`, Godot `assets/`, Blender folders).

## 8. Provider transparency

`asset-hub sources --json` (`schemas/provider.schema.json`) reports, per
provider: `search`, `metadata`, `download`, `license_verification`,
`per_asset_license`, `needs_api_key`/`api_key_configured`, `tier`
(full/hybrid/manual) and `automation` (`supported`/`partial`/`manual`).
Manual-tier providers are browser workflows by design — the tool reports
`download: false` and hands back the official `source_url` rather than
pretending. It never claims a capability a connector doesn't have.

## 9. MCP server (optional, fully local)

`asset-hub mcp` starts a **stdio** Model Context Protocol server
(JSON-RPC 2.0, protocolVersion 2024-11-05 — no dependencies, no cloud).
Register it in any MCP client as the command `asset-hub mcp`.

Tools (each returns the same JSON the CLI emits):

```text
search_assets  get_asset  check_license  download_asset  inspect_asset
convert_asset  optimize_asset  recommend_assets  acquire_asset  import_asset
export_asset  list_sources  detect_project
```

Every tool call runs the local CLI with `--json`; license-safety rules apply
identically (they live in the core, not the UI).

## 10. Performance notes for agents

One `recommend`/`acquire` = one provider search round + one license fetch for
the chosen asset (fresh, official). License state of library assets is stored
with `license_checked_at` and refreshed by `asset-hub update` — never treated
as eternal. Rate limiting (per-host token buckets, robots.txt) is automatic;
on `RATE_LIMITED`, wait and retry rather than hammering.

## 11. Offline rehearsal

`--fixtures` swaps in the bundled provider (`mock:mock-castle-01` CC0,
`mock:mock-unknown-01` unknown-license, …) so entire agent workflows can be
exercised with zero network — the same code paths, schemas and errors.
