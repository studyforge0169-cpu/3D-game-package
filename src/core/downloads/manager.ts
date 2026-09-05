/**
 * Download manager (spec §9).
 *
 * Durable queue in SQLite → survives crashes; interrupted tasks resume via
 * HTTP Range when the server supports it. License gate: assets with unknown
 * licenses are refused before any byte is requested (spec §4). Duplicate
 * gate, disk-space preflight, bounded retries with backoff, per-host
 * concurrency limits + provider rate limits (enforced by HttpClient), hash
 * verification (sha256 always; md5 when the source publishes one), and
 * quarantine of corrupt files.
 */

import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  AssetRef, AssetProvider, DownloadOption, DownloadProgressEvent, DownloadTask, TaskState,
} from '../types';
import { TasksRepo, AssetsRepo, uuid } from '../db/repositories';
import { LibraryService } from '../library/library';
import { freeDiskBytes, ensureDir, formatBytes } from '../util/fsutil';
import { sha256File } from '../util/hash';
import { rootLogger } from '../util/logger';
import type { SecretStore } from '../util/secrets';
import { SECRET_KEYS } from '../util/secrets';

const log = rootLogger.child('downloads');

export interface DownloadManagerOptions {
  globalConcurrency: number;
  retryLimit: number;
  /** Called to confirm a duplicate; default = auto-skip. */
  onDuplicate?: (asset: AssetRef, matches: unknown[]) => Promise<'skip' | 'download'>;
  /** Where partial files live until finished. */
  tmpDir: string;
}

interface QueuedJob {
  task: DownloadTask;
  provider: AssetProvider;
  apiKey?: string;
  abort: AbortController;
}

export class DownloadManager extends EventEmitter {
  private running = new Map<string, QueuedJob>();
  private pausedAll = false;
  private concurrency: number;
  private readonly retryLimit: number;

  constructor(
    private readonly providers: Map<string, AssetProvider>,
    private readonly tasks: TasksRepo,
    private readonly assets: AssetsRepo,
    private readonly library: LibraryService,
    private readonly secrets: SecretStore,
    private readonly opts: DownloadManagerOptions,
  ) {
    super();
    this.concurrency = opts.globalConcurrency;
    this.retryLimit = opts.retryLimit;
    void this.recoverInterrupted();
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(8, n));
    this.pump();
  }

  private async keyFor(providerId: string): Promise<string | undefined> {
    if (providerId === 'sketchfab') return (await this.secrets.get(SECRET_KEYS.sketchfabToken)) ?? undefined;
    if (providerId === 'polypizza') return (await this.secrets.get(SECRET_KEYS.polyPizzaKey)) ?? undefined;
    if (providerId === 'blenderkit') return (await this.secrets.get(SECRET_KEYS.blenderKitKey)) ?? undefined;
    return undefined;
  }

  // ------------------------------------------------------------------ public

  async enqueue(asset: AssetRef, option: DownloadOption): Promise<DownloadTask> {
    // LICENSE GATE — never download unknown-license assets (spec §4).
    if (asset.license.unknown || asset.license.id === 'unknown') {
      const t = this.newTask(asset, option, 'blocked_license');
      t.error = 'License could not be established — download blocked. Check the asset license first.';
      t.errorCode = 'LICENSE_UNKNOWN_BLOCK';
      this.tasks.upsert(t);
      this.emitProgress(t, 'blocked_license');
      log.warn('blocked download with unknown license', { asset: asset.id, provider: asset.providerId });
      return t;
    }
    if (asset.license.commercialUse === 'forbidden') {
      // Allowed to download for personal use but loudly flagged in UI.
      log.info('non-commercial license noted', { asset: asset.id });
    }

    // DUPLICATE GATE (spec §10).
    const dup = await this.library.findDuplicates({
      name: asset.name,
      sourceUrl: asset.assetUrl,
    });
    const exactSource = dup.matches.find((m) => m.kind === 'source-url');
    if (exactSource) {
      // Default policy: never silently download the same source asset twice
      // (spec §10). Interactive callers may override via onDuplicate.
      let decision: 'skip' | 'download' = 'skip';
      if (this.opts.onDuplicate) decision = await this.opts.onDuplicate(asset, dup.matches);
      if (decision === 'skip') {
        const t = this.newTask(asset, option, 'skipped_duplicate');
        t.error = 'Possible duplicate of an asset already in your library.';
        this.tasks.upsert(t);
        this.emitProgress(t, 'skipped_duplicate');
        log.info('skipped possible duplicate', { asset: asset.id, provider: asset.providerId });
        return t;
      }
    }

    // DISK SPACE PREFLIGHT (spec §9).
    const need = (option.sizeBytes ?? 50 * 1024 * 1024) * 1.2 + 64 * 1024 * 1024;
    const free = await freeDiskBytes(this.opts.tmpDir);
    if (free < need) {
      const t = this.newTask(asset, option, 'failed');
      t.error = `Not enough disk space: need ~${formatBytes(need)}, free ${formatBytes(free)}.`;
      t.errorCode = 'DISK_FULL';
      this.tasks.upsert(t);
      this.emitProgress(t, 'failed');
      return t;
    }

    const t = this.newTask(asset, option, 'queued');
    const taskDir = await this.taskDir(t);
    t.destPath = path.join(taskDir, this.filenameFor(asset, option));
    this.tasks.upsert(t);
    this.emitProgress(t, 'queued');
    this.pump();
    return t;
  }

  pause(taskId?: string): void {
    if (taskId) {
      const job = this.running.get(taskId);
      if (job) { job.task.state = 'paused'; job.abort.abort(); this.tasks.updateState(taskId, { state: 'paused' }); }
      else this.tasks.updateState(taskId, { state: 'paused' });
    } else {
      this.pausedAll = true;
      for (const [id, job] of this.running) { job.task.state = 'paused'; job.abort.abort(); this.tasks.updateState(id, { state: 'paused' }); }
      for (const t of this.tasks.byState('queued')) this.tasks.updateState(t.id, { state: 'paused' });
    }
    this.emit('queue-paused', { taskId });
  }

  resume(taskId?: string): void {
    this.pausedAll = false;
    if (taskId) this.tasks.updateState(taskId, { state: 'queued' });
    else for (const t of this.tasks.byState('paused')) this.tasks.updateState(t.id, { state: 'queued' });
    this.pump();
  }

  cancel(taskId: string): void {
    const job = this.running.get(taskId);
    if (job) {
      job.task.state = 'canceled';
      job.abort.abort();
      this.tasks.updateState(taskId, { state: 'canceled', error: 'canceled by user', completedAt: new Date().toISOString() });
    } else {
      this.tasks.updateState(taskId, { state: 'canceled', error: 'canceled by user', completedAt: new Date().toISOString() });
    }
    this.emitProgress(this.tasks.get(taskId)!, 'canceled');
    this.emit('task-canceled', { taskId });
  }

  retry(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    this.tasks.updateState(taskId, { state: 'queued', error: undefined, errorCode: undefined });
    const updated = this.tasks.get(taskId)!;
    updated.state = 'queued';
    this.pump();
  }

  remove(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (t && t.state === 'running') this.cancel(taskId);
    this.tasks.delete(taskId);
  }

  list(): DownloadTask[] { return this.tasks.list(); }

  clearFinished(): void { this.tasks.clearFinished(); }

  async shutdown(): Promise<void> {
    // Safe shutdown (spec §18): abort in-flight, persist states.
    for (const [id, job] of this.running) {
      job.abort.abort();
      this.tasks.updateState(id, { state: 'paused' });
    }
    await new Promise((r) => setTimeout(r, 150)); // allow aborts to settle
    log.info('download manager shut down cleanly');
  }

  // ----------------------------------------------------------------- internals

  private newTask(asset: AssetRef, option: DownloadOption, state: TaskState): DownloadTask {
    return {
      id: uuid(),
      providerId: asset.providerId,
      assetRef: asset,
      optionId: option.id,
      option,
      url: option.url,
      destPath: '',
      category: asset.categoryHint ?? 'Other',
      state,
      bytes: 0,
      totalBytes: option.sizeBytes,
      attempts: 0,
      createdAt: new Date().toISOString(),
      priority: 0,
    };
  }

  private filenameFor(asset: AssetRef, option: DownloadOption): string {
    const ext = option.format === 'original' ? 'zip' : option.format;
    const base = asset.name.replace(/[<>:"/\\|?*]+/g, '_').slice(0, 80);
    return `${base}.${ext}`;
  }

  private async taskDir(task: DownloadTask): Promise<string> {
    const dir = path.join(this.opts.tmpDir, task.id);
    await ensureDir(dir);
    return dir;
  }

  /** Crash recovery: tasks left 'running' from a previous session resume. */
  private async recoverInterrupted(): Promise<void> {
    const running = this.tasks.byState('running');
    for (const t of running) {
      this.tasks.updateState(t.id, { state: 'queued' });
      log.info('recovered interrupted task', { taskId: t.id });
    }
    if (running.length) this.pump();
  }

  private pump(): void {
    if (this.pausedAll) return;
    const active = this.running.size;
    const slots = this.concurrency - active;
    if (slots <= 0) return;
    const queued = this.tasks.byState('queued');
    for (const t of queued.slice(0, slots)) void this.run(t.id);
  }

  private async run(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== 'queued') return;
    const provider = this.providers.get(task.providerId);
    if (!provider) {
      this.finish(taskId, 'failed', 'provider unavailable', 'NO_PROVIDER');
      return;
    }
    const apiKey = await this.keyFor(task.providerId);
    const abort = new AbortController();
    const job: QueuedJob = { task, provider, apiKey, abort };
    this.running.set(taskId, job);
    task.state = 'running';
    task.attempts += 1;
    task.startedAt = new Date().toISOString();
    this.tasks.updateState(taskId, { state: 'running', startedAt: task.startedAt, attempts: task.attempts });

    try {
      const fallbackDir = await this.taskDir(task);
      const result = await provider.download(task.option!, {
        destDir: path.dirname(task.destPath || path.join(fallbackDir, 'file')),
        destPath: task.destPath || path.join(fallbackDir, 'file'),
        onProgress: (bytes, total) => {
          task.bytes = bytes;
          if (total) task.totalBytes = total;
          this.emitProgress(task, 'running', { speed: speedOf(taskId, bytes) });
        },
        signal: abort.signal,
        apiKey,
      });
      const current = this.tasks.get(taskId);
      if (current && ['paused', 'canceled'].includes(current.state)) {
        // interrupted mid-flight — leave paused/partial for resume; do not finalize
      } else if (result.ok && result.path) {
        await this.finalize(task, result);
      } else if (result.errorCode === 'HASH_MISMATCH' || result.errorCode === 'CORRUPT') {
        await this.quarantine(task.destPath);
        this.maybeRetry(task, result.error ?? 'corrupt file', 'CORRUPT');
      } else if (result.errorCode === 'AUTH_REQUIRED' || result.errorCode === 'MANUAL' || result.errorCode === 'AUTOMATION_BLOCKED') {
        this.finish(taskId, 'failed', result.error ?? 'manual download required', result.errorCode);
      } else if (abort.signal.aborted) {
        this.tasks.updateState(taskId, { state: 'paused' });
      } else {
        this.maybeRetry(task, result.error ?? 'download failed', result.errorCode ?? 'DOWNLOAD_FAILED');
      }
    } catch (e) {
      if (abort.signal.aborted) {
        this.tasks.updateState(taskId, { state: 'paused' });
      } else {
        this.maybeRetry(task, String((e as Error)?.message ?? e), ((e as { code?: string }).code) ?? 'DOWNLOAD_FAILED');
      }
    } finally {
      this.running.delete(taskId);
      this.pump();
    }
  }

  private maybeRetry(task: DownloadTask, error: string, code: string): void {
    if (task.attempts <= this.retryLimit && !['AUTH_REQUIRED', 'MANUAL', 'ROBOTS_DENIED', 'LICENSE_UNKNOWN_BLOCK'].includes(code)) {
      log.warn('retrying task', { taskId: task.id, attempt: task.attempts, code });
      this.tasks.updateState(task.id, { state: 'queued', error: `${error} (retry ${task.attempts}/${this.retryLimit})` });
      setTimeout(() => this.pump(), 1000 * task.attempts); // gentle backoff
    } else {
      this.finish(task.id, 'failed', error, code);
    }
  }

  private async finalize(task: DownloadTask, result: import('../types').DownloadResult): Promise<void> {
    if (!result.ok || !result.path) return;
    // Integrity verification is provider-internal (md5 checks) + global sha256.
    const sha = result.sha256 ?? (await sha256File(result.path).catch(() => undefined));
    const registered = await this.library.register({
      file: result.path,
      asset: task.assetRef,
      sha256: sha,
      md5: result.md5,
    });
    this.tasks.updateState(task.id, {
      state: 'completed',
      bytes: result.bytes,
      totalBytes: result.bytes,
      completedAt: new Date().toISOString(),
      destPath: registered.localPath,
    });
    const done = this.tasks.get(task.id)!;
    this.emitProgress(done, 'completed');
    this.emit('task-completed', { taskId: task.id, assetId: registered.id });
    log.info('download completed', { taskId: task.id, asset: registered.name });
  }

  private async quarantine(p: string): Promise<void> {
    if (!p) return;
    const qDir = path.join(this.opts.tmpDir, 'quarantine');
    await ensureDir(qDir);
    await fs.rename(p, path.join(qDir, path.basename(p) + '.' + Date.now())).catch(() => {});
  }

  private finish(taskId: string, state: TaskState, error?: string, code?: string): void {
    this.tasks.updateState(taskId, { state, error, errorCode: code, completedAt: new Date().toISOString() });
    const t = this.tasks.get(taskId);
    if (t) this.emitProgress(t, state);
    this.emit(`task-${state}`, { taskId });
  }

  private emitProgress(task: DownloadTask, state: TaskState, extra?: { speed?: number }): void {
    const ev: DownloadProgressEvent = {
      taskId: task.id,
      bytes: task.bytes,
      totalBytes: task.totalBytes,
      state,
      speedBps: extra?.speed,
    };
    this.emit('progress', ev);
  }
}

const speeds = new Map<string, { t: number; b: number }>();
function speedOf(taskId: string, bytes: number): number {
  const now = Date.now();
  const prev = speeds.get(taskId);
  speeds.set(taskId, { t: now, b: bytes });
  if (!prev) return 0;
  const dt = now - prev.t;
  if (dt < 200) return 0;
  return ((bytes - prev.b) * 1000) / dt;
}
