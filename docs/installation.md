# Installation

## Requirements

- **Node.js 22.13+** (the core uses the built-in `node:sqlite`)
- npm 10+
- Any OS: Windows 10/11, macOS, or Linux
- Optional for extra conversion formats: [assimp] or [Blender] on your PATH
  (or configured per-path)

[assimp]: https://github.com/assimp/assimp
[Blender]: https://www.blender.org/download/

## Option A — Windows desktop app (end users)

1. Download **`UniversalGameAssetHub-Setup.exe`** from the GitHub releases, or
   build it on any Windows machine:

   ```powershell
   npm install
   npm run dist:win     # → dist\UniversalGameAssetHub-Setup.exe (+ Portable.exe)
   ```

2. Run the installer. It bundles the full runtime (Chromium + Node) — nothing
   else to install. Shortcuts, file associations (`.ugahcollection`,
   `.ugahproject`) and an uninstaller are included.

The desktop app and the CLI share the same core, configuration, database and
library — you can use both against the same data directory.

## Option B — CLI from source (all platforms)

```bash
git clone https://github.com/studyforge0169-cpu/3D-game-package
cd 3D-game-package
npm install
npm run build
```

Then either link it globally:

```bash
npm link          # puts `asset-hub` on your PATH
asset-hub --help
```

or run it via npm scripts / node directly:

```bash
npm run cli -- search "castle" --cc0
node bin/asset-hub.js --help
```

## Option C — install as a package

```bash
npm install -g .   # from a checkout
asset-hub --help
```

## First-run setup

1. Pick a library location (default `~/Documents/UniversalGameAssetHub`):

   ```bash
   asset-hub config set libraryDir /path/to/GameAssets
   ```

2. (Optional) add your own free API keys — Sketchfab, Poly Pizza, BlenderKit.
   Keys are stored in OS credential storage (Windows Credential Manager /
   macOS Keychain / libsecret; encrypted-file fallback on headless boxes),
   never in config files or logs:

   ```bash
   asset-hub key list                          # providers + where to get keys
   asset-hub key set sketchfab <your-token>
   ```

3. Try it:

   ```bash
   asset-hub sources
   asset-hub search "medieval castle" --cc0
   asset-hub download polyhaven:<asset-id>
   ```

## Offline demo mode

```bash
asset-hub --fixtures search castle
```

Runs the whole pipeline (search → download → library → export) against a
bundled fixture provider with no network access — useful for CI, demos, and
trying the workflow before configuring anything.

## Uninstall

- CLI: `npm uninstall -g universal-game-asset-hub` (or remove the link), then
  optionally delete `~/.universal-game-asset-hub` (config + database) and your
  library directory.
- Desktop app: use the included uninstaller.
