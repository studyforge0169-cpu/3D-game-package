# Universal Game Asset Hub

**`asset-hub`** — a unified command-line tool (plus an optional desktop app)
for game developers to **search, license-check, download, organize, verify,
convert and engine-export 3D game assets** from the major public asset
libraries — through each site's *officially permitted* access method.

```bash
asset-hub search "medieval castle" --cc0
asset-hub download polyhaven:castle_ruins --output ./GameAssets
asset-hub download-list assets.txt
asset-hub export <library-id> --engine unreal --output ./MyGame
```

> **Real integrations only.** If a source has an official API, the tool uses
> it. If a source does not permit automated access, the tool says so and opens
> the official page instead — it never scrapes, never fakes results, never
> bypasses paywalls/DRM/CAPTCHAs/rate limits/robots.txt. If an asset's license
> cannot be verified, the download is **blocked**, not guessed.

## What it does

1. **Unified search** across 16 sources (Poly Haven, AmbientCG, Sketchfab,
   Poly Pizza, BlenderKit, OpenGameArt + 10 manual/browser-tier sources) with
   license, format, poly-count, texture-res, PBR/rigged/animated filters.
2. **License intelligence** — every asset's individual license is fetched from
   official data, labeled (🟢 commercial-safe / 🟡 conditional / 🔵 attribution /
   🔴 non-commercial / ⚫ unknown) and enforced.
3. **Safe downloads** — batch queue, retries, resume, rate limits, disk-space
   checks, SHA-256/MD5 verification, duplicate detection; originals stay
   immutable.
4. **Local organization** — auto-categorized library
   (Characters/…/HDRIs/Other) with `asset.json` metadata sidecars and
   auto-maintained `ATTRIBUTIONS.md`/`.txt`; fully offline after download.
5. **Game-ready processing** — `inspect`/`convert`/`optimize` for
   GLB/GLTF/OBJ/STL/PLY natively, FBX/BLEND/DAE via optional assimp/Blender;
   LOD + collision generation; Original/Processed/GameReady separation.
6. **Engine export** — Unreal / Unity / Godot / Blender folder layouts with
   overwrite protection and attribution files included.

## Installation

**Requirements:** Node.js 22.13+. Full details: [docs/installation.md](docs/installation.md).

```bash
npm install
npm run build
npm link            # → `asset-hub` on your PATH
asset-hub --help
```

Windows end-users can instead install the desktop app
(`UniversalGameAssetHub-Setup.exe` from releases, or `npm run dist:win`) —
same core, same library, plus a GUI with a built-in 3D viewer.

## Basic commands

```
asset-hub search "<terms>" [--cc0 | --commercial | --free | --license <id>]
                           [--format <ext>] [--max-poly <n>] [--rigged] …
asset-hub info <provider:asset-id>
asset-hub download <provider:asset-id> [--output DIR] [--category CAT]
asset-hub batch assets.txt            # alias: download-list
asset-hub list | attributions | update
asset-hub inspect model.glb | convert model.fbx --format glb | optimize model.glb
asset-hub export <ids…> --engine unreal|unity|godot|blender --output DIR
asset-hub sources | licenses | key | config
```

Try it offline first: `asset-hub --fixtures search castle`.

## Supported providers

16 connectors — tiers and evidence in **[docs/providers.md](docs/providers.md)**
(live table: `asset-hub sources`):

| Tier | Sources |
|---|---|
| **Full** (official API search + download) | Poly Haven · AmbientCG · Sketchfab¹ · Poly Pizza² · BlenderKit² |
| **Hybrid** (official data, robots-compliant) | OpenGameArt |
| **Manual** (browser + import; no API / not permitted) | Kenney · Quaternius · KayKit · CGBookcase · itch.io · CGTrader · TurboSquid · Free3D · Mixamo · Fab |

¹ downloads need your free Sketchfab token · ² free API key.

Additional researched sources (Smithsonian, Wikimedia Commons, NASA, Printables,
Thingiverse) are documented in providers.md with the exact reasons they are
(not) integrated.

## Licensing

- Every asset keeps **its own license**; the tool shows and enforces it per
  asset, never per site. Unknown license ⇒ no download (core-level block).
- Attribution-required assets are tracked, and `ATTRIBUTIONS.txt/.md` are
  generated for your library and every export.
- Paid content is never fetched; manual-tier sources open official pages.
- robots.txt and documented rate limits are honored and cannot be disabled.
- App code: Apache-2.0. Full guidance: [docs/licensing.md](docs/licensing.md).

## Configuration

JSON config at `~/.universal-game-asset-hub/config.json` (see
[config/config.example.json](config/config.example.json)); manage with
`asset-hub config`. Keys: library directory, enabled providers, download
concurrency/retries/limits, preferred formats, converter paths, attribution
options. **API keys live in OS credential storage** (`asset-hub key set …`),
never in files, never logged, never hard-coded.

## Development

```bash
npm run typecheck     # both tsconfigs
npm test              # 134 offline tests (no network)
npm run test:live     # opt-in live-API verification
npm run dev:electron  # desktop app
npm run dev:web       # browser UI
```

Docs: [docs/architecture.md](docs/architecture.md) ·
[docs/development.md](docs/development.md) ·
[docs/providers.md](docs/providers.md) ·
[docs/usage.md](docs/usage.md) ·
[docs/licensing.md](docs/licensing.md) ·
[USER_MANUAL.md](docs/USER_MANUAL.md) (desktop app).

### Adding a new provider

1. Verify official API docs / robots.txt / ToS and add a row to
   `docs/providers.md` with evidence. No public API ⇒ contribute a
   `ManualProvider` spec, not a scraper.
2. Implement the `AssetProvider` interface (search/getAsset/getLicense/
   getDownloadOptions/getMetadata/download/getPreview) in
   `src/core/providers/<name>.ts` and register it in `src/core/providers/registry.ts`.
3. Per-asset license from official data, honest `isConfigured`, rate limits in
   config — see [docs/development.md](docs/development.md) for the checklist
   and the test conventions.
