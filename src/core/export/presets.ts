/**
 * Game-engine export (spec §8): Unity/Unreal/Godot/Blender presets, per-game
 * project records, conflict policy (never overwrite silently), export history
 * and per-project ATTRIBUTIONS files.
 */

import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import type {
  EngineId, ExportPreset, ExportRequest, ExportResult, LibraryAsset,
} from '../types';
import { AssetsRepo, ProjectsRepo } from '../db/repositories';
import { generateAttribution } from '../attribution';
import { ensureDir, atomicWriteFile, pathExists, safeFileName } from '../util/fsutil';
import { rootLogger } from '../util/logger';

const log = rootLogger.child('export');

export const EXPORT_PRESETS: Record<EngineId, ExportPreset> = {
  unreal: {
    id: 'unreal', name: 'Unreal Engine', rootDirName: 'Content',
    preferredFormats: ['glb', 'fbx', 'png'],
    notes: 'Copies into <Project>/Content/<Category>. Import glTF via Interchange (UE5); textures keep PBR suffix naming.',
  },
  unity: {
    id: 'unity', name: 'Unity', rootDirName: 'Assets',
    preferredFormats: ['glb', 'gltf', 'fbx', 'png'],
    notes: 'Copies into <Project>/Assets/<Category>. Unity 2022+ imports glTF via a glTF importer package; existing .meta files are never touched.',
  },
  godot: {
    id: 'godot', name: 'Godot', rootDirName: '',
    preferredFormats: ['glb', 'gltf', 'png'],
    notes: 'Copies next to project.godot; Godot 4 imports GLTF natively and will generate .import files on first open.',
  },
  blender: {
    id: 'blender', name: 'Blender', rootDirName: '',
    preferredFormats: ['glb', 'gltf', 'obj', 'blend'],
    notes: 'Plain folder layout; open or link the files directly.',
  },
};

export class ExportService {
  constructor(
    private readonly assets: AssetsRepo,
    private readonly projects: ProjectsRepo,
  ) {}

  /** Non-destructive copy of chosen assets into an engine layout. */
  async export(req: ExportRequest, resolveConflicts: (c: ExportResult['conflicts']) => Promise<'skip' | 'rename' | 'overwrite'>): Promise<ExportResult> {
    const preset = EXPORT_PRESETS[req.engine];
    const result: ExportResult = { ok: true, exported: [], skipped: [], conflicts: [], attributionFiles: [] };
    const root = req.projectName
      ? path.join(req.exportRoot, req.projectName, preset.rootDirName)
      : path.join(req.exportRoot, preset.rootDirName);
    await ensureDir(root);

    // Gather files per asset.
    const plan: { asset: LibraryAsset; files: string[] }[] = [];
    for (const id of req.assetIds) {
      const a = this.assets.get(id);
      if (!a) { result.skipped.push(id); continue; }
      const dir = req.source === 'gameReady' ? (a.gameReadyDir ?? a.originalDir) : req.source === 'processed' ? (a.processedDir ?? a.originalDir) : a.originalDir;
      const files = (await listFilesDeep(dir)).filter((f) => !f.endsWith('asset.json'));
      plan.push({ asset: a, files });
    }

    // Conflict detection (never overwrite without confirmation).
    const conflicts: ExportResult['conflicts'] = [];
    const planned: { asset: LibraryAsset; src: string; dest: string }[] = [];
    for (const { asset, files } of plan) {
      const destDir = path.join(root, safeFileName(asset.category));
      await ensureDir(destDir);
      for (const src of files) {
        const dest = path.join(destDir, path.basename(src));
        if (await pathExists(dest)) {
          conflicts.push({
            intendedPath: dest,
            existingSize: (await fsp.stat(dest)).size,
            newSize: (await fsp.stat(src)).size,
          });
        }
        planned.push({ asset, src, dest });
      }
    }
    let policy = req.collisionPolicy;
    if (conflicts.length && policy === 'ask') {
      policy = await resolveConflicts(conflicts);
    }
    for (const { asset, src, dest } of planned) {
      const exists = await pathExists(dest);
      if (exists) {
        if (policy === 'skip') { result.skipped.push(asset.id); continue; }
        if (policy === 'rename') {
          const ext = path.extname(dest);
          const renamed = dest.replace(new RegExp(`\\${ext}$`), `_${Date.now().toString(36)}${ext}`);
          await fsp.copyFile(src, renamed);
          pushFile(result, asset, renamed);
          continue;
        }
        if (policy !== 'overwrite') { result.skipped.push(asset.id); continue; }
      }
      await fsp.copyFile(src, dest);
      pushFile(result, asset, dest);
      this.assets.update(asset.id, { lastUsedAt: new Date().toISOString() });
    }

    // Attribution files always accompany an export (spec §12).
    const exportedAssets = result.exported.map((e) => this.assets.get(e.assetId)!).filter(Boolean);
    if (exportedAssets.length) {
      const doc = generateAttribution(exportedAssets);
      const dir = path.dirname(root);
      if (req.engine === 'unity' || req.engine === 'unreal' || req.engine === 'godot' || req.engine === 'blender') {
        await atomicWriteFile(path.join(dir, 'ATTRIBUTIONS.txt'), doc.txt);
        await atomicWriteFile(path.join(dir, 'ATTRIBUTIONS.md'), doc.md);
        result.attributionFiles.push(path.join(dir, 'ATTRIBUTIONS.txt'), path.join(dir, 'ATTRIBUTIONS.md'));
      }
    }

    this.projects.recordExport(null, req.engine, req.exportRoot, result.exported.flatMap((e) => e.files));
    log.info('export finished', { engine: req.engine, assets: result.exported.length, skipped: result.skipped.length });
    return result;
  }
}

function pushFile(result: ExportResult, asset: LibraryAsset, file: string): void {
  const entry = result.exported.find((e) => e.assetId === asset.id);
  if (entry) entry.files.push(file);
  else result.exported.push({ assetId: asset.id, files: [file] });
}

async function listFilesDeep(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries: import('node:fs').Dirent[];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(dir);
  return out;
}
