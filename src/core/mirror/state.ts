/**
 * Mirror state — the durable, interrupt-safe record of the mirroring
 * pipeline (spec §6). One JSON file per repository, atomically written
 * after every entry transition so Ctrl+C / crashes never lose progress.
 *
 * States: DISCOVERED → LICENSE_VERIFIED → QUEUED → DOWNLOADING →
 * DOWNLOADED → VERIFIED → PROCESSED → COMMITTED, plus FAILED / SKIPPED.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile, ensureDir } from '../util/fsutil';

export type MirrorStateName =
  | 'DISCOVERED' | 'LICENSE_VERIFIED' | 'QUEUED' | 'DOWNLOADING'
  | 'DOWNLOADED' | 'VERIFIED' | 'PROCESSED' | 'COMMITTED'
  | 'FAILED' | 'SKIPPED';

export const TERMINAL_SKIP_STATES: MirrorStateName[] = ['FAILED', 'SKIPPED'];

export interface MirrorLicense {
  id: string;
  raw?: string;
  url?: string;
  commercialUse: 'allowed' | 'conditions' | 'forbidden' | 'unknown';
  attributionRequired: boolean;
  shareAlike: boolean;
  redistribution: 'allowed' | 'conditions' | 'forbidden' | 'unknown';
  unknown: boolean;
  sourceConfirmed: boolean;
}

export interface MirrorEntry {
  ref: string;                       // "provider:assetId"
  providerId: string;
  assetId: string;
  name: string;
  creator?: string;
  sourceUrl: string;
  previewUrl?: string;
  license: MirrorLicense;
  category: string;                  // mirror directory (environments, weapons…)
  formats: string[];
  polyCount?: number;
  textureResolution?: number;
  tags: string[];
  kind: string;
  state: MirrorStateName;
  skipReason?: string;               // REDISTRIBUTION_NOT_PERMITTED | UNKNOWN_LICENSE | DUPLICATE | TOO_LARGE | DOWNLOAD_UNAVAILABLE | SOURCE_REMOVED | REDISTRIBUTION_REVOKED | REMEDIATED
  duplicateOf?: string;              // canonical ref when sha dup found elsewhere
  sha256?: string;
  sizeBytes?: number;
  fileName?: string;
  /** All files of a complete package (main file + includes), each sha256-verified. */
  files?: { path: string; sha256: string; sizeBytes: number }[];
  /** Stable timestamp captured once when the asset finished processing (never changes on re-discovery). */
  downloadedAt?: string;
  mirrorPath?: string;               // assets/<category>/<slug>
  previewStored?: boolean;
  error?: string;
  attempts: number;
  licenseChanged?: boolean;
  licensePrevious?: string;
  discoveredAt: string;
  updatedAt: string;
}

export interface MirrorStateFile {
  version: 1;
  repoRoot: string;
  generatedAt: string;
  paused?: { reason: string; at: string };
  entries: Record<string, MirrorEntry>;
}

export class MirrorState {
  private data: MirrorStateFile;
  readonly file: string;

  private constructor(readonly repoRoot: string, file: string, data: MirrorStateFile) {
    this.file = file;
    this.data = data;
  }

  static dir(repoRoot: string): string {
    return path.join(repoRoot, '.asset-hub-mirror');
  }

  static async load(repoRoot: string): Promise<MirrorState> {
    const file = path.join(MirrorState.dir(repoRoot), 'state.json');
    let data: MirrorStateFile | null = null;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) as MirrorStateFile;
    } catch {
      data = null;
    }
    if (!data || data.version !== 1) {
      data = { version: 1, repoRoot, generatedAt: new Date().toISOString(), entries: {} };
    }
    data.repoRoot = repoRoot;
    return new MirrorState(repoRoot, file, data);
  }

  async save(): Promise<void> {
    this.data.generatedAt = new Date().toISOString();
    await ensureDir(path.dirname(this.file));
    await atomicWriteFile(this.file, JSON.stringify(this.data, null, 2));
  }

  get(ref: string): MirrorEntry | undefined {
    return this.data.entries[ref];
  }

  upsert(entry: MirrorEntry): void {
    entry.updatedAt = new Date().toISOString();
    this.data.entries[entry.ref] = entry;
  }

  all(): MirrorEntry[] {
    return Object.values(this.data.entries);
  }

  count(pred: (e: MirrorEntry) => boolean): number {
    return this.all().filter(pred).length;
  }

  setPaused(reason: string | null): void {
    if (reason) this.data.paused = { reason, at: new Date().toISOString() };
    else delete this.data.paused;
  }

  get paused(): { reason: string; at: string } | undefined {
    return this.data.paused;
  }

  /** Mirror-capable = redistributable + not skipped/failed, any live state. */
  pending(): MirrorEntry[] {
    return this.all().filter((e) => ['DISCOVERED', 'LICENSE_VERIFIED', 'QUEUED', 'DOWNLOADED', 'DOWNLOADING'].includes(e.state));
  }

  /** Resume set: everything not terminal. */
  resumable(): MirrorEntry[] {
    return this.all().filter((e) => !TERMINAL_SKIP_STATES.includes(e.state) && e.state !== 'COMMITTED' && e.state !== 'PROCESSED' && e.state !== 'VERIFIED');
  }

  stats(): Record<string, number> {
    const by: Record<string, number> = {};
    for (const e of this.all()) by[e.state] = (by[e.state] ?? 0) + 1;
    return by;
  }
}
