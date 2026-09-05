# JSON Schemas — the `--json` contract

Formal JSON Schema (draft-07) definitions for every machine-readable
`asset-hub` response. AI agents should rely on these shapes, never on
human-readable terminal output. Relative `$ref`s link related schemas.

| Schema | Command(s) |
|---|---|
| [`search-result.schema.json`](search-result.schema.json) (+ [`search-result-item.schema.json`](search-result-item.schema.json)) | `search`, `find` (`results`) |
| [`asset.schema.json`](asset.schema.json) | `info` (also `check_license` via MCP) |
| [`download-result.schema.json`](download-result.schema.json) | `download` |
| [`provider.schema.json`](provider.schema.json) | `sources` |
| [`license.schema.json`](license.schema.json) | `licenses` (items), embedded everywhere |
| [`export-result.schema.json`](export-result.schema.json) | `export` |
| [`recommend-result.schema.json`](recommend-result.schema.json) | `recommend`, `find` |
| [`acquire-result.schema.json`](acquire-result.schema.json) | `acquire`, `import` |
| [`project.schema.json`](project.schema.json) | `project` |
| [`error.schema.json`](error.schema.json) | every command on failure |

## Conventions

- **Success envelope**: successful responses are command-specific objects
  (see each schema). Commands that can fail mid-flight carry `success:
  true|false` explicitly (`download`, `export`, `acquire`, `batch`).
- **Failure envelope** (always): `{ "success": false, "error": { "code",
  "message", "exit_code", …context } }` — see `error.schema.json`. Emitted on
  **stdout** when `--json` is set; nothing else is printed.
- **Nullability**: unknown metadata is `null`, never fabricated. A missing
  polygon count is `"polygon_count": null` — not `0`, not a guess.
- **Asset identity**: `id` in results is always `provider:asset-id` — the
  exact string `download`/`info`/`import` accept. Library assets additionally
  have a `library_id` (UUID).
- **License safety**: `license.unknown === true` or
  `download_available === false` means automated download is blocked and no
  flag (`--yes` included) can change that. The official page is
  `source_url`.
- **Exit codes**: `0` ok · `1` usage/invalid asset · `2` conversion/export ·
  `3` license (unknown/restricted) · `4` provider/download/network · `5`
  confirmation required. `error.exit_code` always matches the process exit
  code.

## Validation in tests

`tests/ai.test.ts` validates real command output against these files with a
small built-in validator (supports the draft-07 subset used here: type,
required, properties, items, enum, const, oneOf/anyOf/allOf/$ref) — so the
contract is enforced continuously, offline.
