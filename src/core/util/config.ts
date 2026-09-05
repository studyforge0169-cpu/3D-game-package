/**
 * App configuration (spec §22.4): a versioned JSON file with schema
 * validation + backup of the previous version on every change.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { pathExists, readJsonFile, writeJsonFile, ensureDir } from './fsutil';
import { rootLogger } from './logger';
import type { RateLimitConfig } from '../types';

export type { RateLimitConfig };

export interface AppPaths {
  readonly userDataDir: string;
  readonly configFile: string;
  readonly dbFile: string;
  readonly logDir: string;
  readonly backupDir: string;
  readonly cacheDir: string;
  readonly defaultLibraryDir: string;
}

export interface AppConfig {
  version: number;
  libraryDir: string;
  downloads: {
    globalConcurrency: number;
    perHostConcurrency: number;
    retryLimit: number;
    timeoutMs: number;
    speedLimitBps: number | null; // null = unlimited
  };
  network: {
    userAgentExtra: string;
    respectRobots: boolean; // always true in practice; flag for audit
    defaultTimeoutMs: number;
    perHostRateLimits: Record<string, RateLimitConfig>;
  };
  converters: {
    blenderPath: string | null;
    assimpPath: string | null;
    defaultTargetFormat: 'glb' | 'gltf';
  };
  ui: {
    theme: 'dark' | 'light' | 'system';
    viewMode: 'grid' | 'list';
    perPage: number;
  };
  attribution: {
    includeCc0: boolean; // courtesy-list CC0 assets too
    format: 'txt' | 'md' | 'both';
  };
  backups: {
    dbBackupCount: number;
    configBackupCount: number;
    dailyDbBackup: boolean;
  };
}

export const CONFIG_VERSION = 1;

export function defaultConfig(libDir?: string): AppConfig {
  return {
    version: CONFIG_VERSION,
    libraryDir: libDir ?? path.join(os.homedir(), 'Documents', 'UniversalGameAssetHub'),
    downloads: {
      globalConcurrency: 3,
      perHostConcurrency: 2,
      retryLimit: 3,
      timeoutMs: 45_000,
      speedLimitBps: null,
    },
    network: {
      userAgentExtra: '',
      respectRobots: true,
      defaultTimeoutMs: 30_000,
      perHostRateLimits: {
        'api.polyhaven.com': { minIntervalMs: 1500, maxBurst: 2 },
        'ambientcg.com': { minIntervalMs: 1200, maxBurst: 2 },
        'api.sketchfab.com': { minIntervalMs: 1100, maxBurst: 3 },
        'www.blenderkit.com': { minIntervalMs: 1500, maxBurst: 2 },
        'api.poly.pizza': { minIntervalMs: 1200, maxBurst: 2 },
        'opengameart.org': { minIntervalMs: 12_000, maxBurst: 1 }, // robots Crawl-delay: 10
      },
    },
    converters: { blenderPath: null, assimpPath: null, defaultTargetFormat: 'glb' },
    ui: { theme: 'system', viewMode: 'grid', perPage: 48 },
    attribution: { includeCc0: true, format: 'both' },
    backups: { dbBackupCount: 7, configBackupCount: 10, dailyDbBackup: true },
  };
}

/** Runtime-resolved application paths. */
export class Paths implements AppPaths {
  readonly userDataDir: string;
  readonly configFile: string;
  readonly dbFile: string;
  readonly logDir: string;
  readonly backupDir: string;
  readonly cacheDir: string;
  readonly defaultLibraryDir: string;

  constructor(userDataDir?: string) {
    const base = userDataDir
      ?? process.env.UGAH_DATA_DIR
      ?? (process.versions?.electron
        ? path.join(process.env.APPDATA ?? path.join(os.homedir(), '.local', 'share'), 'UniversalGameAssetHub')
        : path.join(os.homedir(), '.universal-game-asset-hub'));
    this.userDataDir = base;
    this.configFile = path.join(base, 'config.json');
    this.dbFile = path.join(base, 'UGAH.db');
    this.logDir = path.join(base, 'logs');
    this.backupDir = path.join(base, 'backups');
    this.cacheDir = path.join(base, 'cache');
    this.defaultLibraryDir = path.join(os.homedir(), 'Documents', 'UniversalGameAssetHub');
  }
}

const log = rootLogger.child('config');

export class ConfigStore {
  constructor(private readonly paths: Paths) {}

  async load(): Promise<AppConfig> {
    const defaults = defaultConfig(this.paths.defaultLibraryDir);
    const stored = await readJsonFile<Partial<AppConfig>>(this.paths.configFile);
    if (!stored) {
      await this.save(defaults);
      return defaults;
    }
    // Deep-merge over defaults so new keys appear after upgrades.
    const merged = deepMerge(defaults, stored) as AppConfig;
    return merged;
  }

  async save(cfg: AppConfig): Promise<void> {
    try {
      if (await pathExists(this.paths.configFile)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await ensureDir(this.paths.backupDir);
        await import('node:fs/promises').then((fsp) =>
          fsp.copyFile(this.paths.configFile, path.join(this.paths.backupDir, `config.${stamp}.json`)));
        this.pruneConfigBackups();
      }
    } catch (e) { log.warn('config backup failed', { error: String(e) }); }
    await writeJsonFile(this.paths.configFile, cfg);
  }

  private pruneConfigBackups(): void {
    void (async () => {
      try {
        const fsp = await import('node:fs/promises');
        const files = (await fsp.readdir(this.paths.backupDir)).filter((f) => f.startsWith('config.')).sort();
        const cfg = await this.load().catch(() => null);
        const keep = cfg?.backups.configBackupCount ?? 10;
        while (files.length > keep) await fsp.unlink(path.join(this.paths.backupDir, files.shift()!));
      } catch { /* best effort */ }
    })();
  }
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}
