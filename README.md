# Universal Game Asset Hub

**One legal, unified asset manager for game developers.** Discover, license-check,
download, organize, verify, convert and install 3D game assets from major public
asset libraries — through each site's *official* access mechanism.

> 🧊 Search official APIs → 📋 verify per-asset licenses → ⬇ download permitted
> assets → 📂 organize → ⚙ convert to game-ready formats → 🎮 export to your
> engine → © ship with correct attributions.

**The app never bypasses paywalls, DRM, authentication, CAPTCHAs, rate limits,
robots.txt or API restrictions.** Where a source permits automated access, UGAH
integrates its real API. Where it doesn't, UGAH opens the official page in your
browser and offers a compliant manual-import workflow instead.

---

## Feature highlights

| Area | What you get |
|---|---|
| **16 source connectors** | Poly Haven, AmbientCG, Sketchfab, Poly Pizza, BlenderKit (full API) · OpenGameArt (hybrid, robots-compliant) · Kenney, Quaternius, KayKit, CGBookcase, itch.io, CGTrader, TurboSquid, Free3D, Mixamo, Fab (manual/browser workflow) |
| **License intelligence** | Per-asset license from official APIs; 🟢🟡🔵🔴⚫ badges; unknown licenses **block downloads**; license-details screen with check date |
| **Search** | Unified multi-source search with filters (source, free/CC0/commercial/attribution, format, poly count, texture res, PBR, rigged, animated, topics) and 7 sort orders |
| **Library** | Auto-categorized taxonomy (Characters…VFX), favorites, tags, collections, versions, duplicates (sha256 + perceptual + metadata + geometry fingerprints), fully **offline** after download |
| **3D viewer** | GLB/GLTF/OBJ/STL/PLY/FBX/DAE with wireframe, bbox, skeleton, animation playback, lighting, poly/texture stats |
| **Conversion pipeline** | Real OBJ/STL/PLY→GLB/GLTF/OBJ, texture resize/compress, weld/normals/prune, LOD generation, collision proxies; optional assimp/Blender adapters for FBX/BLEND; **Original/Processed/GameReady separation — originals never modified** |
| **Export** | Unity / Unreal / Godot / Blender presets, per-project locations, **never overwrites without confirmation**, automatic ATTRIBUTIONS.txt/md |
| **Batch downloads** | Durable queue with pause/resume/cancel/retry, crash recovery, Range resume, per-host rate limits, disk-space checks, duplicate gates, sha256+md5 verification |
| **Security** | API keys in OS credential storage (DPAPI/Keychain/libsecret), credential-scrubbed logs, sandboxed renderer |
| **Reliability** | SQLite (WAL, transactions, rolling backups), config backups, structured logging, corrupted-file quarantine, safe shutdown |

## Install (Windows)

1. Download **`UniversalGameAssetHub-Setup.exe`** from the GitHub releases,
   or build it yourself on any Windows machine with:

   ```powershell
   npm install
   npm run dist:win     # → dist\UniversalGameAssetHub-Setup.exe (+ Portable.exe)
   ```

2. Run the installer: choose per-user/all-users + install directory, optional
   desktop shortcut, Start-Menu shortcut and uninstaller are included, file
   associations for `.ugahcollection` / `.ugahproject` are registered, and the
   full runtime (Chromium + Node) is bundled — **no Python/Node setup needed**.

3. First launch: pick your asset-library location (default
   `Documents\UniversalGameAssetHub`). Optional: add your own free API keys in
   **Settings → API keys** (Sketchfab, Poly Pizza, BlenderKit) — stored in
   Windows credential storage, never in files or logs.

## Run from source (developers)

```bash
npm install                # dev: set ELECTRON_SKIP_BINARY_DOWNLOAD=1 on CI
npm test                   # full offline test suite (96 tests)
npm run test:live          # opt-in live API verification
npm run dev:electron       # desktop app (electron)
npm run dev:web            # browser UI on http://localhost:8765
npm run dist:win           # Windows installer + portable exe
```

## Documentation

| Doc | Contents |
|---|---|
| [docs/USER_MANUAL.md](docs/USER_MANUAL.md) | Everyday usage: search → download → convert → export → credit |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technical architecture, layers, data flow |
| [docs/SOURCE_COMPATIBILITY_MATRIX.md](docs/SOURCE_COMPATIBILITY_MATRIX.md) | Per-source API/licensing/automation matrix (verified) |
| [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) | Building, testing, adding providers |
| [docs/LEGAL_AND_LICENSING.md](docs/LEGAL_AND_LICENSING.md) | What the app does and doesn't allow; your obligations |

## Legal stance (short version)

- Every asset keeps **its own license** — UGAH shows and enforces it per asset,
  not per site. Paid assets are never fetched; unknown licenses never download.
- Sources without public APIs get a browser workflow, not a scraper. Rate
  limits and robots.txt are honored (OpenGameArt: 10 s crawl-delay on its
  robots-permitted content pages; search stays manual by design).
- Downloads use official endpoints with **your** credentials where required
  (Sketchfab token, BlenderKit key, Poly Pizza key). Nothing is uploaded; the
  app contains no telemetry.

License: Apache-2.0 (application code). See [LICENSE](LICENSE) and
[docs/LEGAL_AND_LICENSING.md](docs/LEGAL_AND_LICENSING.md).
