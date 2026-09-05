# Mirroring: a large-scale, legally compliant asset repository

`asset-hub mirror` turns any **empty Git repository you designate** into a
mirrored, catalogued library of 3D assets — but only of assets whose
**individual licenses explicitly permit redistribution**. Everything else is
recorded honestly (metadata + official URL) instead of being copied.

> The tool repository itself never stores assets. Mirrors live in
> operator-designated repos (`--repo <dir>`, default `.`).

## Quickstart

```bash
mkdir my-assets && cd my-assets && git init
asset-hub mirror discover          # enumerate catalogues (per provider)
asset-hub mirror download          # license gate → download → verify → dedup → organize
asset-hub mirror commit            # regenerate indexes + commit to git
asset-hub mirror push              # push to the remote (never past capacity limits)

# later
asset-hub mirror update            # incremental: new/removed/metadata/license changes
asset-hub mirror audit             # verify the whole repo (integrity, licenses, attribution)
```

Every command supports `--json`. Use `--repo DIR` to operate on another
checkout, `--provider a,b` to restrict sources.

## Provider honesty (what can actually be mirrored)

Providers are classified from their *capabilities*, not marketing:

| Tier | Meaning | Providers |
|---|---|---|
| `FULL_MIRROR` | searchable + downloadable + per-asset licenses permit redistribution | Poly Haven, ambientCG |
| `PARTIAL_MIRROR` | downloadable, but some/all assets restrict redistribution — mirrored asset-by-asset | Sketchfab, Poly Pizza, BlenderKit |
| `METADATA_ONLY` | catalog only; downloads not permitted for automated mirroring | (none currently enumerable) |
| `MANUAL_ONLY` | no permitted automated enumeration/download — official page only | Kenney, OpenGameArt, Mixamo, CGBookcase |
| `UNSUPPORTED` | known source, no integration | Quaternius, CGTrader, TurboSquid, … |

`asset-hub mirror report` prints this table with live per-provider counts.

## The license gate (never guessed)

During `mirror download`, every asset passes through:

1. **License unknown / cannot be verified** → `SKIPPED` with reason
   `UNKNOWN_LICENSE`. Recorded in the catalogue with its source URL.
2. **License known but forbids redistribution** (e.g. CC-BY-NC, "no
   redistribution", all-rights-reserved) → `SKIPPED` with reason
   `REDISTRIBUTION_NOT_PERMITTED`.
3. **Redistribution permitted** → downloaded, `sha256`-verified, and stored
   with full per-asset metadata.

`--yes` changes nothing here: an unverified license is never mirrored.

## Repository layout

```
assets/<category>/<slug>/
  original/            untouched original file(s) — never modified
  asset.json           per-asset metadata (license, sha256, source URL, …)
  preview.jpg          only for CC0/public-domain assets (when permitted)
indexes/<category>.json
ASSET_INDEX.json + ASSET_INDEX.jsonl     full catalogue (searchable offline)
licenses.json / LICENSES.md              per-asset license registry — never site-wide
ATTRIBUTIONS.md / ATTRIBUTIONS.txt       credit lines for attribution assets
mirror-audit.jsonl                       append-only audit trail
.asset-hub-mirror/state.json             resumable pipeline state (gitignored)
```

Categories: `characters creatures weapons vehicles buildings environments
props vegetation materials textures hdri animations vfx misc`.

## Generated metadata

`asset.json` (per asset) records `id`, `source`, `source_url`, `license`,
`license_url`, `redistribution_allowed`, `commercial_use`,
`attribution_required`, `sha256`, `size_bytes`, `formats`, `category`,
`download_date`, `file`, and provenance fields — snake_case, stable, and
byte-stable across repeated commits (no timestamp churn).

## Resumable downloads

Each asset moves through a durable state machine
(`DISCOVERED → LICENSE_VERIFIED → QUEUED → DOWNLOADING → DOWNLOADED → VERIFIED
→ PROCESSED → COMMITTED`, plus terminal `SKIPPED`/`FAILED`). State is saved
after **every** asset, so an interrupted run resumes exactly where it stopped:

```bash
asset-hub mirror download --resume     # continue non-terminal assets
asset-hub mirror download --failed     # retry FAILED entries only
asset-hub mirror download --limit 50   # bounded batch
```

`DUPLICATE` assets (identical URL or `sha256`) are never stored twice; the
duplicate's own source/license metadata is preserved in the catalogue with
`duplicate_of`.

## Capacity & GitHub limits

- `mirror.capacity` sums `assets/` bytes **plus the git object store** and
  LFS-tracked bytes.
- Defaults: warn at **2 GiB**, pause at **4 GiB**, per-file max **100 MiB**
  (GitHub's hard limit). Configure: `asset-hub config set mirror.pauseBytes …`,
  `mirror.warnBytes`, `mirror.maxFileBytes`.
- When the pause limit is hit the mirror enters **MIRROR PAUSED**
  (`REPOSITORY_CAPACITY`, exit code 6). Downloads skip gracefully; `commit`
  refuses. Raising the limit un-pauses automatically.
- With [git-lfs](https://git-lfs.com) installed, binary patterns
  (`*.glb *.fbx *.blend *.zip *.hdr *.exr`) are tracked via LFS +
  `.gitattributes`. Without LFS the mirror stays honest: plain git objects and
  a warning.

## License changes & revocation (incremental updates)

`mirror update` re-checks every catalogued asset:

- **Still redistributable, different license** → `LICENSE_CHANGED` recorded,
  metadata refreshed, warning printed.
- **Redistribution no longer permitted** → mirroring stops for that asset
  (`SKIPPED / REDISTRIBUTION_REVOKED`), the existing files and git history are
  **never silently deleted**, and an audit record is appended. Remediation is
  explicit:
  ```bash
  asset-hub mirror remediate <asset-id>            # flag reviewed, keep history
  asset-hub mirror remediate <asset-id> --remove   # remove from working tree
  ```
- **Asset gone from the source** → `SKIPPED / SOURCE_REMOVED`; the historical
  mirror is kept and audited.

## Auditing

```bash
asset-hub mirror audit      # integrity re-hash, metadata, license + attribution checks
```

Exit `0` = clean, `4` = findings (`ERROR` severity), with per-finding paths in
JSON. Every state transition, skip, license change and remediation is appended
to `mirror-audit.jsonl`.

## Using the library

Once a mirror exists it becomes a fast, fully offline library:

```bash
asset-hub library search "medieval castle" --cc0 --category buildings
asset-hub library info mock:mock-castle-01
asset-hub library import mock:mock-castle-01 --project ./MyGame
```

- `search` reads `ASSET_INDEX.json` (no network), supports `--cc0
  --commercial --category --license --format --provider --limit`.
- `info` re-verifies `sha256` integrity on the spot (exit `4` on drift).
- `import` verifies integrity **and** redistribution before copying anything,
  picks an engine-aware destination (detects Godot/Unity/Unreal/Bevy projects),
  never overwrites existing files, and appends the required credit line to the
  project's `ATTRIBUTIONS.md`/`.txt` (header written exactly once).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 3 | `LICENSE_RESTRICTED` / paused capacity report |
| 4 | findings / failed downloads / integrity drift |
| 6 | `REPOSITORY_CAPACITY` — mirror paused, never bypassed silently |

See `schemas/error.schema.json` for the machine-readable contract.
