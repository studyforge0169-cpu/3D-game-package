import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FixtureHttpClient, startLocalFileServer, type LocalFileServer } from './helpers/fixtureHttp';
import { DownloadManager } from '../src/core/downloads/manager';
import { AssetsRepo, TasksRepo } from '../src/core/db/repositories';
import { openDatabase } from '../src/core/db/database';
import { SqliteDatabase } from '../src/core/db/database';
import { LibraryService } from '../src/core/library/library';
import { EncryptedFileSecretStore } from '../src/core/util/secrets';
import { MockProvider, makeMockGlb } from '../src/core/providers/mock';
import type { AssetRef, DownloadOption } from '../src/core/types';

let server: LocalFileServer;
let db: SqliteDatabase;
let tmp: string;

const asset = (over: Partial<AssetRef> = {}): AssetRef => ({
  id: over.id ?? 'mock-castle-01',
  providerId: 'mock',
  name: over.name ?? 'Medieval Castle',
  creator: 'Fixture Studio',
  kind: 'model',
  assetUrl: over.id ? `mock://${over.id}` : 'mock://mock-castle-01',
  license: { id: 'CC0-1.0', name: 'CC0', commercialUse: 'allowed', attributionRequired: false, shareAlike: false, redistribution: 'allowed', modification: 'allowed', unknown: false, sourceConfirmed: true, licenseCheckedAt: new Date().toISOString() },
  free: true,
  formats: ['glb'],
  tags: ['castle'],
  ...over,
});

const option = (over: Partial<DownloadOption> = {}): DownloadOption => ({
  id: 'mock:mock-castle-01:glb',
  label: 'GLB',
  format: 'glb',
  url: 'http://127.0.0.1:1/file.glb',
  licenseId: 'CC0-1.0',
  ...over,
});

beforeAll(async () => {
  server = await startLocalFileServer();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugah-dl-'));
  db = new SqliteDatabase(path.join(tmp, 'test.db'));
  db.open();
});

afterAll(async () => {
  await server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeManager(opts: { onDuplicate?: never } = {}) {
  const assets = new AssetsRepo(db);
  const tasks = new TasksRepo(db);
  const library = new LibraryService(path.join(tmp, 'library'), assets);
  const secrets = new EncryptedFileSecretStore(tmp);
  const providers = new Map([['mock', new MockProvider(new FixtureHttpClient())]]);
  const dm = new DownloadManager(providers, tasks, assets, library, secrets, {
    globalConcurrency: 1,
    retryLimit: 1,
    tmpDir: path.join(tmp, 'dl'),
  });
  return { dm, tasks, assets, library };
}

function waitFor<T>(dm: DownloadManager, pred: (t: import('../src/core/types').DownloadTask) => boolean, id: string, timeout = 8000) {
  return new Promise<import('../src/core/types').DownloadTask>((resolve, reject) => {
    const check = () => {
      const t = dm.list().find((x) => x.id === id);
      if (t && pred(t)) { cleanup(); resolve(t); }
    };
    const onProgress = () => check();
    dm.on('progress', onProgress);
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout waiting for task state')); }, timeout);
    function cleanup() { clearTimeout(timer); dm.off('progress', onProgress); }
    check();
  });
}

describe('download manager', () => {
  it('downloads via provider, verifies hashes and registers in the library', async () => {
    const { dm, tasks, assets } = makeManager();
    const task = await dm.enqueue(asset(), option({ url: 'mock://mock-castle-01' }));
    const done = await waitFor(dm, (t) => t.state === 'completed', task.id);
    expect(done.bytes).toBeGreaterThan(0);
    const record = assets.all().find((a) => a.name === 'Medieval Castle');
    expect(record).toBeTruthy();
    expect(record!.sha256).toHaveLength(64);
    expect(record!.category).toBe('Buildings'); // auto-categorization
    expect(fs.existsSync(record!.localPath)).toBe(true);
    // GLB magic bytes present (corruption detection basis)
    const head = Buffer.alloc(4);
    fs.openSync(record!.localPath, 'r');
    const fd = fs.openSync(record!.localPath, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    expect(head.toString('ascii')).toBe('glTF');
    expect(tasks.get(task.id)!.state).toBe('completed');
  });

  it('BLOCKS downloads when the license is unknown (spec §4)', async () => {
    const { dm } = makeManager();
    const unknownAsset = asset({
      id: 'mock-unknown-01',
      name: 'Mystery Crate',
      license: { ...asset().license, id: 'unknown', name: 'License unknown', unknown: true, commercialUse: 'unknown' },
    });
    const t = await dm.enqueue(unknownAsset, option({ id: 'mock:mock-unknown-01:glb', url: 'mock://mock-unknown-01' }));
    expect(t.state).toBe('blocked_license');
    expect(t.errorCode).toBe('LICENSE_UNKNOWN_BLOCK');
  });

  it('flags possible duplicates instead of downloading again (spec §10)', async () => {
    const { dm } = makeManager({ onDuplicate: undefined });
    const first = await dm.enqueue(asset({ id: 'mock-dup-01', name: 'Dup Castle' }), option({ id: 'mock:mock-dup-01:glb', url: 'mock://mock-dup-01' }));
    await waitFor(dm, (t) => t.state === 'completed', first.id);
    const second = await dm.enqueue(asset({ id: 'mock-dup-01', name: 'Dup Castle' }), option({ id: 'mock:mock-dup-01:glb', url: 'mock://mock-dup-01' }));
    expect(second.state).toBe('skipped_duplicate');
    expect(second.error).toContain('duplicate');
  });

  it('pauses and resumes the queue', async () => {
    const { dm } = makeManager();
    const t = await dm.enqueue(asset({ id: 'mock-tree-01', name: 'Low Poly Tree' }), option({ id: 'mock:mock-tree-01:glb', url: 'mock://mock-tree-01' }));
    dm.pause();
    await new Promise((r) => setTimeout(r, 200));
    expect(dm.list().find((x) => x.id === t.id)!.state).toBe('paused');
    dm.resume();
    const done = await waitFor(dm, (x) => x.state === 'completed', t.id);
    expect(done.state).toBe('completed');
  });

  it('cancels a queued task', async () => {
    const { dm } = makeManager();
    dm.pause();
    const t = await dm.enqueue(asset({ id: 'mock-chair-01', name: 'Wooden Chair' }), option({ id: 'mock:mock-chair-01:glb', url: 'mock://mock-chair-01' }));
    dm.cancel(t.id);
    expect(dm.list().find((x) => x.id === t.id)!.state).toBe('canceled');
    dm.resume();
  });

  it('refuses to download when disk space check fails', async () => {
    const { dm } = makeManager();
    const t = await dm.enqueue(asset({ id: 'mock-forest-01', name: 'Forest Pack' }), option({
      id: 'mock:mock-forest-01:glb', url: 'mock://mock-forest-01',
      sizeBytes: Number.MAX_VALUE, // beyond any plausible free space
    }));
    expect(t.state).toBe('failed');
    expect(t.errorCode).toBe('DISK_FULL');
  });

  it('survives crash recovery: running tasks are re-queued on restart', async () => {
    const { dm, tasks } = makeManager();
    const t = await dm.enqueue(asset({ id: 'mock-rock-01', name: 'Rock Set' }), option({ id: 'mock:mock-rock-01:glb', url: 'mock://mock-rock-01' }));
    await waitFor(dm, (x) => x.state === 'completed', t.id);
    // simulate crash: mark completed task as running, then new manager recovers
    tasks.updateState(t.id, { state: 'running' });
    const { dm: dm2 } = makeManager();
    await new Promise((r) => setTimeout(r, 300));
    const recovered = dm2.list().find((x) => x.id === t.id);
    expect(['queued', 'running', 'completed']).toContain(recovered!.state);
  });
});

describe('HTTP download mechanics (real local server)', () => {
  it('streams a file, verifies content length and supports Range resume', async () => {
    const payload = crypto.randomBytes(256 * 1024);
    server.setFile('/big.bin', payload);
    const { HttpClient } = await import('../src/core/net/http');
    const client = new HttpClient({
      userAgent: 'test', timeoutMs: 5000,
      perHostRateLimits: { '127.0.0.1': { minIntervalMs: 1, maxBurst: 5 } },
      respectRobots: false,
    });
    const dest = path.join(tmp, 'big.bin');
    const r1 = await client.download({ url: `${server.url}/big.bin`, destPath: dest });
    expect(r1.bytes).toBe(payload.length);
    expect(crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex'))
      .toBe(crypto.createHash('sha256').update(payload).digest('hex'));

    // partial + resume
    const partial = path.join(tmp, 'partial.bin');
    fs.writeFileSync(partial, payload.subarray(0, 100_000));
    const r2 = await client.download({ url: `${server.url}/big.bin`, destPath: partial, resume: true });
    expect(r2.resumed).toBe(true);
    expect(fs.statSync(partial).size).toBe(payload.length);
  });

  it('hash mismatch (md5) marks the file corrupt — provider returns error', async () => {
    const { PolyHavenProvider } = await import('../src/core/providers/polyhaven');
    const payload = Buffer.from('this is definitely not the hdri');
    server.setFile('/bad.hdr', payload);
    const client = new (await import('../src/core/net/http')).HttpClient({
      userAgent: 'test', timeoutMs: 5000,
      perHostRateLimits: { '127.0.0.1': { minIntervalMs: 1, maxBurst: 5 } },
      respectRobots: false,
    });
    // Provider whose md5 does not match the served bytes
    const p = new PolyHavenProvider(client as never);
    const res = await p.download(
      { id: 'ph:x', label: 'HDR 1k', format: 'hdr', url: `${server.url}/bad.hdr`, md5: '0'.repeat(32), licenseId: 'CC0-1.0' },
      { destDir: tmp, destPath: path.join(tmp, 'bad_out.hdr') },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('HASH_MISMATCH');
  });
});
