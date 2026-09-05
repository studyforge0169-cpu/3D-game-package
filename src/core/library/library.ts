/**
 * Local asset library (spec §5, §15): folder taxonomy, asset folders with
 * Original/Processed/GameReady separation, versioning, metadata sidecars,
 * favorites/tags/collections, duplicate detection, offline operation.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  AssetCategory, AssetKind, AssetRef, LibraryAsset,
} from '../types';
import { ASSET_CATEGORIES } from '../types';
import { AssetsRepo, uuid } from '../db/repositories';
import { ensureDir, pathExists, safeFileName, atomicWriteFile, moveFile } from '../util/fsutil';
import { aHashFile, dHashFile, sha256File, md5File, diceSimilarity } from '../util/hash';
import { sniffFormat } from '../util/fsutil';
import { categorize } from './categorize';
import { formatAttribution, LICENSE_REGISTRY, resolveDefinition } from '../licenses/registry';
import { rootLogger } from '../util/logger';

const log = rootLogger.child('library');

export class LibraryService {
  constructor(
    private readonly rootDir: string,
    private readonly assets: AssetsRepo,
  ) {}

  get assetsDir(): string { return path.join(this.rootDir, 'Assets'); }

  /** Create the taxonomy skeleton (idempotent). */
  async init(): Promise<void> {
    await ensureDir(this.assetsDir);
    for (const cat of ASSET_CATEGORIES) await ensureDir(path.join(this.assetsDir, cat));
    await ensureDir(path.join(this.rootDir, 'Collections'));
    await ensureDir(path.join(this.rootDir, 'Projects'));
    await ensureDir(path.join(this.rootDir, 'attributions'));
    await ensureDir(path.join(this.rootDir, 'cache'));
  }

  categoryDir(cat: AssetCategory): string {
    return path.join(this.assetsDir, cat);
  }

  private async assetDirName(asset: { name: string; id: string }): Promise<string> {
    return safeFileName(`${asset.name}_${asset.id.slice(0, 8)}`);
  }

  async createAssetFolder(category: AssetCategory, name: string, id: string): Promise<{ dir: string; original: string; processed: string; gameReady: string }> {
    const dir = path.join(this.categoryDir(category), await this.assetDirName({ name, id }));
    const original = path.join(dir, 'Original');
    const processed = path.join(dir, 'Processed');
    const gameReady = path.join(dir, 'GameReady');
    await ensureDir(original);
    await ensureDir(processed);
    await ensureDir(gameReady);
    return { dir, original, processed, gameReady };
  }

  /**
   * Register a downloaded/imported file as a library asset (used both by the
   * download manager and the manual Local Import wizard).
   */
  async register(opts: {
    file: string;              // file already on disk (Original/)
    asset: AssetRef;
    category?: AssetCategory;  // override
    sha256?: string;
    md5?: string;
    attributionText?: string;
    licenseCheckedAt?: string;
    downloadedAt?: Date;
  }): Promise<LibraryAsset> {
    const category = opts.category ?? categorize(opts.asset);
    const id = uuid();
    const folders = await this.createAssetFolder(category, opts.asset.name, id);
    // Move the file into Original/ (never modified afterwards).
    const ext = path.extname(opts.file) || '.zip';
    const dest = path.join(folders.original, safeFileName(`${opts.asset.name}${ext}`));
    await moveFile(opts.file, dest);

    const sha = opts.sha256 ?? (await sha256File(dest).catch(() => undefined));
    const md5 = opts.md5 ?? (await md5File(dest).catch(() => undefined));
    const stat = await fs.stat(dest).catch(() => ({ size: 0 } as { size: number }));
    const buf = Buffer.alloc(Math.min(16, stat.size));
    try {
      const fh = await fs.open(dest, 'r');
      await fh.read(buf, 0, buf.length, 0);
      await fh.close();
    } catch { /* empty */ }
    const sniffed = sniffFormat(buf);
    const format = (ext.replace('.', '').toLowerCase()) || sniffed || 'bin';

    const def = resolveDefinition(opts.asset.license.id === 'unknown' ? undefined : opts.asset.license.id);
    const attributionText = opts.attributionText ?? (def.id === 'unknown'
      ? 'LICENSE UNKNOWN — do not ship before confirming terms'
      : formatAttribution(def, {
        name: opts.asset.name,
        creator: opts.asset.creator,
        url: opts.asset.assetUrl,
      }));

    const record: LibraryAsset = {
      id,
      name: opts.asset.name,
      creator: opts.asset.creator,
      providerId: opts.asset.providerId,
      sourceUrl: opts.asset.assetUrl,
      downloadUrl: opts.asset.raw?.downloadUrl as string | undefined,
      licenseId: opts.asset.license.id,
      licenseRaw: opts.asset.license.raw,
      licenseUrl: opts.asset.license.url,
      licenseCheckedAt: opts.licenseCheckedAt ?? opts.asset.license.licenseCheckedAt,
      attributionText,
      downloadedAt: (opts.downloadedAt ?? new Date()).toISOString(),
      sha256: sha,
      md5,
      format,
      fileSize: stat.size,
      polyCount: opts.asset.polyCount,
      textureResolution: opts.asset.textureResolution,
      category,
      kind: opts.asset.kind,
      tagsJson: JSON.stringify(opts.asset.tags ?? []),
      localPath: dest,
      originalDir: folders.original,
      processedDir: folders.processed,
      gameReadyDir: folders.gameReady,
      processingStatus: 'original',
      engineCompatibilityJson: JSON.stringify({ unreal: true, unity: true, godot: true, blender: true }),
      currentVersion: 1,
      favorite: false,
      animated: opts.asset.animated,
      rigged: opts.asset.rigged,
      pbr: opts.asset.pbr,
    };

    // Perceptual hash from a preview if one exists later; keep phash slot.
    this.assets.insert(record);
    await this.writeSidecar(record);
    log.info('asset registered', { id, name: record.name, category, provider: record.providerId });
    return record;
  }

  /** Portable per-asset metadata copy (survives DB loss; spec §15). */
  async writeSidecar(a: LibraryAsset): Promise<void> {
    const dir = path.dirname(a.originalDir);
    await atomicWriteFile(path.join(dir, 'asset.json'), JSON.stringify(a, null, 2));
  }

  /** Versioning: import a new version of an existing asset (spec §5). */
  async addVersion(existing: LibraryAsset, newFile: string): Promise<LibraryAsset> {
    const nextVer = existing.currentVersion + 1;
    const verDir = path.join(existing.originalDir, `v${nextVer}`);
    await ensureDir(verDir);
    const dest = path.join(verDir, safeFileName(`${existing.name}_v${nextVer}${path.extname(newFile) || ''}`));
    await moveFile(newFile, dest);
    const sha = await sha256File(dest).catch(() => undefined);
    this.assets.update(existing.id, { currentVersion: nextVer, sha256: sha, localPath: dest, downloadedAt: new Date().toISOString() });
    const updated = this.assets.get(existing.id)!;
    await this.writeSidecar(updated);
    return updated;
  }

  /** Detect potential duplicates of a candidate before it is saved (spec §10). */
  async findDuplicates(candidate: {
    sha256?: string; name: string; sourceUrl?: string;
    previewPath?: string; polyCount?: number; fileSize?: number;
  }): Promise<{ duplicate: boolean; matches: { asset: LibraryAsset; kind: string; score: number }[] }> {
    const matches: { asset: LibraryAsset; kind: string; score: number }[] = [];
    const all = this.assets.all();

    if (candidate.sha256) {
      for (const a of all) {
        if (a.sha256 && a.sha256 === candidate.sha256) matches.push({ asset: a, kind: 'sha256', score: 1 });
      }
    }
    if (candidate.sourceUrl) {
      for (const a of all) {
        if (a.sourceUrl === candidate.sourceUrl) matches.push({ asset: a, kind: 'source-url', score: 1 });
      }
    }
    for (const a of all) {
      const d = diceSimilarity(candidate.name, a.name);
      if (d >= 0.9) matches.push({ asset: a, kind: 'filename', score: d });
      else if (candidate.fileSize && a.fileSize && candidate.fileSize === a.fileSize && candidate.fileSize > 10_000) {
        matches.push({ asset: a, kind: 'file-size', score: 0.7 });
      }
      if (
        candidate.polyCount && a.polyCount && candidate.polyCount === a.polyCount
        && candidate.fileSize && a.fileSize && candidate.fileSize === a.fileSize
      ) {
        matches.push({ asset: a, kind: 'metadata', score: 0.8 });
      }
    }

    if (candidate.previewPath && await pathExists(candidate.previewPath)) {
      const ah = await aHashFile(candidate.previewPath);
      const dh = await dHashFile(candidate.previewPath);
      if (ah && dh) {
        for (const a of all) {
          if (!a.phash) continue;
          const [aAh, aDh] = a.phash.split('|');
          if (!aAh || !aDh) continue;
          const d1 = hamming(ah, aAh), d2 = hamming(dh, aDh);
          if (d1 <= 6 && d2 <= 8) matches.push({ asset: a, kind: 'perceptual-image', score: 1 - (d1 + d2) / 40 });
        }
      }
    }

    // de-dup match list keeping best per asset
    const best = new Map<string, { asset: LibraryAsset; kind: string; score: number }>();
    for (const m of matches) {
      const prev = best.get(m.asset.id);
      if (!prev || m.score > prev.score) best.set(m.asset.id, m);
    }
    const list = [...best.values()].sort((x, y) => y.score - x.score);
    return { duplicate: list.length > 0, matches: list };
  }

  /** Set the preview image + compute perceptual hashes for dedup. */
  async attachPreview(assetId: string, imagePath: string): Promise<void> {
    const a = this.assets.get(assetId);
    if (!a) return;
    const dir = path.dirname(a.originalDir);
    const dest = path.join(dir, `preview${path.extname(imagePath) || '.jpg'}`);
    await moveFile(imagePath, dest);
    const ah = await aHashFile(dest);
    const dh = await dHashFile(dest);
    this.assets.update(assetId, { previewPath: dest, phash: ah && dh ? `${ah}|${dh}` : undefined });
  }

  async verifyIntegrity(assetId: string): Promise<{ ok: boolean; reason?: string }> {
    const a = this.assets.get(assetId);
    if (!a) return { ok: false, reason: 'not found' };
    if (!(await pathExists(a.localPath))) return { ok: false, reason: 'file missing' };
    if (a.sha256) {
      const sha = await sha256File(a.localPath);
      if (sha !== a.sha256) return { ok: false, reason: 'sha256 mismatch — file changed or corrupted' };
    }
    return { ok: true };
  }

  moveCategory(assetId: string, cat: AssetCategory): Promise<void> {
    return (async () => {
      const a = this.assets.get(assetId);
      if (!a) return;
      const fromDir = path.dirname(a.originalDir);
      const toDir = path.join(this.categoryDir(cat), path.basename(fromDir));
      if (fromDir === toDir) return;
      await ensureDir(path.dirname(toDir));
      await fs.rename(fromDir, toDir).catch(async (e: NodeJS.ErrnoException) => {
        if (e.code === 'EXDEV') await fs.cp(fromDir, toDir, { recursive: true }).then(() => fs.rm(fromDir, { recursive: true }));
        else throw e;
      });
      this.assets.update(assetId, {
        originalDir: path.join(toDir, 'Original'),
        processedDir: path.join(toDir, 'Processed'),
        gameReadyDir: path.join(toDir, 'GameReady'),
        localPath: path.join(toDir, 'Original', path.basename(a.localPath)),
        category: cat,
        categoryOverride: cat,
        previewPath: a.previewPath ? path.join(toDir, path.basename(a.previewPath)) : undefined,
      });
      const updated = this.assets.get(assetId)!;
      await this.writeSidecar(updated);
    })();
  }
}

function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}

/** Full duplicate scan across the library → duplicate_groups table. */
export function rebuildDuplicateGroups(assets: AssetsRepo, dupes: import('../db/repositories').DuplicatesRepo): void {
  dupes.clear();
  const all = assets.all();
  const bySha = new Map<string, LibraryAsset[]>();
  for (const a of all) {
    if (!a.sha256) continue;
    const arr = bySha.get(a.sha256) ?? [];
    arr.push(a);
    bySha.set(a.sha256, arr);
  }
  for (const [sha, group] of bySha) {
    if (group.length < 2) continue;
    const gid = dupes.createGroup('sha256', `identical files (${sha.slice(0, 12)}…)`);
    for (const a of group) dupes.addMember(gid, a.id, 1);
  }
  // Same-model-on-multiple-sources grouping: normalized name + equal poly/filesize
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const A = all[i], B = all[j];
      if (A.providerId === B.providerId) continue;
      const d = diceSimilarity(A.name, B.name);
      const meta = A.polyCount && B.polyCount && A.polyCount === B.polyCount;
      if (d >= 0.85 || (d >= 0.7 && meta)) {
        const gid = dupes.createGroup('cross-source', `same model on ${A.providerId} & ${B.providerId}`);
        dupes.addMember(gid, A.id, d);
        dupes.addMember(gid, B.id, d);
      }
    }
  }
}
