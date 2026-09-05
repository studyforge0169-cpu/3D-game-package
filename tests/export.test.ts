import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteDatabase } from '../src/core/db/database';
import { AssetsRepo, ProjectsRepo } from '../src/core/db/repositories';
import { ExportService, EXPORT_PRESETS } from '../src/core/export/presets';
import type { LibraryAsset } from '../src/core/types';

let tmp: string;
let db: SqliteDatabase;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugah-exp-'));
  db = new SqliteDatabase(path.join(tmp, 'x.db'));
  db.open();
});
afterAll(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function makeAsset(id: string, name: string, category: string): Promise<LibraryAsset> {
  const assets = new AssetsRepo(db);
  const dir = path.join(tmp, 'lib', category, `${name}_${id}`);
  fs.mkdirSync(path.join(dir, 'Original'), { recursive: true });
  const file = path.join(dir, 'Original', `${name}.glb`);
  fs.writeFileSync(file, Buffer.from(`glb-bytes-${id}`));
  const a: LibraryAsset = {
    id, name, providerId: 'mock', sourceUrl: 'mock://' + id,
    licenseId: 'CC-BY-4.0', licenseCheckedAt: new Date().toISOString(),
    downloadedAt: new Date().toISOString(), format: 'glb', fileSize: 10,
    category: category as LibraryAsset['category'], kind: 'model',
    localPath: file, originalDir: path.join(dir, 'Original'),
    processingStatus: 'original', engineCompatibilityJson: '{}', currentVersion: 1,
    favorite: false, tagsJson: '[]',
  };
  assets.insert(a);
  return a;
}

describe('engine export presets (spec §8)', () => {
  it('defines the four engines with sane roots', () => {
    expect(EXPORT_PRESETS.unity.rootDirName).toBe('Assets');
    expect(EXPORT_PRESETS.unreal.rootDirName).toBe('Content');
    expect(EXPORT_PRESETS.godot.name).toBe('Godot');
    expect(EXPORT_PRESETS.blender.preferredFormats).toContain('blend');
  });

  it('exports into Unity layout with category folders and attribution files', async () => {
    const a = await makeAsset('e1', 'Castle', 'Buildings');
    const svc = new ExportService(new AssetsRepo(db), new ProjectsRepo(db));
    const res = await svc.export({
      engine: 'unity', projectName: 'MyGame', exportRoot: path.join(tmp, 'projects'),
      assetIds: [a.id], source: 'original', collisionPolicy: 'skip',
    }, async () => 'skip');
    expect(res.ok).toBe(true);
    expect(res.exported).toHaveLength(1);
    const written = res.exported[0].files[0];
    expect(written).toContain(path.join('MyGame', 'Assets', 'Buildings'));
    expect(fs.existsSync(written)).toBe(true);
    expect(res.attributionFiles.some((f) => f.endsWith('ATTRIBUTIONS.txt'))).toBe(true);
    expect(fs.readFileSync(res.attributionFiles[0], 'utf8')).toContain('Castle');
  });

  it('never overwrites without a confirmed policy (ask → skip default)', async () => {
    const a = await makeAsset('e2', 'Sword', 'Weapons');
    const svc = new ExportService(new AssetsRepo(db), new ProjectsRepo(db));
    const req = { engine: 'unity' as const, projectName: 'G2', exportRoot: path.join(tmp, 'p2'), assetIds: [a.id], source: 'original' as const, collisionPolicy: 'ask' as const };
    const r1 = await svc.export(req, async () => 'skip');
    expect(r1.exported).toHaveLength(1);
    const r2 = await svc.export(req, async () => 'skip');
    expect(r2.skipped).toContain(a.id);
    const original = fs.readFileSync(r1.exported[0].files[0], 'utf8');
    expect(fs.readFileSync(r2.exported[0]?.files[0] ?? r1.exported[0].files[0], 'utf8')).toBe(original);
  });

  it('rename policy keeps both files', async () => {
    const a = await makeAsset('e3', 'Rock', 'Environment');
    const svc = new ExportService(new AssetsRepo(db), new ProjectsRepo(db));
    const req = { engine: 'unreal' as const, projectName: 'G3', exportRoot: path.join(tmp, 'p3'), assetIds: [a.id], source: 'original' as const, collisionPolicy: 'ask' as const };
    await svc.export(req, async () => 'overwrite');
    const r2 = await svc.export(req, async () => 'rename');
    const files = fs.readdirSync(path.join(tmp, 'p3', 'G3', 'Content', 'Environment'));
    expect(files.length).toBe(2);
    expect(r2.exported[0].files.length).toBe(1);
  });

  it('project records persist for Game → Engine → location selection', () => {
    const projects = new ProjectsRepo(db);
    projects.upsert({ id: 'pr1', name: 'MyGame', engine: 'godot', rootPath: 'C:/Games/MyGame', createdAt: new Date().toISOString() });
    projects.recordExport('pr1', 'godot', 'C:/Games/MyGame', ['f']);
    const p = projects.get('pr1')!;
    expect(p.engine).toBe('godot');
    expect(projects.list()).toHaveLength(1);
  });
});
