import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrate, openDatabase, SqliteDatabase } from '../src/core/db/database';
import { AssetsRepo, CollectionsRepo, ProjectsRepo, TasksRepo } from '../src/core/db/repositories';
import type { LibraryAsset } from '../src/core/types';

let tmp: string;

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugah-db-')); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sampleAsset(id: string): LibraryAsset {
  return {
    id, name: `Asset ${id}`, providerId: 'polyhaven', sourceUrl: `https://x/${id}`,
    licenseId: 'CC0-1.0', licenseCheckedAt: new Date().toISOString(),
    downloadedAt: new Date().toISOString(), format: 'glb', fileSize: 1234,
    category: 'Props', kind: 'model', localPath: '/x', originalDir: '/x/Original',
    processingStatus: 'original', engineCompatibilityJson: '{}', currentVersion: 1,
    favorite: false, tagsJson: '["a","b"]',
  };
}

describe('database', () => {
  it('opens, migrates and reports schema version', async () => {
    const file = path.join(tmp, 'a.db');
    const db = new SqliteDatabase(file);
    db.open();
    expect(migrate(db)).toBeGreaterThanOrEqual(1);
    db.close();
    const reopened = await openDatabase(file);
    expect(reopened.isOpen).toBe(true);
    reopened.close();
  });

  it('WAL journal is enabled for crash safety', () => {
    const db = new SqliteDatabase(path.join(tmp, 'b.db'));
    db.open();
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
    db.close();
  });

  it('transactions roll back atomically on failure', () => {
    const db = new SqliteDatabase(path.join(tmp, 'c.db'));
    db.open();
    const assets = new AssetsRepo(db);
    expect(() =>
      db.transaction(() => {
        assets.insert(sampleAsset('t1'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(assets.get('t1')).toBeNull();
    db.close();
  });

  it('asset repository: insert/search/update/favorites/categories', () => {
    const db = new SqliteDatabase(path.join(tmp, 'd.db'));
    db.open();
    const assets = new AssetsRepo(db);
    assets.insert(sampleAsset('a1'));
    assets.insert({ ...sampleAsset('a2'), name: 'Sword of Doom', category: 'Weapons', favorite: true });
    expect(assets.get('a1')!.name).toBe('Asset a1');
    expect(assets.search({ text: 'sword' }).map((a) => a.id)).toEqual(['a2']);
    expect(assets.search({ favorites: true }).map((a) => a.id)).toEqual(['a2']);
    expect(assets.search({ categories: ['Weapons'] }).map((a) => a.id)).toEqual(['a2']);
    assets.update('a1', { favorite: true, polyCount: 42 });
    expect(assets.get('a1')!.favorite).toBe(true);
    expect(assets.get('a1')!.polyCount).toBe(42);
    assets.delete('a1');
    expect(assets.get('a1')).toBeNull();
    db.close();
  });

  it('collections + tasks + projects repositories round-trip', () => {
    const db = new SqliteDatabase(path.join(tmp, 'e.db'));
    db.open();
    const cols = new CollectionsRepo(db);
    const tasks = new TasksRepo(db);
    const projects = new ProjectsRepo(db);
    const c = cols.create('Pack A');
    expect(cols.list().map((x) => x.id)).toContain(c.id);
    const t = {
      id: 'task-1', providerId: 'mock', assetRef: { id: 'a', providerId: 'mock', name: 'X', kind: 'model', assetUrl: 'mock://a', license: {} as never, free: true, formats: [] },
      optionId: 'o', url: 'mock://dl', destPath: '/x', category: 'Other' as const,
      state: 'queued' as const, bytes: 0, attempts: 0, createdAt: new Date().toISOString(), priority: 0,
    };
    tasks.upsert(t);
    tasks.updateState('task-1', { state: 'running', bytes: 10 });
    expect(tasks.get('task-1')!.state).toBe('running');
    expect(tasks.list()).toHaveLength(1);
    projects.upsert({ id: 'p1', name: 'MyGame', engine: 'unity', rootPath: '/p', createdAt: new Date().toISOString() });
    projects.recordExport('p1', 'unity', '/p', ['f1']);
    expect(projects.get('p1')!.name).toBe('MyGame');
    db.close();
  });

  it('creates rolling backups via VACUUM INTO', async () => {
    const db = new SqliteDatabase(path.join(tmp, 'f.db'));
    db.open();
    new AssetsRepo(db).insert(sampleAsset('bk'));
    const backupDir = path.join(tmp, 'backups');
    const dest = await db.backup(backupDir, 2);
    expect(fs.existsSync(dest)).toBe(true);
    // restore-able copy contains the data
    const restored = new SqliteDatabase(dest);
    restored.open();
    expect(new AssetsRepo(restored).get('bk')).toBeTruthy();
    restored.close();
    db.close();
  });
});
