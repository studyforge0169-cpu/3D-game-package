# Universal Game Asset Hub — Developer Guide

How to build, test, debug and extend the app. Read `docs/ARCHITECTURE.md`
first for the layer model; this file is the hands-on companion.

## Repo layout

```
src/
  core/            # engine-agnostic TypeScript library (no Electron imports)
    types.ts       # AssetProvider, LicenseInfo, DownloadOption, DTOs…
    providers/     # one file per connector + registry.ts + manual.ts + mock.ts
    services/      # hub.ts (facade), search.ts, downloads/, library.ts,
                   #   licenses.ts, convert/, export/, attribution, projects…
    net/           # HttpClient with rate limiting, robots.txt cache, UA policy
    db/            # SQLite schema + migrations + backup
    util/          # config, hashing, logging (credential-scrubbed), paths
  main/            # Electron main process (window, IPC, safeStorage, dialogs)
  preload/         # contextBridge: window.hubBridge {invoke, on}  (allowlisted)
  renderer/        # React + Vite UI (10 pages, three.js viewer, CSP'd)
  server/          # server-mode entry: same UI + POST /api/:method + SSE
tests/             # vitest suites (offline, 96 tests) + live-api (opt-in)
build/             # vite renderer output + app icon
electron-builder.yml, windows-installer.yml, installer.nsh
```

## Prerequisites

- Node.js **20.11+** (22 recommended; `node:sqlite` experimental warning is expected)
- npm 10+
- Windows 10/11 for installer builds (`npm run dist:win`); everything else
  (dev, test, server mode) runs on macOS/Linux too.

## Commands

```bash
npm install                # CI/Linux: ELECTRON_SKIP_BINARY_DOWNLOAD=1 first
npm run typecheck          # both tsconfigs (renderer + main/core/server)
npm test                   # offline suite (96 tests, no network)
npm run test:live          # opt-in live API verification (needs egress)
npm run dev:electron       # desktop app w/ hot reload
npm run dev:web            # browser mode → http://localhost:8765
npm run build              # renderer (vite) + main/core/server (tsc)
npm run dist:win           # → dist/UniversalGameAssetHub-Setup.exe
```

`dev:web` / server mode env vars: `UGAH_PORT` (default 8765),
`UGAH_BIND_ALL=1` (bind 0.0.0.0), `UGAH_FIXTURES=1` (mock provider in the
normal provider list — demo mode).

## Testing conventions (important)

- **Offline by default.** The default suite must pass with no network. Provider
  behavior is tested through `MockProvider` and the fixture system; HTTP layers
  through injected fake transports.
- **Fresh IDs for async waits** — download `waitFor` tests must create a new
  asset id per test (ids are globally unique in the DB).
- **Disk-refusal tests** use `Number.MAX_VALUE` as required size to force the
  space check to fail.
- **Duplicate tests** must seed real duplicate files before `scanDuplicates`.
- **Live tests** (`tests/live-api.test.ts`) are `describe.skipIf`-gated behind
  `UGAH_RUN_LIVE_TESTS=1` and only do anonymous search/metadata calls.

## Adding a provider

1. **Verify automation permission first** — check the source's API docs,
   robots.txt, and ToS. Update `docs/SOURCE_COMPATIBILITY_MATRIX.md` with
   evidence. If there is no public API or it forbids automation, add a
   `ManualProvider` spec in `src/core/providers/manual.ts` instead. **Never
   invent endpoints.**
2. Implement `AssetProvider` (extends `BaseProvider`):

   ```ts
   export class MyProvider extends BaseProvider {
     info = { id: 'mysource', name: '…', homeUrl: '…', tier: 'full',
             capabilities: { search: true, download: true, perAssetLicense: true } };
     async search(q: SearchQuery): Promise<SearchPage> { … }
     async getAsset(id: string): Promise<Asset> { … }          // incl. license!
     async getLicense(id: string): Promise<LicenseInfo> { … }
     async getDownloadOptions(id: string): Promise<DownloadOption[]> { … }
     async getMetadata(id: string): Promise<AssetMetadata> { … }
     async download(option, sink, opts): Promise<DownloadResult> { … }
     async getPreview(id, kind): Promise<PreviewResult> { … }
   }
   ```

3. Register it in `src/core/providers/registry.ts` (+ `PROVIDER_IDS`).
4. Rules baked into review:
   - `license.id === 'unknown'` ⇒ the download service hard-blocks
     (`LICENSE_UNKNOWN_BLOCK`). Don't paper over it.
   - If credentials are needed, read them via the secrets service (`getSecret`)
     — never from config files — and throw a *configure-your-key* error when
     absent. Never log values.
   - Respect rate limits: use the shared `HttpClient` (it enforces per-host
     pacing + robots.txt), set `info.rateLimit` when the source documents one.
   - Map real license URLs; don't guess SPDX ids.
5. Add tests: mapping unit tests with recorded fixture JSON (see existing
   provider tests), plus registry inclusion.

## Renderer notes

- `src/renderer/api.ts` defines the `ClientApi` interface; `ElectronApi`
  (via `window.hubBridge`) and `HttpApi` (`POST /api/:method {args:[…]}`)
  both implement it. **Adding an API method requires three edits:** `hub.ts`
  facade, `api.ts` (+ both impls), `main.ts` IPC handler, `server.ts` dispatch,
  `preload/index.ts` channel allowlist if it's an event.
- Strict mode: provider DTO fields typed `unknown` must be coerced
  (`String(...)`) before rendering as ReactNode.
- The three.js viewer lives in `Viewer3D.tsx`; loaders are dynamically imported
  per format.

## Debugging

- Logs (credential-scrubbed) go to the console and to the app-data log dir —
  see `src/core/util/logger.ts` for paths. `UGAH_LOG_LEVEL=debug` for verbosity.
- Server mode: `curl -X POST localhost:8765/api/providerInfos -d '{}'` style
  calls exercise the whole backend without the UI.
- Database: SQLite WAL file next to the library dir; `npm run db:inspect`
  (if present) or any sqlite browser. Backups: Settings → Database.

## Release checklist

1. `npm run typecheck && npm test && npm run build` — all green.
2. `npm run dist:win` on Windows; smoke-test the installer + portable exe
   (install, launch, search, download one CC0 asset, convert, export, uninstall).
3. Tag `vX.Y.Z`; the `windows-installer.yml` workflow builds and attaches
   `UniversalGameAssetHub-Setup.exe` to the GitHub release.
4. Update `CHANGELOG` notes in the release body; matrix/doc changes belong in
   the same PR when provider behavior changed.
