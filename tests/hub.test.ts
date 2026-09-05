/**
 * End-to-end test of the whole application core (spec §21): search →
 * license check → download → library → duplicates → convert → export →
 * attribution, entirely offline through the MockProvider + temp dirs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hub } from '../src/core/services/hub';

let hub: Hub;
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugah-hub-'));
  hub = new Hub({ userDataDir: path.join(tmp, 'data'), libraryDir: path.join(tmp, 'library'), mockMode: true });
  await hub.init();
});

afterAll(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('application core (offline e2e)', () => {
  it('initializes with database, config, providers and library skeleton', async () => {
    expect(fs.existsSync(path.join(tmp, 'data', 'UGAH.db'))).toBe(true);
    const infos = await hub.providerInfos();
    expect(infos.length).toBeGreaterThanOrEqual(16 + 1);
    for (const cat of ['Characters', 'Weapons', 'Vehicles', 'HDRIs']) {
      expect(fs.existsSync(path.join(tmp, 'library', 'Assets', cat)), cat).toBe(true);
    }
  });

  it('searches and downloads an asset legally, with license gate respected', async () => {
    const pages = await hub.search({ text: 'medieval castle', providers: ['mock'] });
    const results = pages[0].results;
    expect(results.length).toBeGreaterThan(0);
    const castle = results.find((r) => r.name === 'Medieval Castle')!;
    expect(castle.license.id).toBe('CC0-1.0');

    const task = await hub.enqueueDownload('mock', castle.id);
    await waitTask(hub, task.id, 'completed');
    const lib = hub.librarySearch({ text: 'Medieval Castle' });
    expect(lib).toHaveLength(1);
    expect(lib[0].category).toBe('Buildings');
    expect(lib[0].sha256).toHaveLength(64);
  });

  it('unknown-license asset cannot be downloaded', async () => {
    const t = await hub.enqueueDownload('mock', 'mock-unknown-01');
    expect(t.state).toBe('blocked_license');
  });

  it('duplicate detection prevents re-download of the same source asset', async () => {
    const t = await hub.enqueueDownload('mock', 'mock-castle-01');
    expect(t.state).toBe('skipped_duplicate');
  });

  it('converts the downloaded asset to GameReady with LODs and stats', async () => {
    const a = hub.librarySearch({ text: 'Medieval Castle' })[0];
    const res = await hub.convertAsset(a.id, {
      targetFormat: 'glb',
      generateLods: { levels: [{ ratio: 0.5, suffix: '_lod1' }] },
      generateCollision: 'bbox',
      pruneUnusedMaterials: true,
    });
    expect(res.ok).toBe(true);
    expect(res.outputs.some((o) => o.kind === 'model')).toBe(true);
    expect(res.outputs.some((o) => o.kind === 'lod')).toBe(true);
    expect(res.outputs.some((o) => o.kind === 'collision')).toBe(true);
    expect(res.stats!.meshes).toBeGreaterThanOrEqual(1);
    const updated = hub.asset(a.id)!;
    expect(updated.processingStatus).toBe('game_ready');
    // Original untouched
    const original = fs.statSync(updated.localPath);
    expect(original.size).toBe(a.fileSize);
  });

  it('collections group assets and attribution covers them', async () => {
    const a = hub.librarySearch({ text: 'Medieval Castle' })[0];
    const c = hub.createCollection('Starter Pack');
    hub.addToCollection(c.id, a.id);
    expect(hub.collectionAssets(c.id)).toHaveLength(1);
    const doc = hub.attributionForCollection(c.id);
    expect(doc.txt).toContain('Medieval Castle');
    expect(doc.txt.length).toBeGreaterThan(50);
  });

  it('exports to a Unity-style project layout with ATTRIBUTIONS files', async () => {
    const a = hub.librarySearch({ text: 'Medieval Castle' })[0];
    const project = hub.saveProject({ name: 'DemoGame', engine: 'unity', rootPath: path.join(tmp, 'games', 'DemoGame') });
    expect(project.id).toBeTruthy();
    const res = await hub.exportAssets({
      engine: 'unity', projectName: 'DemoGame', exportRoot: path.join(tmp, 'games'),
      assetIds: [a.id], source: 'gameReady', collisionPolicy: 'skip',
    });
    // immediately resolve any conflict prompt
    hub.resolveExportConflicts({ projectName: 'DemoGame', exportRoot: path.join(tmp, 'games') }, 'skip');
    expect(res.ok).toBe(true);
    expect(res.attributionFiles.some((f) => f.endsWith('ATTRIBUTIONS.txt'))).toBe(true);
    expect(hub.listProjects()).toHaveLength(1);
  });

  it('scanDuplicates groups cross-source duplicates', async () => {
    // Same model arriving from a second source (Kenney import):
    const f = path.join(tmp, 'castle-mirror.glb');
    fs.writeFileSync(f, Buffer.from('0101010101010101010101010101'));
    await hub.importLocalFile({
      filePath: f, providerId: 'kenney', name: 'Medieval Castle', licenseRaw: 'CC0',
      sourceUrl: 'https://kenney.nl/assets/castle-mirror',
    });
    await hub.scanDuplicates();
    const groups = hub.duplicates.groups();
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups.some((g) => g.kind === 'cross-source' || g.kind === 'sha256')).toBe(true);
  });

  it('local import registers manually downloaded files with explicit license', async () => {
    const f = path.join(tmp, 'manual.glb');
    fs.writeFileSync(f, Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0x4a, 0x53, 0x4f, 0x4e, 0, 0, 0, 0, 0x20, 0x20]));
    const { asset, duplicates } = await hub.importLocalFile({
      filePath: f, providerId: 'kenney', name: 'Kenney City Kit', licenseRaw: 'CC0', sourceUrl: 'https://kenney.nl/assets/city-kit',
    });
    expect(asset.licenseId).toBe('CC0-1.0');
    expect(asset.category).toBeTruthy();
    void duplicates;
  });

  it('settings: config persists and API keys live in the secret store, never in config', async () => {
    await hub.setApiKey('sketchfab', 'user-secret-token-1');
    await expect(hub.hasApiKey('sketchfab')).resolves.toBe(true);
    await hub.updateConfig({ ui: { theme: 'dark', viewMode: 'grid', perPage: 24 } });
    const raw = fs.readFileSync(path.join(tmp, 'data', 'config.json'), 'utf8');
    expect(raw).not.toContain('user-secret-token-1');
    const secretsRaw = fs.readFileSync(path.join(tmp, 'data', '.ugah-secrets.enc'));
    expect(secretsRaw.toString('utf8')).not.toContain('user-secret-token-1');
    await hub.setApiKey('sketchfab', '');
    await expect(hub.hasApiKey('sketchfab')).resolves.toBe(false);
  });

  it('offline operation: library search/verify works with no providers involved', async () => {
    const all = hub.librarySearch({});
    expect(all.length).toBeGreaterThan(0);
    const a = all[0];
    const v = await hub.verifyAsset(a.id);
    expect(v.ok).toBe(true);
  });
});

function waitTask(hub: Hub, id: string, state: string, timeout = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const t = hub.downloads().find((x) => x.id === id);
      if (t?.state === state) { cleanup(); resolve(); }
      else if (t && ['failed', 'blocked_license', 'corrupt', 'skipped_duplicate'].includes(t.state)) {
        cleanup(); reject(new Error(`task reached ${t.state}: ${t.error}`));
      }
    };
    const onProg = () => check();
    hub.on('download-progress', onProg as never);
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);
    function cleanup() { clearTimeout(timer); hub.off('download-progress', onProg as never); }
    check();
  });
}
