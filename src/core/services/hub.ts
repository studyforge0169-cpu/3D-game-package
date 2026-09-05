/**
 * Application facade. The single entry point consumed by the Electron main
 * process (via IPC) and server mode (via REST/SSE). Owns config, database,
 * providers, downloads, library, converters, exports and attribution.
 */

import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { EventEmitter } from 'node:events';
import type {
  AppConfig, AppPaths, Paths, RateLimitConfig,
} from '../util/config';
import { ConfigStore, Paths as PathsClass, defaultConfig } from '../util/config';
import type { Database } from '../db/database';
import { openDatabase, SqliteDatabase } from '../db/database';
import {
  AssetsRepo, CollectionsRepo, DuplicatesRepo, ProjectsRepo, ProviderCacheRepo, TasksRepo, uuid,
} from '../db/repositories';
import { HttpClient, APP_USER_AGENT } from '../net/http';
import { createProviders } from '../providers/registry';
import type { AssetProvider } from '../types' ;
import type {
  AssetCategory, AssetRef, AttributionDoc, Collection, ConvertOptions, ConvertResult,
  DownloadOption, DownloadTask, EngineId, ExportRequest, ExportResult, GameProject,
  LibraryAsset, LicenseInfo, SearchPage, SearchQuery, TaskState,
} from '../types';
import { DownloadManager } from '../downloads/manager';
import { LibraryService, rebuildDuplicateGroups } from '../library/library';
import { ExportService } from '../export/presets';
import { convertAsset } from '../convert/pipeline';
import { geometryFingerprint } from '../convert/stats';
import { loadModel } from '../convert/pipeline';
import { generateAttribution } from '../attribution';
import type { SecretStore } from '../util/secrets';
import { createSecretStore } from '../util/secrets';
import { SECRET_KEYS } from '../util/secrets';
import { normalizeLicense } from '../licenses/registry';
import { ensureDir, pathExists, safeFileName } from '../util/fsutil';
import { rootLogger } from '../util/logger';
import * as fs from 'node:fs';
import * as os from 'node:os';

const log = rootLogger.child('hub');

export interface HubOptions {
  userDataDir?: string;
  libraryDir?: string;
  safeStorage?: import('../util/secrets').SafeStorageLike;
  /** Fixture/demo mode: mock provider only, no network. */
  mockMode?: boolean;
}

export class Hub extends EventEmitter {
  readonly paths: Paths;
  private db!: SqliteDatabase;
  private httpClient!: HttpClient;
  private config!: AppConfig;
  private secrets!: SecretStore;
  private dm!: DownloadManager;
  private library!: LibraryService;
  readonly providers = new Map<string, AssetProvider>();

  readonly assets!: AssetsRepo;
  readonly collections!: CollectionsRepo;
  readonly tasks!: TasksRepo;
  readonly projects!: ProjectsRepo;
  readonly duplicates!: DuplicatesRepo;
  readonly cache!: ProviderCacheRepo;
  private exporter!: ExportService;
  private shuttingDown = false;

  constructor(private readonly opts: HubOptions = {}) {
    super();
    this.paths = new PathsClass(opts.userDataDir);
  }

  async init(): Promise<void> {
    await ensureDir(this.paths.userDataDir);
    await ensureDir(this.paths.logDir);
    const logFile = path.join(this.paths.logDir, `ugah-${new Date().toISOString().slice(0, 10)}.log`);
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    rootLogger.configure({ minLevel: (process.env.UGAH_LOG_LEVEL as 'debug') ?? 'info', file: (line) => stream.write(line + '\n') });

    const configStore = new ConfigStore(this.paths);
    this.config = await configStore.load();
    if (this.opts.libraryDir) {
      this.config.libraryDir = this.opts.libraryDir;
      await configStore.save(this.config);
    }
    this.secrets = createSecretStore(this.paths.userDataDir, this.opts.safeStorage);

    this.db = await openDatabase(this.paths.dbFile, this.paths.backupDir);
    // Repos are created once and shared (constructor field assignment below).
    (this as { assets: AssetsRepo }).assets = new AssetsRepo(this.db);
    (this as { collections: CollectionsRepo }).collections = new CollectionsRepo(this.db);
    (this as { tasks: TasksRepo }).tasks = new TasksRepo(this.db);
    (this as { projects: ProjectsRepo }).projects = new ProjectsRepo(this.db);
    (this as { duplicates: DuplicatesRepo }).duplicates = new DuplicatesRepo(this.db);
    (this as { cache: ProviderCacheRepo }).cache = new ProviderCacheRepo(this.db);

    this.httpClient = new HttpClient({
      userAgent: this.userAgent(),
      timeoutMs: this.config.network.defaultTimeoutMs,
      perHostRateLimits: this.config.network.perHostRateLimits,
      respectRobots: this.config.network.respectRobots,
    });
    for (const [id, p] of createProviders(this.httpClient, { includeMock: true })) this.providers.set(id, p);

    await ensureDir(this.config.libraryDir);
    this.library = new LibraryService(this.config.libraryDir, this.assets);
    await this.library.init();

    this.dm = new DownloadManager(this.providers, this.tasks, this.assets, this.library, this.secrets, {
      globalConcurrency: this.config.downloads.globalConcurrency,
      retryLimit: this.config.downloads.retryLimit,
      tmpDir: path.join(this.paths.cacheDir, 'downloads'),
    });
    this.dm.on('progress', (ev) => this.emit('download-progress', ev));
    this.dm.on('task-completed', (ev) => this.emit('download-completed', ev));

    this.exporter = new ExportService(this.assets, this.projects);
    this.registerShutdown();
    log.info('hub initialized', {
      db: this.paths.dbFile,
      library: this.config.libraryDir,
      providers: [...this.providers.keys()].length,
      secretBackend: this.secrets.backend,
    });
  }

  private userAgent(): string {
    return `UniversalGameAssetHub/1.0 (+https://github.com/studyforge0169-cpu/3D-game-package)${this.config.network.userAgentExtra ? ' ' + this.config.network.userAgentExtra : ''}`;
  }

  // ------------------------------------------------------------------ config

  getConfig(): AppConfig { return this.config; }

  async updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    const merged = { ...this.config, ...patch } as AppConfig;
    await new ConfigStore(this.paths).save(merged);
    this.config = merged;
    if (patch.downloads?.globalConcurrency) this.dm.setConcurrency(patch.downloads.globalConcurrency);
    this.emit('config-changed', merged);
    return merged;
  }

  getSecretBackend(): SecretStore['backend'] { return this.secrets.backend; }

  async backupDatabase(): Promise<string> {
    return this.db.backup(this.paths.backupDir, this.config.backups.dbBackupCount);
  }

  async setApiKey(provider: 'sketchfab' | 'polypizza' | 'blenderkit', key: string): Promise<void> {
    const k = provider === 'sketchfab' ? SECRET_KEYS.sketchfabToken : provider === 'polypizza' ? SECRET_KEYS.polyPizzaKey : SECRET_KEYS.blenderKitKey;
    if (key) await this.secrets.set(k, key);
    else await this.secrets.delete(k);
    this.emit('api-keys-changed', { provider, hasKey: !!key });
  }

  async hasApiKey(provider: string): Promise<boolean> {
    const k = provider === 'sketchfab' ? SECRET_KEYS.sketchfabToken : provider === 'polypizza' ? SECRET_KEYS.polyPizzaKey : SECRET_KEYS.blenderKitKey;
    return !!(await this.secrets.get(k));
  }

  // ------------------------------------------------------------------ search

  async search(query: SearchQuery): Promise<SearchPage[]> {
    const activeProviders = this.opts.mockMode
      ? ['mock']
      : (query.providers?.length ? query.providers : [...this.providers.keys()].filter((id) => id !== 'mock'));
    const pages: SearchPage[] = await Promise.all(activeProviders.map(async (id) => {
      const p = this.providers.get(id);
      if (!p) return { providerId: id, results: [], page: 1, error: `unknown provider ${id}` };
      if (!p.isConfigured(await this.keyFor(id))) {
        return {
          providerId: id, results: [], page: 1,
          error: `${p.info.displayName} needs your API key (Settings → API Keys).`,
          searchUrl: p.buildSearchUrl(query),
        };
      }
      try {
        return await p.search(query, await this.keyFor(id));
      } catch (e) {
        const err = e as Error & { code?: string; message: string };
        log.warn('provider search failed', { provider: id, error: err.message });
        return {
          providerId: id, results: [], page: query.page ?? 1,
          error: err.code === 'ROBOTS_DENIED'
            ? 'Automated access is unavailable for this source. Open the official asset page to obtain it manually.'
            : err.message,
          searchUrl: p.buildSearchUrl(query),
        };
      }
    }));
    return pages;
  }

  async providerInfos(): Promise<Record<string, unknown>[]> {
    const out = [];
    for (const p of this.providers.values()) {
      if (p.info.id === 'mock' && !this.opts.mockMode) continue;
      out.push({
        ...p.info,
        configured: p.isConfigured(await this.keyFor(p.info.id)),
      });
    }
    return out;
  }

  async getAssetDetail(providerId: string, assetId: string): Promise<{ asset: AssetRef | null; license: LicenseInfo; options: DownloadOption[] }> {
    const p = this.providers.get(providerId);
    if (!p) throw new Error(`unknown provider ${providerId}`);
    const key = await this.keyFor(providerId);
    const asset = await p.getAsset(assetId, key);
    const license = await p.getLicense(assetId, key);
    const options = asset && !asset.license.unknown ? await p.getDownloadOptions(assetId, key).catch(() => []) : [];
    return { asset, license, options };
  }

  private async keyFor(providerId: string): Promise<string | undefined> {
    if (providerId === 'sketchfab') return (await this.secrets.get(SECRET_KEYS.sketchfabToken)) ?? undefined;
    if (providerId === 'polypizza') return (await this.secrets.get(SECRET_KEYS.polyPizzaKey)) ?? undefined;
    if (providerId === 'blenderkit') return (await this.secrets.get(SECRET_KEYS.blenderKitKey)) ?? undefined;
    return undefined;
  }

  // ---------------------------------------------------------------- downloads

  async enqueueDownload(providerId: string, assetId: string, optionId?: string): Promise<DownloadTask> {
    const p = this.providers.get(providerId);
    if (!p) throw new Error(`unknown provider ${providerId}`);
    const key = await this.keyFor(providerId);
    const asset = await p.getAsset(assetId, key);
    if (!asset) throw new Error('asset not found');
    const options = await p.getDownloadOptions(assetId, key);
    const option = options.find((o) => o.id === optionId) ?? options[0];
    if (!option) throw new Error('No legal download option for this asset. Open the official page to obtain it manually.');
    return this.dm.enqueue(asset, option);
  }

  downloads(): DownloadTask[] { return this.dm.list(); }
  pauseDownloads(taskId?: string) { this.dm.pause(taskId); }
  resumeDownloads(taskId?: string) { this.dm.resume(taskId); }
  cancelDownload(taskId: string) { this.dm.cancel(taskId); }
  retryDownload(taskId: string) { this.dm.retry(taskId); }
  removeDownload(taskId: string) { this.dm.remove(taskId); }
  clearFinishedDownloads() { this.dm.clearFinished(); }

  // ------------------------------------------------------------------ library

  librarySearch(opts: Parameters<AssetsRepo['search']>[0]): LibraryAsset[] {
    return this.assets.search(opts);
  }

  asset(id: string): LibraryAsset | null { return this.assets.get(id); }

  updateAsset(id: string, patch: Partial<LibraryAsset>): void {
    this.assets.update(id, patch);
    const a = this.assets.get(id);
    if (a) void this.library.writeSidecar(a);
  }

  async moveAssetCategory(id: string, cat: AssetCategory): Promise<void> {
    await this.library.moveCategory(id, cat);
  }

  async deleteAsset(id: string): Promise<void> {
    const a = this.assets.get(id);
    if (!a) return;
    const dir = path.dirname(a.originalDir);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    this.assets.delete(id);
  }

  async verifyAsset(id: string) { return this.library.verifyIntegrity(id); }

  recentlyDownloaded(): LibraryAsset[] { return this.assets.recentlyDownloaded(); }
  recentlyUsed(): LibraryAsset[] { return this.assets.recentlyUsed(); }

  /**
   * Local Import (spec §13 manual workflow): register a file the user
   * downloaded themselves in their browser, with explicit license metadata.
   */
  async importLocalFile(opts: {
    filePath: string; providerId: string; name?: string; creator?: string;
    sourceUrl?: string; licenseRaw: string; licenseUrl?: string; tags?: string[];
    kind?: AssetRef['kind']; previewPath?: string;
  }): Promise<{ asset: LibraryAsset; duplicates: { duplicate: boolean; matches: unknown[] } }> {
    const provider = this.providers.get(opts.providerId);
    if (!provider) throw new Error(`unknown provider ${opts.providerId}`);
    const stat = await fsp.stat(opts.filePath).catch(() => null);
    if (!stat) throw new Error('file not found');
    const license = normalizeLicense({ raw: opts.licenseRaw, licenseUrl: opts.licenseUrl, sourceConfirmed: true });
    const asset: AssetRef = {
      id: `local-${uuid()}`,
      providerId: opts.providerId,
      name: opts.name ?? path.basename(opts.filePath, path.extname(opts.filePath)),
      creator: opts.creator,
      kind: opts.kind ?? 'model',
      assetUrl: opts.sourceUrl ?? provider.info.homeUrl,
      license,
      free: true,
      formats: [path.extname(opts.filePath).replace('.', '').toLowerCase()],
      tags: opts.tags ?? [],
    };
    const dup = await this.library.findDuplicates({
      name: asset.name,
      sourceUrl: asset.assetUrl,
      fileSize: stat.size,
      previewPath: opts.previewPath,
    });
    const registered = await this.library.register({ file: opts.filePath, asset });
    if (opts.previewPath) await this.library.attachPreview(registered.id, opts.previewPath);
    return { asset: this.assets.get(registered.id)!, duplicates: { duplicate: dup.duplicate, matches: dup.matches } };
  }

  async scanDuplicates(): Promise<void> {
    // compute geometry fingerprints for assets missing one.
    for (const a of this.assets.all()) {
      if (a.geometryFingerprint) continue;
      try {
        const model = await loadModel(a.localPath);
        const fp = geometryFingerprint(model);
        if (fp) this.updateAsset(a.id, { geometryFingerprint: fp });
      } catch { /* not a mesh file (zip/texture) */ }
    }
    rebuildDuplicateGroups(this.assets, this.duplicates);
    this.emit('duplicates-updated');
  }

  // --------------------------------------------------------------- collections

  createCollection(name: string, description?: string): Collection { return this.collections.create(name, description); }
  listCollections(): Collection[] { return this.collections.list(); }
  deleteCollection(id: string) { this.collections.delete(id); }
  addToCollection(collectionId: string, assetId: string) { this.collections.addAsset(collectionId, assetId); }
  removeFromCollection(collectionId: string, assetId: string) { this.collections.removeAsset(collectionId, assetId); }
  collectionAssets(collectionId: string): LibraryAsset[] { return this.collections.assetsOf(collectionId); }

  // ---------------------------------------------------------------- converters

  async convertAsset(assetId: string, options: ConvertOptions): Promise<ConvertResult> {
    const a = this.assets.get(assetId);
    if (!a) throw new Error('asset not found');
    const outDir = options.generateLods || options.generateCollision !== 'none'
      ? a.gameReadyDir!
      : a.processedDir!;
    const source = a.localPath;
    // zip archives need extraction first (Original stays untouched).
    let actualSource: string | null = source;
    if (path.extname(source).toLowerCase() === '.zip') {
      const extractDir = path.join(this.paths.cacheDir, 'extract', a.id);
      await ensureDir(extractDir);
      actualSource = await extractBestMesh(extractDir, source);
      if (!actualSource) return { ok: false, outputs: [], warnings: [], error: 'No convertible mesh found inside the downloaded archive (zip extraction found no glb/gltf/obj/fbx/blend/dae/stl/ply).' };
    }
    try {
      const result = await convertAsset(actualSource, outDir, options);
      if (result.ok) {
        this.updateAsset(assetId, { processingStatus: outDir === a.gameReadyDir ? 'game_ready' : 'processed' });
        if (!a.geometryFingerprint) {
          try {
            const model = await loadModel(result.outputs[0]?.path ?? actualSource);
            this.updateAsset(assetId, { geometryFingerprint: geometryFingerprint(model) });
          } catch { /* stats optional */ }
        }
      }
      return result;
    } catch (e) {
      log.error('conversion failed', { assetId, error: String(e) });
      this.updateAsset(assetId, { processingStatus: 'failed' });
      return { ok: false, outputs: [], warnings: [], error: String((e as Error).message ?? e) };
    }
  }

  // ------------------------------------------------------------------- export

  async exportAssets(req: ExportRequest): Promise<ExportResult> {
    return this.exporter.export(req, async (conflicts) => {
      // In headless mode default to skip; the UI passes an interactive resolver via events.
      this.emit('export-conflicts', { conflicts, req });
      return new Promise<'skip' | 'rename' | 'overwrite'>((resolve) => {
        this.once(`export-conflict-resolution:${req.projectName}:${req.exportRoot}`, (m: string) => resolve(m as 'skip' | 'rename' | 'overwrite'));
        setTimeout(() => resolve('skip'), 120_000).unref?.();
      });
    });
  }

  resolveExportConflicts(req: ExportRequest, decision: 'skip' | 'rename' | 'overwrite'): void {
    this.emit(`export-conflict-resolution:${req.projectName}:${req.exportRoot}`, decision);
  }

  // --------------------------------------------------------------- attribution

  attributionFor(assetIds: string[]): AttributionDoc {
    const assets = assetIds.map((id) => this.assets.get(id)!).filter(Boolean);
    return generateAttribution(assets);
  }

  attributionForCollection(collectionId: string): AttributionDoc {
    return generateAttribution(this.collections.assetsOf(collectionId));
  }

  async writeAttributionFiles(assetIds: string[], dir: string): Promise<string[]> {
    const doc = this.attributionFor(assetIds);
    await ensureDir(dir);
    const { atomicWriteFile } = await import('../util/fsutil');
    await atomicWriteFile(path.join(dir, 'ATTRIBUTIONS.txt'), doc.txt);
    await atomicWriteFile(path.join(dir, 'ATTRIBUTIONS.md'), doc.md);
    return [path.join(dir, 'ATTRIBUTIONS.txt'), path.join(dir, 'ATTRIBUTIONS.md')];
  }

  // ------------------------------------------------------------------ projects

  saveProject(p: Omit<GameProject, 'id'> & { id?: string }): GameProject {
    const project: GameProject = { id: p.id ?? uuid(), name: p.name, engine: p.engine, rootPath: p.rootPath, createdAt: p.createdAt ?? new Date().toISOString() };
    this.projects.upsert(project);
    return this.projects.get(project.id)!;
  }
  listProjects(): GameProject[] { return this.projects.list(); }
  deleteProject(id: string) { this.projects.delete(id); }

  // ------------------------------------------------------------------ shutdown

  /** Close DB cleanly without exiting the process (Electron before-quit). */
  shutdownForProcessExit(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log.info('app shutting down (desktop)');
    try { this.db.close(); } catch { /* already closed */ }
  }

  private registerShutdown(): void {
    const handler = (signal: string) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      log.info('shutting down', { signal });
      void (async () => {
        try {
          await this.dm.shutdown();
          if (this.db.isOpen) await this.db.backup(this.paths.backupDir, this.config.backups.dbBackupCount).catch(() => {});
          this.db.close();
        } finally {
          process.exit(0);
        }
      })();
    };
    process.on('SIGINT', () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('beforeExit', () => { if (!this.shuttingDown) { try { this.db.close(); } catch { /* noop */ } } });
  }
}

/** Pick the most game-ready mesh inside an extracted archive. */
async function extractBestMesh(extractDir: string, zipPath: string): Promise<string | null> {
  const zl = await import('zip-lib');
  await zl.extract(zipPath, extractDir).catch(() => null);
  const priority = ['glb', 'gltf', 'fbx', 'blend', 'dae', 'obj', 'ply', 'stl'];
  const all: string[] = [];
  async function walk(d: string) {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else all.push(full);
    }
  }
  await walk(extractDir);
  for (const ext of priority) {
    const hit = all.find((f) => f.toLowerCase().endsWith('.' + ext));
    if (hit) return hit;
  }
  return null;
}
