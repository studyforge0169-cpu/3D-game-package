/** Repositories over the SQLite schema — the only code that speaks SQL. */

import * as crypto from 'node:crypto';
import type { Database } from './database';
import type {
  AssetCategory, AssetKind, AssetRef, Collection, DownloadOption, DownloadTask,
  GameProject, LibraryAsset, TaskState,
} from '../types';

export function uuid(): string {
  return crypto.randomUUID();
}

// ------------------------------------------------------------------- assets

type AssetRow = Record<string, unknown>;

export class AssetsRepo {
  constructor(private readonly db: Database) {}

  toAsset(r: AssetRow): LibraryAsset {
    return {
      id: String(r.id),
      name: String(r.name),
      creator: (r.creator as string) ?? undefined,
      providerId: String(r.provider_id),
      sourceUrl: String(r.source_url),
      downloadUrl: (r.download_url as string) ?? undefined,
      licenseId: String(r.license_id),
      licenseRaw: (r.license_raw as string) ?? undefined,
      licenseUrl: (r.license_url as string) ?? undefined,
      licenseCheckedAt: String(r.license_checked_at),
      attributionText: (r.attribution_text as string) ?? undefined,
      downloadedAt: String(r.downloaded_at),
      lastUsedAt: (r.last_used_at as string) ?? undefined,
      sha256: (r.sha256 as string) ?? undefined,
      md5: (r.md5 as string) ?? undefined,
      format: String(r.format),
      fileSize: Number(r.file_size ?? 0),
      polyCount: r.poly_count == null ? undefined : Number(r.poly_count),
      textureResolution: r.texture_resolution == null ? undefined : Number(r.texture_resolution),
      category: String(r.category) as AssetCategory,
      categoryOverride: (r.category_override as AssetCategory | null) ?? null,
      kind: String(r.kind) as AssetKind,
      tagsJson: String(r.tags_json ?? '[]'),
      localPath: String(r.local_path),
      originalDir: String(r.original_dir),
      processedDir: (r.processed_dir as string) ?? undefined,
      gameReadyDir: (r.game_ready_dir as string) ?? undefined,
      previewPath: (r.preview_path as string) ?? undefined,
      processingStatus: String(r.processing_status) as LibraryAsset['processingStatus'],
      engineCompatibilityJson: String(r.engine_compatibility_json ?? '{}'),
      currentVersion: Number(r.current_version ?? 1),
      favorite: !!r.favorite,
      animated: r.animated == null ? undefined : !!r.animated,
      rigged: r.rigged == null ? undefined : !!r.rigged,
      pbr: r.pbr == null ? undefined : !!r.pbr,
      geometryFingerprint: (r.geometry_fingerprint as string) ?? undefined,
      phash: (r.phash as string) ?? undefined,
    };
  }

  insert(a: LibraryAsset): void {
    this.db.prepare(`INSERT INTO assets (
      id, name, creator, provider_id, source_url, download_url, license_id, license_raw, license_url,
      license_checked_at, attribution_text, downloaded_at, last_used_at, sha256, md5, format, file_size,
      poly_count, texture_resolution, category, category_override, kind, local_path, original_dir,
      processed_dir, game_ready_dir, preview_path, processing_status, engine_compatibility_json,
      current_version, favorite, animated, rigged, pbr, geometry_fingerprint, phash, tags_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      a.id, a.name, a.creator ?? null, a.providerId, a.sourceUrl, a.downloadUrl ?? null,
      a.licenseId, a.licenseRaw ?? null, a.licenseUrl ?? null,
      a.licenseCheckedAt, a.attributionText ?? null, a.downloadedAt, a.lastUsedAt ?? null,
      a.sha256 ?? null, a.md5 ?? null, a.format, a.fileSize,
      a.polyCount ?? null, a.textureResolution ?? null, a.category, a.categoryOverride ?? null,
      a.kind, a.localPath, a.originalDir,
      a.processedDir ?? null, a.gameReadyDir ?? null, a.previewPath ?? null, a.processingStatus,
      a.engineCompatibilityJson, a.currentVersion, a.favorite ? 1 : 0,
      a.animated == null ? null : a.animated ? 1 : 0,
      a.rigged == null ? null : a.rigged ? 1 : 0,
      a.pbr == null ? null : a.pbr ? 1 : 0,
      a.geometryFingerprint ?? null, a.phash ?? null, a.tagsJson,
    );
  }

  get(id: string): LibraryAsset | null {
    const r = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    return r ? this.toAsset(r) : null;
  }

  bySha256(sha: string): LibraryAsset[] {
    return this.db.prepare('SELECT * FROM assets WHERE sha256 = ?').all(sha).map((r) => this.toAsset(r));
  }

  bySourceUrl(url: string): LibraryAsset[] {
    return this.db.prepare('SELECT * FROM assets WHERE source_url = ?').all(url).map((r) => this.toAsset(r));
  }

  update(id: string, fields: Partial<LibraryAsset>): void {
    const map: Record<string, string> = {
      name: 'name', creator: 'creator', licenseId: 'license_id', licenseRaw: 'license_raw',
      licenseUrl: 'license_url', licenseCheckedAt: 'license_checked_at', attributionText: 'attribution_text',
      lastUsedAt: 'last_used_at', sha256: 'sha256', md5: 'md5', format: 'format', fileSize: 'file_size',
      polyCount: 'poly_count', textureResolution: 'texture_resolution', category: 'category',
      categoryOverride: 'category_override', localPath: 'local_path', originalDir: 'original_dir',
      processedDir: 'processed_dir',
      gameReadyDir: 'game_ready_dir', previewPath: 'preview_path', processingStatus: 'processing_status',
      engineCompatibilityJson: 'engine_compatibility_json', currentVersion: 'current_version',
      geometryFingerprint: 'geometry_fingerprint', phash: 'phash', tagsJson: 'tags_json',
      animated: 'animated', rigged: 'rigged', pbr: 'pbr',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(map)) {
      if (k in fields && (fields as Record<string, unknown>)[k] !== undefined) {
        let v: unknown = (fields as Record<string, unknown>)[k];
        if (typeof v === 'boolean') v = v ? 1 : 0;
        sets.push(`${col} = ?`);
        vals.push(v);
      }
    }
    if ('favorite' in fields) { sets.push('favorite = ?'); vals.push(fields.favorite ? 1 : 0); }
    if (!sets.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
  }

  search(opts: {
    text?: string; categories?: AssetCategory[]; favorites?: boolean; kind?: AssetKind;
    providers?: string[]; licenses?: string[]; tag?: string; recentFirst?: boolean; limit?: number;
  }): LibraryAsset[] {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (opts.text) {
      where.push('(name LIKE ? OR creator LIKE ? OR tags_json LIKE ?)');
      const like = `%${opts.text}%`;
      params.push(like, like, like);
    }
    if (opts.categories?.length) {
      where.push(`(category IN (${opts.categories.map(() => '?').join(',')}) OR category_override IN (${opts.categories.map(() => '?').join(',')}))`);
      params.push(...opts.categories, ...opts.categories);
    }
    if (opts.kind) { where.push('kind = ?'); params.push(opts.kind); }
    if (opts.providers?.length) { where.push(`provider_id IN (${opts.providers.map(() => '?').join(',')})`); params.push(...opts.providers); }
    if (opts.licenses?.length) { where.push(`license_id IN (${opts.licenses.map(() => '?').join(',')})`); params.push(...opts.licenses); }
    if (opts.favorites) { where.push('favorite = 1'); }
    if (opts.tag) { where.push('tags_json LIKE ?'); params.push(`%"${opts.tag}"%`); }
    const order = opts.recentFirst ? 'downloaded_at DESC' : 'name COLLATE NOCASE ASC';
    const limit = opts.limit ?? 500;
    params.push(limit);
    return this.db.prepare(`SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
      .all(...params).map((r) => this.toAsset(r));
  }

  recentlyDownloaded(limit = 50): LibraryAsset[] {
    return this.db.prepare('SELECT * FROM assets ORDER BY downloaded_at DESC LIMIT ?').all(limit).map((r) => this.toAsset(r));
  }

  recentlyUsed(limit = 50): LibraryAsset[] {
    return this.db.prepare('SELECT * FROM assets WHERE last_used_at IS NOT NULL ORDER BY last_used_at DESC LIMIT ?').all(limit).map((r) => this.toAsset(r));
  }

  all(): LibraryAsset[] {
    return this.db.prepare('SELECT * FROM assets').all().map((r) => this.toAsset(r));
  }

  count(): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM assets').get()?.c ?? 0);
  }
}

// --------------------------------------------------------------- collections

export class CollectionsRepo {
  constructor(private readonly db: Database) {}

  create(name: string, description?: string): Collection {
    const c: Collection = { id: uuid(), name, description, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO collections (id, name, description, created_at) VALUES (?,?,?,?)')
      .run(c.id, c.name, c.description ?? null, c.createdAt);
    return c;
  }

  list(): Collection[] {
    return this.db.prepare('SELECT * FROM collections ORDER BY name COLLATE NOCASE').all().map((r) => ({
      id: String(r.id), name: String(r.name), description: (r.description as string) ?? undefined,
      createdAt: String(r.created_at), coverAssetId: (r.cover_asset_id as string) ?? undefined,
    }));
  }

  get(id: string): Collection | null {
    const r = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
    if (!r) return null;
    return {
      id: String(r.id), name: String(r.name), description: (r.description as string) ?? undefined,
      createdAt: String(r.created_at), coverAssetId: (r.cover_asset_id as string) ?? undefined,
    };
  }

  rename(id: string, name: string): void {
    this.db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(name, id);
  }

  delete(id: string): void { this.db.prepare('DELETE FROM collections WHERE id = ?').run(id); }

  addAsset(collectionId: string, assetId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO collection_items (collection_id, asset_id, added_at) VALUES (?,?,?)')
      .run(collectionId, assetId, new Date().toISOString());
  }

  removeAsset(collectionId: string, assetId: string): void {
    this.db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND asset_id = ?').run(collectionId, assetId);
  }

  assetsOf(collectionId: string): LibraryAsset[] {
    return this.db.prepare(`SELECT a.* FROM assets a JOIN collection_items ci ON ci.asset_id = a.id
      WHERE ci.collection_id = ? ORDER BY ci.added_at DESC`).all(collectionId)
      .map((r) => new AssetsRepo(this.db).toAsset(r));
  }

  collectionsOf(assetId: string): Collection[] {
    return this.db.prepare(`SELECT c.* FROM collections c JOIN collection_items ci ON ci.collection_id = c.id
      WHERE ci.asset_id = ? ORDER BY c.name`).all(assetId).map((r) => ({
      id: String(r.id), name: String(r.name), description: (r.description as string) ?? undefined,
      createdAt: String(r.created_at), coverAssetId: (r.cover_asset_id as string) ?? undefined,
    }));
  }
}

// -------------------------------------------------------------- download tasks

export class TasksRepo {
  constructor(private readonly db: Database) {}

  upsert(task: DownloadTask): void {
    this.db.prepare(`INSERT INTO download_tasks (
      task_id, provider_id, asset_id, asset_json, option_json, option_id, url, dest_path, category,
      state, bytes, total_bytes, error, error_code, attempts, created_at, started_at, completed_at, priority
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET
      state=excluded.state, bytes=excluded.bytes, total_bytes=excluded.total_bytes,
      error=excluded.error, error_code=excluded.error_code, attempts=excluded.attempts,
      started_at=excluded.started_at, completed_at=excluded.completed_at, priority=excluded.priority`)
      .run(
        task.id, task.providerId, task.assetRef.id, JSON.stringify(task.assetRef),
        task.option ? JSON.stringify(task.option) : null, task.optionId, task.url, task.destPath,
        task.category, task.state, task.bytes, task.totalBytes ?? null, task.error ?? null,
        task.errorCode ?? null, task.attempts, task.createdAt, task.startedAt ?? null,
        task.completedAt ?? null, task.priority,
      );
  }

  updateState(taskId: string, patch: Partial<DownloadTask>): void {
    const cols: Record<string, string> = {
      state: 'state', bytes: 'bytes', totalBytes: 'total_bytes', error: 'error',
      errorCode: 'error_code', attempts: 'attempts', startedAt: 'started_at',
      completedAt: 'completed_at', destPath: 'dest_path', priority: 'priority',
    };
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      if (k in patch && (patch as Record<string, unknown>)[k] !== undefined) {
        sets.push(`${col} = ?`); vals.push((patch as Record<string, unknown>)[k]);
      }
    }
    if (!sets.length) return;
    vals.push(taskId);
    this.db.prepare(`UPDATE download_tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...vals);
  }

  get(taskId: string): DownloadTask | null {
    const r = this.db.prepare('SELECT * FROM download_tasks WHERE task_id = ?').get(taskId);
    return r ? this.rowToTask(r) : null;
  }

  /** All tasks ordered for the Downloads page. */
  list(limit = 1000): DownloadTask[] {
    return this.db.prepare(`SELECT * FROM download_tasks ORDER BY priority DESC, created_at DESC LIMIT ?`)
      .all(limit).map((r) => this.rowToTask(r));
  }

  byState(state: TaskState): DownloadTask[] {
    return this.db.prepare('SELECT * FROM download_tasks WHERE state = ? ORDER BY created_at').all(state).map((r) => this.rowToTask(r));
  }

  delete(taskId: string): void {
    this.db.prepare('DELETE FROM download_tasks WHERE task_id = ?').run(taskId);
  }

  clearFinished(): void {
    this.db.exec(`DELETE FROM download_tasks WHERE state IN ('completed','canceled','skipped_duplicate')`);
  }

  private rowToTask(r: AssetRow): DownloadTask {
    return {
      id: String(r.task_id),
      providerId: String(r.provider_id),
      assetRef: JSON.parse(String(r.asset_json)) as AssetRef,
      option: r.option_json ? (JSON.parse(String(r.option_json)) as DownloadOption) : undefined,
      optionId: (r.option_id as string) ?? '',
      url: String(r.url),
      destPath: String(r.dest_path),
      category: String(r.category) as AssetCategory,
      state: String(r.state) as TaskState,
      bytes: Number(r.bytes ?? 0),
      totalBytes: r.total_bytes == null ? undefined : Number(r.total_bytes),
      error: (r.error as string) ?? undefined,
      errorCode: (r.error_code as string) ?? undefined,
      attempts: Number(r.attempts ?? 0),
      createdAt: String(r.created_at),
      startedAt: (r.started_at as string) ?? undefined,
      completedAt: (r.completed_at as string) ?? undefined,
      priority: Number(r.priority ?? 0),
    };
  }
}

// ------------------------------------------------------------------ projects

export class ProjectsRepo {
  constructor(private readonly db: Database) {}

  upsert(p: GameProject): void {
    this.db.prepare(`INSERT INTO projects (id, name, engine, root_path, created_at, last_export_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, engine=excluded.engine,
        root_path=excluded.root_path, last_export_at=excluded.last_export_at`)
      .run(p.id, p.name, p.engine, p.rootPath, p.createdAt, p.lastExportAt ?? null);
  }

  list(): GameProject[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all().map(rowToProject);
  }

  get(id: string): GameProject | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return r ? rowToProject(r) : null;
  }

  delete(id: string): void { this.db.prepare('DELETE FROM projects WHERE id = ?').run(id); }

  recordExport(projectId: string | null, engine: string, exportRoot: string, files: string[]): void {
    this.db.prepare('INSERT INTO export_history (id, project_id, engine, export_root, files_json, created_at) VALUES (?,?,?,?,?,?)')
      .run(uuid(), projectId, engine, exportRoot, JSON.stringify(files), new Date().toISOString());
  }
}

function rowToProject(r: AssetRow): GameProject {
  return {
    id: String(r.id), name: String(r.name), engine: String(r.engine) as GameProject['engine'],
    rootPath: String(r.root_path), createdAt: String(r.created_at),
    lastExportAt: (r.last_export_at as string) ?? undefined,
  };
}

// ---------------------------------------------------------------- duplicates

export interface DuplicateGroupRow {
  groupId: string;
  kind: string;
  detail?: string;
  assets: { asset: LibraryAsset; score: number }[];
}

export class DuplicatesRepo {
  constructor(private readonly db: Database) {}

  createGroup(kind: string, detail?: string): string {
    const id = uuid();
    this.db.prepare('INSERT INTO duplicate_groups (group_id, kind, created_at, detail) VALUES (?,?,?,?)')
      .run(id, kind, new Date().toISOString(), detail ?? null);
    return id;
  }

  addMember(groupId: string, assetId: string, score: number): void {
    this.db.prepare('INSERT OR IGNORE INTO duplicate_members (group_id, asset_id, score) VALUES (?,?,?)')
      .run(groupId, assetId, score);
  }

  groups(): DuplicateGroupRow[] {
    const groups = this.db.prepare('SELECT * FROM duplicate_groups ORDER BY created_at DESC').all();
    const assets = new AssetsRepo(this.db);
    return groups.map((g) => ({
      groupId: String(g.group_id),
      kind: String(g.kind),
      detail: (g.detail as string) ?? undefined,
      assets: this.db.prepare('SELECT * FROM duplicate_members WHERE group_id = ? ORDER BY score DESC')
        .all(String(g.group_id))
        .map((m) => ({ asset: assets.get(String(m.asset_id))!, score: Number(m.score) }))
        .filter((m) => !!m.asset),
    })).filter((g) => g.assets.length > 1);
  }

  clear(): void { this.db.exec('DELETE FROM duplicate_groups'); }
}

// -------------------------------------------------------------------- cache

export class ProviderCacheRepo {
  constructor(private readonly db: Database) {}

  get(key: string, maxAgeMs: number): unknown | null {
    const r = this.db.prepare('SELECT payload_json, fetched_at FROM provider_cache WHERE cache_key = ?').get(key);
    if (!r) return null;
    const age = Date.now() - new Date(String(r.fetched_at)).getTime();
    if (age > maxAgeMs) return null;
    try { return JSON.parse(String(r.payload_json)); } catch { return null; }
  }

  set(key: string, payload: unknown, ttlMs?: number): void {
    this.db.prepare(`INSERT INTO provider_cache (cache_key, payload_json, fetched_at, expires_at)
      VALUES (?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET
        payload_json=excluded.payload_json, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at`)
      .run(key, JSON.stringify(payload), new Date().toISOString(),
        ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null);
  }
}
