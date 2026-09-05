/**
 * CLI test suite — drives runCli() in-process with the fixture (mock)
 * provider, temp data/library dirs, and captured stdout. No network.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli/index';
import { parseObj } from '../src/core/convert/mesh';
import { writeGlb } from '../src/core/convert/gltf';

process.setMaxListeners?.(0);

let tmp = '';
let data = '';
let lib = '';

interface RunResult {
  code: number;
  out: string[];
  err: string[];
}

async function cli(...argv: string[]): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    ['--fixtures', '--home', data, '--library', lib, ...argv],
    { out: (l = '') => out.push(l), err: (l = '') => err.push(l) },
  );
  return { code, out: out.map((l) => l.trim()), err: err.map((l) => l.trim()), };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-hub-cli-'));
  data = path.join(tmp, 'data');
  lib = path.join(tmp, 'GameAssets');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('cli: basics', () => {
  it('prints help and exits 0', async () => {
    const r = await cli('help');
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('asset-hub <command>');
    expect(r.out.join('\n')).toContain('search');
  });

  it('rejects unknown commands with exit 1', async () => {
    const r = await cli('frobnicate');
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain('unknown command');
  });

  it('rejects malformed asset references', async () => {
    const r = await cli('download', 'no-colon-here');
    expect(r.code).toBe(1);
    expect(r.err.join(' ')).toContain('<provider>:<asset-id>');
  });
});

describe('cli: sources & licenses', () => {
  it('sources lists every provider with its automation tier', async () => {
    const r = await cli('sources');
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    for (const p of ['polyhaven', 'ambientcg', 'sketchfab', 'polypizza', 'blenderkit', 'opengameart',
      'kenney', 'quaternius', 'kaykit', 'cgbookcase', 'itch', 'cgtrader', 'turbosquid', 'free3d', 'mixamo', 'fab']) {
      expect(text).toContain(p);
    }
    expect(text).toContain('full');
    expect(text).toContain('manual');
  });

  it('sources --json is machine-readable', async () => {
    const r = await cli('sources', '--json');
    const doc = JSON.parse(r.out.join('\n'));
    expect(Array.isArray(doc.providers)).toBe(true);
    expect(doc.providers.some((x: { id: string }) => x.id === 'polyhaven')).toBe(true);
  });

  it('licenses lists the registry including unknown', async () => {
    const r = await cli('licenses');
    expect(r.out.join('\n')).toContain('CC0-1.0');
    expect(r.out.join('\n')).toContain('CC-BY-4.0');
    expect(r.out.join('\n')).toContain('unknown');
  });
});

describe('cli: search', () => {
  it('finds assets across providers in spec format', async () => {
    const r = await cli('search', 'castle');
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    expect(text).toContain('1. Medieval Castle');
    expect(text).toContain('Source: mock');
    expect(text).toContain('License: CC0');
    expect(text).toContain('(commercial use: YES)');
    expect(text).toContain('Download: free');
  });

  it('marks unknown licenses and blocks them', async () => {
    const r = await cli('search', 'mystery');
    const text = r.out.join('\n');
    expect(text).toContain('LICENSE UNKNOWN');
    expect(text).toContain('BLOCKED');
  });

  it('--cc0 filters to CC0 assets only', async () => {
    const r = await cli('search', 'weapon', '--cc0');
    const text = r.out.join('\n');
    expect(text).not.toContain('AK-style Rifle'); // CC-BY-4.0
    expect(text).not.toContain('Fantasy Sword'); // CC-BY-4.0
  });

  it('--commercial keeps attribution licenses (CC-BY is commercial-safe)', async () => {
    const r = await cli('search', 'weapon', '--commercial');
    expect(r.out.join('\n')).toContain('AK-style Rifle');
  });

  it('--license matches by substring', async () => {
    const r = await cli('search', 'rifle', '--license', 'cc-by-4.0');
    expect(r.out.join('\n')).toContain('AK-style Rifle');
    const r2 = await cli('search', 'rifle', '--license', 'cc0');
    expect(r2.out.join('\n')).not.toContain('AK-style Rifle');
  });

  it('--rigged / --animated filter correctly', async () => {
    const r = await cli('search', 'character', '--rigged');
    const text = r.out.join('\n');
    expect(text).toContain('Zombie Character');
  });

  it('--format excludes non-matching formats', async () => {
    const r = await cli('search', 'castle', '--format', 'fbx');
    expect(r.out.join('\n')).not.toContain('1. Medieval Castle');
  });

  it('--json returns a parseable result document', async () => {
    const r = await cli('search', 'castle', '--json');
    const doc = JSON.parse(r.out.join('\n'));
    expect(doc.results.length).toBeGreaterThan(0);
    expect(doc.results[0].license.id).toBe('CC0-1.0');
    expect(doc.provider_errors).toEqual([]);
  });
});

describe('cli: download & library', () => {
  it('downloads, organizes, writes asset.json and ATTRIBUTIONS, verifies hash', async () => {
    const r = await cli('download', 'mock:mock-castle-01');
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    expect(text).toContain('✓ Medieval Castle');
    expect(text).toContain('SHA-256:');

    const castleDir = path.join(lib, 'Assets', 'Buildings');
    const dirs = fs.readdirSync(castleDir);
    expect(dirs.length).toBe(1);
    const assetDir = path.join(castleDir, dirs[0]);
    expect(fs.existsSync(path.join(assetDir, 'asset.json'))).toBe(true);
    expect(fs.existsSync(path.join(assetDir, 'Original', 'Medieval Castle.glb'))).toBe(true);

    const meta = JSON.parse(fs.readFileSync(path.join(assetDir, 'asset.json'), 'utf8'));
    expect(meta.licenseId).toBe('CC0-1.0');
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.providerId).toBe('mock');
    expect(meta.sourceUrl).toBe('mock://mock-castle-01');

    expect(fs.existsSync(path.join(lib, 'ATTRIBUTIONS.md'))).toBe(true);
    expect(fs.existsSync(path.join(lib, 'ATTRIBUTIONS.txt'))).toBe(true);
  });

  it('skips duplicate downloads instead of re-downloading', async () => {
    const before = fs.readdirSync(path.join(lib, 'Assets', 'Buildings')).length;
    const r = await cli('download', 'mock:mock-castle-01');
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('already in library');
    const after = fs.readdirSync(path.join(lib, 'Assets', 'Buildings')).length;
    expect(after).toBe(before);
  });

  it('blocks unknown-license downloads with exit code 3', async () => {
    const r = await cli('download', 'mock:mock-unknown-01');
    expect(r.code).toBe(3);
    expect(r.err.join(' ')).toMatch(/blocked/i);
    expect(r.err.join(' ')).toContain('LICENSE_UNKNOWN');
  });

  it('--category overrides the auto-category', async () => {
    const r = await cli('download', 'mock:mock-tree-01', '--category', 'environment');
    expect(r.code).toBe(0);
    const envDir = path.join(lib, 'Assets', 'Environment');
    expect(fs.existsSync(envDir)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(envDir, fs.readdirSync(envDir)[0], 'asset.json'), 'utf8'));
    expect(meta.category).toBe('Environment');
  });

  it('rejects invalid categories', async () => {
    const r = await cli('download', 'mock:mock-chair-01', '--category', 'NotACategory');
    expect(r.code).toBe(1);
    expect(r.err.join(' ')).toContain('unknown category');
  });

  it('list shows library contents with ids for export', async () => {
    const r = await cli('list');
    expect(r.out.join('\n')).toContain('Medieval Castle');
    const rj = await cli('list', '--json');
    const assets = JSON.parse(rj.out.join('\n')).assets;
    expect(assets.length).toBeGreaterThanOrEqual(2);
    expect(assets.every((a: { library_id: string }) => /^[0-9a-f-]{36}$/.test(a.library_id))).toBe(true);
  });
});

describe('cli: batch', () => {
  it('processes a download list with retries/summary and reports failures', async () => {
    const file = path.join(tmp, 'batch.txt');
    fs.writeFileSync(file, '# comment line\nmock:mock-rifle-01\nmock:mock-unknown-01\nmock:mock-nope\n');
    const r = await cli('batch', file);
    expect(r.code).toBe(4);
    const text = r.out.join('\n');
    expect(text).toContain('✓ mock:mock-rifle-01');
    expect(text).toContain('BLOCKED');
    expect(r.err.join('\n')).toContain('asset not found');
    expect(text).toContain('Summary: 1 completed');
  });
});

describe('cli: inspect / convert / optimize', () => {
  let glb = '';
  beforeAll(() => {
    glb = path.join(tmp, 'test-model.glb');
    const model = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    writeGlb(model, glb);
  });

  it('inspect reports mesh stats', async () => {
    const r = await cli('inspect', glb);
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    expect(text).toContain('Triangles: 1');
    expect(text).toContain('Vertices: 3');
  });

  it('inspect --json parses', async () => {
    const r = await cli('inspect', glb, '--json');
    const info = JSON.parse(r.out.join('\n'));
    expect(info.triangle_count).toBe(1);
    expect(info.format).toBe('glb');
  });

  it('inspect fails cleanly on missing files', async () => {
    const r = await cli('inspect', path.join(tmp, 'missing.glb'));
    expect(r.code).toBe(1);
    expect(r.err.join(' ')).toContain('file not found');
  });

  it('convert glb→gltf produces real outputs', async () => {
    const out = path.join(tmp, 'converted');
    const r = await cli('convert', glb, '--format', 'gltf', '--out', out);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(out, 'test-model.gltf'))).toBe(true);
  });

  it('convert refuses unsupported targets honestly', async () => {
    const r = await cli('convert', glb, '--format', 'fbx');
    expect(r.code).toBe(2); // CONVERSION_FAILED class
    expect(r.err.join(' ')).toContain('not supported natively');
  });

  it('optimize applies the game-ready preset', async () => {
    const out = path.join(tmp, 'optimized');
    const r = await cli('optimize', glb, '--out', out);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(out, 'test-model.glb'))).toBe(true);
  });
});

describe('cli: export', () => {
  it('exports a library asset to an Unreal layout with attributions', async () => {
    await cli('download', 'mock:mock-castle-01'); // ensure present (self-sufficient test)
    const listR = await cli('list', '--json');
    const assets = JSON.parse(listR.out.join('\n')).assets as { library_id: string; name: string }[];
    const castle = assets.find((a) => a.name === 'Medieval Castle')!;
    const out = path.join(tmp, 'ExportGame');
    const r = await cli('export', castle.library_id, '--engine', 'unreal', '--output', out, '--project', 'Demo');
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(out, 'Demo', 'Content'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'Demo', 'ATTRIBUTIONS.md'))).toBe(true);
  });

  it('exports a provider:id reference by downloading it first', async () => {
    const out = path.join(tmp, 'UnityGame');
    const r = await cli('export', 'mock:mock-car-01', '--engine', 'unity', '--output', out);
    expect(r.code).toBe(0);
    // --output is the project root; files land under <root>/Assets/<Category>/ (Unity preset)
    expect(fs.existsSync(path.join(out, 'Assets', 'Vehicles'))).toBe(true);
  });

  it('requires --engine and --output', async () => {
    const r = await cli('export', 'mock:mock-car-01');
    expect(r.code).toBe(1);
    expect(r.err.join(' ')).toContain('--engine');
  });
});

describe('cli: update & attributions', () => {
  it('update re-checks licenses against the provider', async () => {
    const r = await cli('update');
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    expect(text).toContain('Medieval Castle');
    expect(text).toContain('unchanged: CC0-1.0');
  });

  it('update --dry-run --id checks one asset', async () => {
    const listR = await cli('list', '--json');
    const assets = JSON.parse(listR.out.join('\n')).assets as { library_id: string }[];
    const r = await cli('update', '--dry-run', '--id', assets[0].library_id);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('(dry run)');
  });

  it('attributions regenerates ATTRIBUTIONS files', async () => {
    const dir = path.join(tmp, 'credits');
    const r = await cli('attributions', '--output', dir);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'ATTRIBUTIONS.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'ATTRIBUTIONS.txt'))).toBe(true);
  });
});

describe('cli: configuration', () => {
  it('config path shows the config file location', async () => {
    const r = await cli('config', 'path');
    expect(r.out[0]).toBe(path.join(data, 'config.json'));
  });

  it('config set/get round-trips values', async () => {
    const set = await cli('config', 'set', 'downloads.globalConcurrency', '5');
    expect(set.code).toBe(0);
    const get = await cli('config', 'get', 'downloads.globalConcurrency');
    expect(JSON.parse(get.out.join('\n'))).toBe(5);
    const setArr = await cli('config', 'set', 'enabledProviders', 'polyhaven,ambientcg');
    expect(setArr.code).toBe(0);
    const getArr = await cli('config', 'get', 'enabledProviders');
    expect(JSON.parse(getArr.out.join('\n'))).toEqual(['polyhaven', 'ambientcg']);
  });

  it('config set refuses to disable robots.txt compliance', async () => {
    const r = await cli('config', 'set', 'network.respectRobots', 'false');
    expect(r.code).toBe(1);
    expect(r.err.join(' ')).toContain('robots.txt compliance cannot be disabled');
  });

  it('config set rejects unknown keys', async () => {
    const r = await cli('config', 'set', 'nope.key', '1');
    expect(r.code).toBe(1);
    expect(r.err.join(' ')).toContain('unknown config key');
  });

  it('key set/list/remove manages API keys without printing them', async () => {
    const set = await cli('key', 'set', 'polypizza', 'SECRET-VALUE-123');
    expect(set.code).toBe(0);
    const list = await cli('key', 'list');
    expect(list.out.join('\n')).toContain('polypizza');
    expect(list.out.join('\n')).toMatch(/set ✓/);
    expect(list.out.join('\n')).not.toContain('SECRET-VALUE-123'); // never printed
    const rm = await cli('key', 'remove', 'polypizza');
    expect(rm.code).toBe(0);
    const list2 = await cli('key', 'list');
    expect(list2.out.join('\n')).not.toMatch(/set ✓/);
  });

  it('config file persists between invocations', async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    expect(cfg.downloads.globalConcurrency).toBe(5);
    // libraryDir must NOT be hijacked by the CLI's --library override
    expect(cfg.libraryDir).not.toBe(lib);
  });
});
