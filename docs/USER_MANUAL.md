# Universal Game Asset Hub — User Manual

Welcome! This guide walks you through everything the app can do, in the order
you will actually use it. A 30-second orientation first:

> **UGAH never downloads anything without checking that asset's individual
> license first.** If a license is unknown, the download button is disabled —
> that is a safety feature, not a bug.

---

## 1. First launch

1. **Library location** — Settings → *Library directory*. Default:
   `Documents\UniversalGameAssetHub`. This folder holds every downloaded asset
   plus the metadata database. Everything works **offline** once downloaded.
2. **(Optional) API keys** — Settings → *API keys*. Paste your own free keys
   for Sketchfab / Poly Pizza / BlenderKit. They are stored in your OS
   credential vault (Windows: Credential Manager via DPAPI), never in plain
   files and never written to logs. Each key row shows a direct "get a key" link.
3. **Theme** — Settings → *Theme* (dark/light) or the toggle in the header.

## 2. Home & Search

- **Home** shows quick stats (library size, active downloads, recent adds).
- **Search** queries all enabled sources at once. Type terms like
  `medieval castle`, `AK-style rifle`, `zombie`, `space station`.
  - Filters: source, license (free / CC0 / commercial-use / attribution),
    format, poly count, texture resolution, PBR, rigged, animated, topic.
  - Sorts: relevance, quality, popularity, poly count, resolution, size, newest.
- Each result card shows the **license badge**:
  🟢 commercial-safe · 🟡 conditional · 🔵 attribution-required ·
  🔴 non-commercial · ⚫ unknown
- Click a card for the **asset detail view**: license screen (full text, URL,
  verification date), preview, metadata, per-file download options with sizes,
  and the source page link.

### Why do some sources have no search results?

Sources without a public API (Kenney, TurboSquid, Mixamo, …) are listed under
**Sources** as *Manual workflow*. The app opens their official search page in
your browser and offers **Import** (§5) to bring the file into your library
with a license you confirm. This is deliberate compliance — we don't scrape
sites that don't permit it, and we don't pretend otherwise.

## 3. Downloads

- **Batch enqueue** from search results (multi-select) or a single asset page.
- The **Downloads** page shows the queue: pause / resume / cancel / retry,
  concurrency and speed limits (Settings → Downloads).
- Safety rails built in:
  - disk-space check before starting;
  - sha256/md5 verification against the source's checksums;
  - automatic resume (HTTP Range) after interruption;
  - per-host rate limiting and robots.txt compliance;
  - corrupted files quarantined, never silently kept;
  - **unknown license ⇒ download blocked**;
  - duplicate detection: if you already have this exact file (by hash), the
    task resolves as `duplicate` instead of re-downloading.

## 4. Library

- Auto-categorized tree: Characters, Environment, Props, Vehicles, Weapons,
  Furniture, Nature, Materials, HDRI, Audio, VFX, Other.
- Grid or list view; filter by favorites, tags, collections, license type.
- Click an asset to open the **3D viewer** (GLB/GLTF/OBJ/FBX/STL/DAE/PLY):
  rotate / pan / zoom, wireframe, bounding box, skeleton, animation playback,
  HDRI lighting, and live stats (triangles, vertices, materials, textures).
- Right-side actions: **Verify integrity** (re-hash the files against the
  download records), open folder, remove (originals are deleted only from the
  library directory — never from arbitrary folders).
- **Versions**: re-downloading a newer version of an existing asset creates a
  new version entry; old versions are kept. **Duplicates view**: grouped by
  file hash, perceptual image hash, geometry fingerprint, filename and source
  URL — review and remove redundant copies.
- **Collections** page: curate sets (e.g. "Desert level") and preview the
  combined attribution requirements before export.

## 5. Importing manually-obtained assets

For sources marked *Manual workflow* (or your own files):

1. Library → **Import**.
2. Pick the file(s) and the source you got them from.
3. **Choose the license — this step is mandatory.** The import is refused if
   you can't identify a license; typical options are pre-filled (e.g. CGBookcase
   = CC0). If unsure, click *check the asset page* first.
4. The file is copied into the library (original untouched), hashed, and
   indexed like any downloaded asset.

## 6. Converters

The Converters page processes library assets while **never modifying
originals** — outputs go to separate `Processed`/`GameReady` areas.

- Formats: OBJ/STL/PLY → GLB/GLTF/OBJ natively; FBX/BLEND → via external
  converters if installed (the page shows honest availability badges and
  Settings has fields for assimp/Blender paths — nothing is faked).
- Options: target format, texture resize/compression, weld vertices, compute
  normals, prune unused data, **LOD generation** (decimation chain), and
  **collision proxy** generation (bounding box / convex hull / simplified
  trimesh).
- Results are shown with size/triangle deltas; each run is recorded.

## 7. Projects & engine export

1. Projects → **New project**: pick engine preset (Unity / Unreal / Godot /
   Blender), project name, export root, default collision policy.
2. Select library assets → **Export**. Choose which variants to include
   (Original / Processed / GameReady), per-asset collision policy, and confirm.
3. Files are placed in the engine-correct layout (e.g. Unity `Assets/<Category>`,
   Unreal `Content/<Category>`, Godot `res://assets/<category>`).
4. **Overwrite protection**: if a file already exists, a conflict dialog offers
   Skip / Keep both (rename) / Overwrite — for each conflicting set. Exports
   never silently overwrite.
5. Every export writes **`ATTRIBUTIONS.txt` and `ATTRIBUTIONS.md`** into the
   project root, grouped by attribution requirement. Ship these with your game.

## 8. Attributions

The Attributions page builds credit lists from any selection of library assets
(txt + markdown, grouped: attribution-required first). Use "select all
non-CC0" as a quick audit. Save directly into a project folder.

## 9. Settings reference

| Section | What it controls |
|---|---|
| Theme | dark / light |
| Library directory | where assets + database live (moving is guided, originals preserved) |
| API keys | per-source keys, OS-credential-stored, never logged |
| Downloads | concurrency, speed limit, retries, disk-space reserve |
| Converters | assimp / Blender executable paths for extended formats |
| Database | backup now / restore, automatic backup count |

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| "Automated access is unavailable for this source" | By design. Use the *open official page* button + manual Import. |
| Download stuck in `blocked_license` | The asset's license couldn't be verified. Open the asset page; if a license exists but differs, re-search to refresh it. |
| Verification failed after download | File was corrupted in transit; the task auto-retries; the corrupt copy is quarantined. |
| FBX conversion unavailable | Install assimp or Blender and set the path in Settings → Converters. |
| Two entries for the same asset | Check the Duplicates view (hash/fingerprint groups) and remove the extra. |

---

*Legal notes for users: see `docs/licensing.md`. You are responsible
for complying with each asset's license — UGAH surfaces and enforces the
license data the source provides, and always credits it.*
