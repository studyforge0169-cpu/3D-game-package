# Universal Game Asset Hub — Technical Architecture

Version 1.0 · Status: implemented

Universal Game Asset Hub (UGAH) is a desktop application that lets game developers
**discover → license-check → download → organize → convert → export** 3D assets from
public asset libraries through each site's *official* access mechanism, without ever
bypassing paywalls, authentication, CAPTCHAs, DRM or rate limits.

---

## 1. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Desktop shell | **Electron 37** | Cross-platform desktop app; three.js 3D viewer in Chromium; NSIS installer via electron-builder. |
| Language | **TypeScript 5.7** (strict) everywhere | Single language across core, main, preload, renderer. |
| UI | **React 18 + Vite 5** | Fast modern UI, dark/light themes, grid/list views. |
| 3D preview | **three.js** loaders: GLTF/GLB, OBJ, FBX, Collada (DAE), STL, PLY | In-app interactive viewer; formats without a JS loader (BLEND) are delegated to external editors. |
| Database | **`node:sqlite`** (DatabaseSync) bundled in Node 22.13+/Electron 37 | Zero native addons → no ABI-rebuild step, trivially bundled in the installer, transactional SQL. The storage layer is isolated behind `core/db` so the engine can be swapped. |
| HTTP | Node `fetch` (undici) | Redirect/timeout control, no external deps. |
| Image ops | **Jimp** (pure JS) | Texture resize/compress without native deps. |
| Packaging | **electron-builder** → NSIS installer `UniversalGameAssetHub-Setup.exe` + portable exe | Start-menu/desktop shortcuts, uninstaller, file associations, bundled runtime. |
| CI | GitHub Actions `windows-latest` | Produces the signed-optional installer artifact on every tag. |

Electron 37 embeds Node 22.16+, so `node:sqlite` is available inside the packaged app.
The app therefore ships **no native module ABI risk** — the most common cause of
broken Electron installs.

### Alternate run modes

The core is Electron-free by design. It is also compiled into:

- **Server mode** (`npm run dev:web` / `UGAH_SERVER=1`): serves the identical renderer
  over HTTP with a REST + Server-Sent-Events bridge. Used for headless testing and for
  users who prefer a browser UI on localhost.
- **Test mode**: the whole core runs under vitest against **fixture HTTP responses**
  and **mock providers** — no external network access needed for the full test suite.

---

## 2. Process & layering

```
┌───────────────────────────────────────────────────────────────┐
│ Renderer (React)                                              │
│  pages: Home Search Sources Downloads Library Collections     │
│         Converters Projects Attributions Settings             │
│  components: AssetCard, LicenseBadge, Viewer3D (three.js)     │
├─────────────── ClientAPI (abstract transport) ────────────────┤
│   ElectronTransport (contextBridge IPC) │ HttpTransport (REST)│
├───────────────────────────────────────────────────────────────┤
│ Application services (core/services)                          │
│  SearchService · DownloadService · LibraryService ·           │
│  ConversionService · ExportService · AttributionService ·     │
│  ProjectService · SettingsService · DuplicateService          │
├───────────────────────────────────────────────────────────────┤
│ Core domain                                                    │
│  providers/* (16 connectors + mock)   licenses/* (registry)   │
│  net/* (HttpClient, RateLimiter, RobotsGuard)                  │
│  downloads/* (queue, resume, verify)                           │
│  db/* (schema, migrations, repositories, backup)               │
│  convert/* (OBJ/STL/PLY/GLTF pipelines + external adapters)    │
│  export/* (Unity/Unreal/Godot/Blender presets)                 │
│  attribution/* · library/* · util/* (logger, config, secrets)  │
└───────────────────────────────────────────────────────────────┘
```

Rules:
- `src/core/**` never imports `electron`. It compiles to CommonJS under
  `dist/core` and is consumed identically by main process, server mode and tests.
- The renderer never performs network I/O except through the ClientAPI bridge.
- Every provider lives in its own folder with its own fixtures; there is no shared
  scraper.

## 3. Provider architecture

```ts
interface AssetProvider {
  readonly id: string;                    // "polyhaven", "kenney", ...
  readonly displayName: string;
  readonly info: ProviderInfo;            // legal notes, docs URL, home URL
  readonly capabilities: ProviderCapabilities; // search/download/browse/manual/needsApiKey
  isConfigured(): boolean;                // API key present?
  search(q: SearchQuery): Promise<SearchPage>;
  getAsset(sourceId: string): Promise<Asset | null>;
  getLicense(asset: Asset): Promise<LicenseInfo>;
  getDownloadOptions(asset: Asset): Promise<DownloadOption[]>;
  getMetadata(asset: Asset): Promise<AssetMetadata>;
  download(option, dest, ctx): Promise<DownloadResult>;   // legal download only
  getPreviewUrls(asset: Asset): Promise<PreviewImage[]>;
  buildSearchUrl?(q: SearchQuery): string;                // manual providers
}
```

Three capability tiers, surfaced in the UI:

1. **`full`** — official API search + official download URLs (Poly Haven, AmbientCG,
   Sketchfab*, Poly Pizza*, BlenderKit*). (* = key-gated download; search may be open.)
2. **`hybrid`** — no official search API or robots-disallowed search path; the app
   opens the site's search in the user's browser, and supports **user-initiated
   import of a single content page** whose fetching is robots-permitted
   (OpenGameArt: content pages allowed, `Crawl-delay: 10` honoured).
3. **`manual`** — no public API and/or ToS prohibit automation (Kenney, Quaternius,
   KayKit, CGBookcase, itch.io, CGTrader, TurboSquid, Free3D, Mixamo, Fab). The app
   deep-links search + asset pages and provides a **Local Import wizard** where the
   user drops the file they downloaded themselves; license metadata is pre-filled
   from the site's blanket policy when one exists (e.g. Kenney = CC0) and can always
   be overridden per asset.

Manual/hybrid providers render the message:
> “Automated access is unavailable for this source. Open the official asset page to
> obtain it manually.”

and never attempt scraping.

### Network layer (`core/net`)

- `HttpClient`: single point for all outbound HTTP. Identifies itself with
  `User-Agent: UniversalGameAssetHub/<version> (+https://github.com/...)`, honours
  per-request timeouts, retries with exponential backoff + jitter (only on 429/5xx
  and network errors; **never** retries CAPTCHA/auth failures), 20 redirect cap,
  decompression, and `Accept-Encoding`.
- `RateLimiter`: token-bucket **per provider host** with conservative defaults
  (e.g. Poly Haven 1 req/1.5 s, OGA 1 req/12 s ≥ its 10 s crawl-delay). 429
  responses also set a hard cool-down for the host.
- `RobotsGuard`: for providers that touch HTML pages (not JSON APIs), fetches and
  caches `/robots.txt`, evaluates allow/disallow for our UA + `*`, honours
  `Crawl-delay`. Disallowed path → the request is refused locally with
  `RobotsDeniedError` and the UI falls back to the open-in-browser workflow.
- API-key routing: keys are injected per-provider at call time and are **scrubbed
  from every log line and error message** (`redact()` in the logger).

## 4. License intelligence

`core/licenses` contains a curated registry of every license the supported sources
actually serve (CC0, CC-BY 2/3/4, CC-BY-SA, CC-BY-NC variants, CC-PDDC, GPL 2/3,
OFL, Sketchfab Standard/Editor-remix, BlenderKit RF, poly.pizza CC-BY, OGA
"GPL/CC" combos, "unknown"). Each entry encodes:

- `commercialUse`: `allowed` | `conditions` | `forbidden` | `unknown`
- `attributionRequired`, `shareAlike`, `redistribution`, `modification`
- canonical name, SPDX-ish id, license URL, attribution template

Normalization accepts the exact strings each API returns (e.g. Sketchfab
`sketchfab-royaltyfree`, `cc0-1.0`; BlenderKit `cc0`/`royalty_free`). Anything
unrecognized becomes **License unknown** and the download manager **refuses to
start** that download (`LICENSE_UNKNOWN_BLOCK`), per spec. License state is stored
per asset with `licenseCheckedAt` and re-verified from the provider on demand.

Badges: 🟢 safe commercial · 🟡 commercial with conditions · 🔵 attribution
required · 🔴 non-commercial · ⚫ unknown.

## 5. Library & storage layout

```
<LibraryRoot>/                        (configurable; default Documents/UniversalGameAssetHub)
├── Assets/
│   ├── Characters/ Creatures/ Weapons/ Vehicles/ Buildings/ Environment/
│   │   Props/ Vegetation/ Materials/ Textures/ HDRIs/ Animations/ VFX/ Other/
│   │      └── <AssetName>_<id>/
│   │           ├── Original/         (never modified — read-only after verify)
│   │           ├── Processed/        (texture ops, mesh cleanups)
│   │           ├── GameReady/        (conversion outputs, LODs, collisions)
│   │           ├── preview.*         (cached previews)
│   │           └── asset.json        (portable per-asset metadata copy)
├── Collections/                      (user collections: symlinks/copies + JSON)
├── Projects/                         (export presets & export history)
├── attributions/                     (generated ATTRIBUTIONS.txt/.md)
├── cache/                            (HTTP cache, thumbnails)
└── UGAH.db                           (SQLite; backups in UGAH/backups/)
```

Auto-categorization: provider `assetType` mapping first (HDRI/texture/model→tags),
then keyword scoring over name/tags/category (sword→Weapons, tree→Vegetation,
etc.), with manual override persisted in `assets.categoryOverride`.

Duplicate detection (`core/library/duplicates.ts`): sha256 file hash, md5 (Poly
Haven provides md5), perceptual aHash/dHash of previews (Jimp), normalized
filename similarity (Dice coefficient), source-URL identity, and a geometry
fingerprint (vertex/face counts + bbox dimensions + vertex-count-normalized hash
sample) computed at import/conversion time. Matches are grouped into
`duplicate_groups` and displayed as “Possible duplicate” instead of silently
re-downloading.

Versioning: re-downloads/imports of the same logical asset create
`Original/v2/`, `v3/…`; `assets.currentVersion` points at the active one; old
versions remain on disk with their hashes until pruned.

## 6. Download manager

- Durable **queue table** in SQLite (`download_tasks`) → crash-safe: on restart the
  manager resumes `running` tasks whose partial file + size are consistent
  (HTTP `Range` resume when the server supports it; otherwise restart cleanly).
- Concurrency: global limit (default 3) **and** per-host limit (default 1–2),
  mediated by the per-host rate limiter.
- Operations: enqueue, pause (whole queue / per task), resume, cancel, retry
  (bounded, backoff), priority.
- Pre-flight checks: license gate (see §4), duplicate gate, **disk-space check**
  (`fs.statfs` vs. required bytes × safety factor), destination writability.
- Integrity: sha256 always; md5 when the provider publishes one (Poly Haven);
  corrupted/mismatched files are quarantined into `cache/quarantine/` and the task
  marked `corrupt` for retry.
- Progress: streamed to renderer (IPC event / SSE in server mode) with bytes,
  total, speed, ETA.

## 7. Conversion pipeline

`core/convert` implements a **real** mesh pipeline in TypeScript:

- **Parsers**: OBJ (+MTL), STL (binary+ASCII), PLY (binary_little_endian + ASCII),
  glTF 2.0 JSON/GLB container.
- **Writers**: GLB, GLTF (external buffers), OBJ (re-export).
- **Ops**: texture resize/compress/rename (Jimp), unused-material & empty-node
  pruning, primitive re-indexing, normal recompute, Y-up↔Z-up conversion,
  embedded↔external texture management, bounding box + stats extraction,
  simple LOD via percentage-based decimation (vertex clustering), collision
  proxies (bounding box / convex-hull-free "shrinkwrap" copy / decimated copy).
- **External adapters** (optional, auto-detected, configured in Settings):
  `assimp` (FBX/DAE→glTF), `blender` headless (BLEND→glTF, quality decimate,
  UE/Unity-friendly axis conversion). The UI shows adapter availability honestly.

The pipeline never writes into `Original/` — outputs go to `Processed/` and
`GameReady/` only.

## 8. Export system

`core/export/presets.ts`: Unity (`<Project>/Assets/<Category>`, .meta untouched),
Unreal (`Content/<Category>`, glTF import notes), Godot (`res://` import-ready
layout, notes on `.import` regeneration), Blender (raw layout). Collision policy:
`ask` (default — modal per conflicting file; batch dialog offers skip-all /
rename-all / overwrite-all), `skip`, `rename`, `overwrite`. Exports are recorded in
`export_history` with the exact files written for clean rollback.

## 9. Attribution engine

Any export/collection can generate `ATTRIBUTIONS.txt` and `ATTRIBUTIONS.md`
per project using each license's attribution template
(`<name> by <creator> — <source> — <license> — <url> — license URL`). CC0 assets
are listed in a separate "no attribution required" section for courtesy credit.
The Projects page keeps per-project attribution snapshots.

## 10. Security & credentials

- API keys are **never** in source, logs, or the DB in plaintext. Desktop: Electron
  `safeStorage` (Windows DPAPI / macOS Keychain / Linux libsecret via keyring
  fallback to an encrypted local file with warning). Server/test: encrypted file
  (AES-256-GCM, key derived from a machine-local secret) with a loud warning banner.
- CSP is set on the renderer; `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`, custom `webSecurity` kept on. External links open via
  `shell.openExternal` only.
- No telemetry. Crash reports stay local (`logs/`), rotated, with credential
  scrubbing.

## 11. Reliability

Structured JSON logging (leveled, rotating, redacted) · global error boundaries ·
DB `PRAGMA journal_mode=WAL` + `synchronous=NORMAL`, transactions for all
multi-statement writes · automatic SQLite backup (rolling, on start and daily) ·
config backup (versioned JSON) · download manager crash recovery (§6) · safe
shutdown (SIGTERM/SIGINT handlers flush queue + close DB) · corruption detection
(hash mismatch, zip/glb magic-byte validation, partial-file detection on startup).

## 12. Testing strategy

- **Unit + fixture tests** (`npm test`, vitest): every provider against recorded
  fixture JSON; license normalization matrix; download manager with a local mock
  HTTP server (pause/resume/interrupt/Range/hash/corruption); duplicates; DB
  migrations & repos; conversion golden files; attribution snapshot; export
  presets; config/secrets redaction.
- **Mock providers**: `MockProvider` + fixture catalog drive the whole app
  (`UGAH_FORCE_MOCK=1`) — full UI demo without network.
- **Live integration tests** (`npm run test:live`, opt-in): same provider tests
  against the real APIs (skipped unless `UGAH_LIVE_API_TESTS=1`) — documented for
  CI and developers with normal internet access.

## 13. Windows installer

electron-builder NSIS target produces `UniversalGameAssetHub-Setup.exe`
(`oneClick: false` → assisted installer: license page, install-dir choice, per-user
or all-users) + `UniversalGameAssetHub.exe` portable. Includes Start-Menu shortcut,
optional desktop shortcut, uninstaller, file associations for `.ugahcollection` /
`.ugahproject`, and an on-first-run library-location picker. All runtime deps
(Chromium, Node, three.js, app code) are bundled — users do not install Node,
Python or anything else manually. `GitHub Actions` workflow
`.github/workflows/windows-installer.yml` builds and attaches the installer for
every tag; the same command (`npm run dist:win`) works locally on Windows.
