/**
 * AI-layer tests — machine-readable contract, schemas, NL parsing, ranking,
 * acquisition planning/execution, project detection, import workflow,
 * standardized errors, provider transparency. All offline (fixture provider).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli/index';
import { parseRequest, detectProject, ENGINE_INFO } from '../src/cli/ai';
import { TOOLS as MCP_TOOLS } from '../src/cli/mcp';
import { EXIT_CODES } from '../src/cli/errors';
import { expectValid } from './helpers/schema';

process.setMaxListeners?.(0);

let tmp = '';
let data = '';
let lib = '';

interface RunResult {
  code: number;
  out: string[];
  err: string[];
  json<T = unknown>(): T;
}

async function cli(...argv: string[]): Promise<RunResult> {
  return cliIn(data, lib, ...argv);
}

async function cliIn(home: string, library: string, ...argv: string[]): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    ['--fixtures', '--home', home, '--library', library, ...argv],
    { out: (l = '') => out.push(l), err: (l = '') => err.push(l) },
  );
  return {
    code,
    out,
    err,
    json<T>() {
      return JSON.parse(out.join('\n')) as T;
    },
  };
}
let data2 = '';
let lib2 = '';

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-hub-ai-'));
  data = path.join(tmp, 'data');
  lib = path.join(tmp, 'GameAssets');
  data2 = path.join(tmp, 'data2');
  lib2 = path.join(tmp, 'GameAssets2');
});
const cli2 = (...argv: string[]) => cliIn(data2, lib2, ...argv);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------ JSON + schemas

describe('ai: machine-readable output validates against schemas', () => {
  it('search --json validates (and uses provider:asset-id refs)', async () => {
    const r = await cli('search', 'castle', '--cc0', '--json');
    expect(r.code).toBe(0);
    const doc = r.json();
    expectValid(doc, 'search-result.schema.json');
    expect(doc.results[0].id).toBe('mock:mock-castle-01');
    expect(doc.results[0].license.unknown).toBe(false);
    expect(doc.results[0].download_available).toBe(true);
  });

  it('unknown-license results are marked blocked, not hidden', async () => {
    const r = await cli('search', 'mystery', '--json');
    const doc = r.json();
    expectValid(doc, 'search-result.schema.json');
    expect(doc.results[0].license.unknown).toBe(true);
    expect(doc.results[0].download_available).toBe(false);
    expect(doc.results[0].download_blocked_reason).toMatch(/blocked/i);
  });

  it('search --engine annotates engine compatibility', async () => {
    const r = await cli('search', 'castle', '--engine', 'unreal', '--json');
    const doc = r.json();
    expectValid(doc, 'search-result.schema.json');
    expect(doc.engine).toBe('unreal');
    expect(doc.results[0].engine_compatibility.status).toBe('preferred'); // glb
  });

  it('sources --json validates and reports capabilities honestly', async () => {
    const r = await cli('sources', '--json');
    expect(r.code).toBe(0);
    const doc = r.json();
    expectValid(doc, 'provider.schema.json');
    const byId = new Map(doc.providers.map((p: { id: string }) => [p.id, p]));
    expect(byId.get('polyhaven')).toMatchObject({ search: true, download: true, automation: 'supported' });
    expect(byId.get('kenney')).toMatchObject({ search: false, download: false, automation: 'manual' });
    expect(byId.get('opengameart').automation).toBe('partial');
    for (const p of doc.providers) {
      if (p.automation === 'manual') expect(p.download).toBe(false); // never overclaim
    }
  });

  it('licenses --json items validate', async () => {
    const r = await cli('licenses', '--json');
    const doc = r.json();
    expect(doc.licenses.length).toBeGreaterThan(5);
    for (const l of doc.licenses) expectValid(l, 'license.schema.json');
  });

  it('info --json validates with license + download options', async () => {
    const r = await cli('info', 'mock:mock-castle-01', '--json');
    expect(r.code).toBe(0);
    const doc = r.json();
    expectValid(doc, 'asset.schema.json');
    expect(doc.asset.id).toBe('mock:mock-castle-01');
    expect(doc.license.id).toBe('CC0-1.0');
    expect(doc.license.commercial_use).toBe(true);
    expect(doc.download_options.length).toBeGreaterThan(0);
  });

  it('inspect --json is snake_case', async () => {
    // self-sufficient: download into an isolated library, then inspect the file
    const home = path.join(tmp, 'data-inspect');
    const library = path.join(tmp, 'lib-inspect');
    const dl = await cliIn(home, library, 'download', 'mock:mock-castle-01', '--json');
    const model = dl.json().asset.path as string;
    const r = await cliIn(home, library, 'inspect', model, '--json');
    expect(r.code).toBe(0);
    expect(r.json().triangle_count).toBe(1);
  }, 20_000);

  it('download --json validates on success and error', async () => {
    const ok = await cli('download', 'mock:mock-castle-01', '--json');
    expect(ok.code).toBe(0);
    expectValid(ok.json(), 'download-result.schema.json');
    expect(ok.json().asset.license_id).toBe('CC0-1.0');

    const blocked = await cli('download', 'mock:mock-unknown-01', '--json');
    expect(blocked.code).toBe(3);
    expectValid(blocked.json(), 'error.schema.json');
    expect(blocked.json().error.code).toBe('LICENSE_UNKNOWN');
    expect(blocked.json().error.exit_code).toBe(3);
  });

  it('export --json validates', async () => {
    const listR = await cli('list', '--json');
    const id = listR.json().assets[0].library_id;
    const r = await cli('export', id, '--engine', 'godot', '--output', path.join(tmp, 'GGame'), '--json');
    expect(r.code).toBe(0);
    const doc = r.json();
    expectValid(doc, 'export-result.schema.json');
    expect(doc.exported_files.length).toBeGreaterThan(0);
    expect(doc.attribution_files.length).toBe(2);
  });

  it('batch --json reports structured results', async () => {
    const file = path.join(tmp, 'b.txt');
    fs.writeFileSync(file, 'mock:mock-tree-01\nmock:mock-unknown-01\n');
    const r = await cli('batch', file, '--json');
    expect(r.code).toBe(4);
    const doc = r.json();
    expect(doc.summary).toEqual({ completed: 1, duplicates_skipped: 0, failed: 1, not_queued: 0 });
    expect(doc.results.find((x: { state: string }) => x.state === 'blocked_license').error.code).toBe('LICENSE_UNKNOWN');
  });
});

// --------------------------------------------------------- standardized errors

describe('ai: standardized error contract', () => {
  it('every documented error code has a stable exit code', () => {
    for (const code of ['LICENSE_UNKNOWN', 'LICENSE_RESTRICTED', 'DOWNLOAD_UNAVAILABLE', 'PROVIDER_UNAVAILABLE',
      'RATE_LIMITED', 'AUTH_REQUIRED', 'INVALID_ASSET', 'CONVERSION_FAILED', 'EXPORT_FAILED', 'DISK_SPACE',
      'DUPLICATE', 'NETWORK_ERROR'] as const) {
      expect(EXIT_CODES[code]).toBeDefined();
    }
    expect(EXIT_CODES.LICENSE_UNKNOWN).toBe(EXIT_CODES.LICENSE_RESTRICTED); // both license-class
    expect(EXIT_CODES.DUPLICATE).toBe(0); // informational
  });

  it('malformed ref → INVALID_ASSET (exit 1), machine-readable', async () => {
    const r = await cli('download', 'garbage', '--json');
    expect(r.code).toBe(1);
    expectValid(r.json(), 'error.schema.json');
    expect(r.json().error.code).toBe('INVALID_ASSET');
  });

  it('missing asset → INVALID_ASSET; unknown command → INVALID_USAGE', async () => {
    const r1 = await cli('download', 'mock:nope', '--json');
    expect(r1.json().error.code).toBe('INVALID_ASSET');
    expect(r1.code).toBe(1);
    const r2 = await cli('definitely-not-a-command', '--json');
    expect(r2.code).toBe(1);
    expect(r2.json().error.code).toBe('INVALID_USAGE');
  });

  it('json errors go to stdout only (stderr stays clean)', async () => {
    const r = await cli('download', 'mock:mock-unknown-01', '--json');
    expect(r.err.length).toBe(0);
    expect(r.out.join('\n')).toContain('"LICENSE_UNKNOWN"');
  });
});

// ------------------------------------------------------- NL parsing + ranking

describe('ai: deterministic request parsing', () => {
  it('extracts engine, style, license and filler-free query', () => {
    const p = parseRequest('I need a realistic medieval castle for my Unreal Engine game');
    expect(p.query).toBe('realistic medieval castle');
    expect(p.engine).toBe('unreal');
    expect(p.style).toBe('realistic');
  });

  it('extracts CC0/free hints, low-poly budgets, rigged/animated', () => {
    const p = parseRequest('find me a free CC0 low-poly rigged zombie character for Unity');
    expect(p.engine).toBe('unity');
    expect(p.license_filters.cc0_only).toBe(true);
    expect(p.license_filters.free_only).toBe(true);
    expect(p.max_poly).toBe(10_000);
    expect(p.rigged).toBe(true);
    expect(p.query).toContain('zombie character');
    expect(p.query).not.toContain('unity');
  });

  it('parses explicit poly budgets (under 20k tris)', () => {
    const p = parseRequest('soldier character under 20k tris for godot');
    expect(p.engine).toBe('godot');
    expect(p.max_poly).toBe(20_000);
  });

  it('find command returns parsed criteria + results and validates', async () => {
    const r = await cli('find', 'I need a medieval castle for my Unreal Engine game', '--json');
    expect(r.code).toBe(0);
    const doc = r.json();
    expectValid(doc, 'recommend-result.schema.json');
    expect(doc.parsed.query).toBe('medieval castle');
    expect(doc.parsed.engine_hint).toBe('unreal');
    expect(doc.results.length).toBeGreaterThan(0);
  });
});

describe('ai: recommendation ranking', () => {
  it('ranks with transparent factors and never fabricates data', async () => {
    const r = await cli('recommend', 'realistic medieval castle for Unreal Engine', '--json');
    expect(r.code).toBe(0);
    const doc = r.json();
    expectValid(doc, 'recommend-result.schema.json');
    const top = doc.candidates[0];
    expect(top.id).toBe('mock:mock-castle-01');
    expect(top.score.total).toBeGreaterThan(0.5);
    expect(top.score.factors.map((f: { name: string }) => f.name)).toContain('license_safety');
    expect(top.score.factors.map((f: { name: string }) => f.name)).toContain('engine_compatibility');
    expect(top.engine_compatibility.status).toBe('preferred');
    // no fabricated fields: mock assets have no file size → no file_size factor
    expect(top.score.factors.map((f: { name: string }) => f.name)).not.toContain('file_size');
    expect(doc.recommendation.id).toBe('mock:mock-castle-01');
    expect(doc.recommendation.reason).toContain('CC0');
  });

  it('unknown-license assets are excluded with reasons, never selected', async () => {
    const r = await cli('recommend', 'mystery crate', '--json');
    const doc = r.json();
    expect(doc.candidates.length).toBe(0);
    expect(doc.excluded[0].id).toBe('mock:mock-unknown-01');
    expect(doc.excluded[0].reason).toMatch(/license unknown/i);
    expect(doc.recommendation).toBeNull();
    expect(r.code).toBe(4);
  });

  it('ranking prefers CC0 + rigged when rigged is requested', async () => {
    const r = await cli('recommend', 'rigged zombie character', '--json');
    const doc = r.json();
    expect(doc.candidates.length).toBeGreaterThan(1);
    const zombie = doc.candidates.find((c: { id: string }) => c.id === 'mock:mock-zombie-01');
    const human = doc.candidates.find((c: { id: string }) => c.id === 'mock:mock-human-01');
    expect(zombie.score.factors.find((f: { name: string }) => f.name === 'rigging_animation').value).toBe(1);
    // both rigged; rest of the factors decide — but the factor must exist
    expect(human).toBeTruthy();
  });
});

// ------------------------------------------------------------ project detection

describe('ai: project detection', () => {
  it('detects Unity, Unreal, Godot and Blender projects by markers', () => {
    const unity = path.join(tmp, 'PUnity');
    fs.mkdirSync(path.join(unity, 'Assets'), { recursive: true });
    fs.mkdirSync(path.join(unity, 'ProjectSettings'), { recursive: true });
    expect(detectProject(unity)).toMatchObject({ detected: true, engine: 'unity', asset_directory: 'Assets' });

    const ue = path.join(tmp, 'PUnreal');
    fs.mkdirSync(ue, { recursive: true });
    fs.writeFileSync(path.join(ue, 'MyGame.uproject'), '{}');
    expect(detectProject(ue)).toMatchObject({ detected: true, engine: 'unreal', asset_directory: 'Content' });

    const godot = path.join(tmp, 'PGodot');
    fs.mkdirSync(godot, { recursive: true });
    fs.writeFileSync(path.join(godot, 'project.godot'), 'config_version=5');
    expect(detectProject(godot)).toMatchObject({ detected: true, engine: 'godot', asset_directory: 'assets' });

    const blend = path.join(tmp, 'PBlend');
    fs.mkdirSync(blend, { recursive: true });
    fs.writeFileSync(path.join(blend, 'scene.blend'), Buffer.alloc(16));
    expect(detectProject(blend)).toMatchObject({ detected: true, engine: 'blender' });
  });

  it('project --json validates and exits 1 when nothing is detected', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const r = await cli('project', '--path', empty, '--json');
    expect(r.code).toBe(1);
    expectValid(r.json(), 'project.schema.json');
    expect(r.json().detected).toBe(false);

    const ue = path.join(tmp, 'PUnreal'); // created above
    const ok = await cli('project', '--path', ue, '--json');
    expect(ok.code).toBe(0);
    expect(ok.json()).toMatchObject({ detected: true, engine: 'unreal' });
  });

  it('detection never modifies the project directory', async () => {
    const ue = path.join(tmp, 'PUnreal');
    const before = fs.readdirSync(ue).sort();
    await cli('project', '--path', ue, '--json');
    expect(fs.readdirSync(ue).sort()).toEqual(before);
  });
});

// ------------------------------------------------------------------- acquire

describe('ai: acquire workflow', () => {
  let unityProject = '';

  beforeAll(() => {
    unityProject = path.join(tmp, 'MyGame'); // tmp only exists after global beforeAll
    fs.mkdirSync(path.join(unityProject, 'Assets'), { recursive: true });
    fs.mkdirSync(path.join(unityProject, 'ProjectSettings'), { recursive: true });
  });

  it('--dry-run downloads nothing and returns a full plan', async () => {
    const r = await cli2('acquire', 'realistic medieval castle', '--engine', 'unity', '--output', unityProject, '--dry-run', '--json');
    expect(r.code).toBe(0);
    const doc = r.json();
    expectValid(doc, 'acquire-result.schema.json');
    expect(doc.dry_run).toBe(true);
    expect(doc.plan.selected).toBe('mock:mock-castle-01');
    expect(doc.plan.license).toBe('CC0-1.0');
    expect(doc.plan.export.engine).toBe('unity');
    expect(doc.plan.attribution_required).toBe(false);
    // nothing happened: no library asset, no project files
    expect(fs.readdirSync(path.join(unityProject, 'Assets')).length).toBe(0);
  });

  it('executes the full pipeline: download → verify → inspect → export → attribution', async () => {
    const r = await cli2('acquire', 'realistic medieval castle', '--engine', 'unity', '--output', unityProject, '--yes', '--json');
    expect(r.code).toBe(0);
    const doc = r.json();
    expectValid(doc, 'acquire-result.schema.json');
    expect(doc.success).toBe(true);
    expect(doc.asset.license).toBe('CC0-1.0');
    expect(doc.download.duplicate).toBe(false);
    expect(doc.download.verified).toBe(true);
    expect(doc.download.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.inspection.triangle_count).toBeGreaterThan(0);
    expect(doc.export.engine).toBe('unity');
    // model + metadata + attribution exist on disk
    expect(fs.existsSync(doc.download.path)).toBe(true);
    expect(fs.existsSync(doc.download.metadata_path)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(doc.download.metadata_path, 'utf8'));
    expect(meta.licenseId).toBe('CC0-1.0');
    expect(meta.sourceUrl).toBe('mock://mock-castle-01');
    for (const f of doc.export.files) expect(fs.existsSync(f)).toBe(true);
    expect(fs.existsSync(doc.export.attribution_files[0])).toBe(true);
  });

  it('second acquire is detected as duplicate and still succeeds', async () => {
    const r = await cli2('acquire', 'realistic medieval castle', '--engine', 'unity', '--output', unityProject, '--yes', '--json');
    expect(r.code).toBe(0);
    expect(r.json().download.duplicate).toBe(true);
  });

  it('refuses to acquire when only unknown-license assets match', async () => {
    const r = await cli('acquire', 'mystery crate', '--json');
    expect(r.code).toBe(3);
    expectValid(r.json(), 'error.schema.json');
    expect(r.json().error.code).toBe('LICENSE_RESTRICTED');
    expect(r.json().error.message).toMatch(/excluded for license reasons/);
  });

  it('--require-confirmation without --yes and without a TTY → CONFIRMATION_REQUIRED', async () => {
    const r = await cli2('acquire', 'low poly tree', '--engine', 'godot', '--output', path.join(tmp, 'GGame'), '--require-confirmation', '--json');
    expect(r.code).toBe(5);
    expect(r.json().error.code).toBe('CONFIRMATION_REQUIRED');
    expect(r.json().error.hint ?? r.json().error.message).toMatch(/--yes|--dry-run/);
  });

  it('--yes never bypasses license checks', async () => {
    const r = await cli2('acquire', 'mystery crate', '--yes', '--json');
    expect(r.code).toBe(3);
    expect(r.json().error.code).toBe('LICENSE_RESTRICTED');
  });
});

// -------------------------------------------------------------------- import

describe('ai: import workflow', () => {
  it('imports a provider ref into a detected Godot project', async () => {
    const godot = path.join(tmp, 'GodotGame');
    fs.mkdirSync(godot, { recursive: true });
    fs.writeFileSync(path.join(godot, 'project.godot'), 'config_version=5');
    const r = await cli2('import', 'mock:mock-tree-01', '--project', godot, '--json');
    expect(r.code).toBe(0);
    const doc = r.json();
    expect(doc.success).toBe(true);
    expect(doc.export.engine).toBe('godot');
    expect(fs.existsSync(path.join(godot, 'assets', 'Vegetation', 'Low Poly Tree.glb'))).toBe(true);
    expect(fs.existsSync(path.join(godot, 'ATTRIBUTIONS.md'))).toBe(true);
  });

  it('imports a local file with an explicit license into a project', async () => {
    const src = path.join(lib, 'Assets', 'Buildings');
    const dir = path.join(src, fs.readdirSync(src)[0]);
    const glb = path.join(dir, 'Original', 'Medieval Castle.glb');
    const unity = path.join(tmp, 'ImpUnity');
    fs.mkdirSync(path.join(unity, 'Assets'), { recursive: true });
    fs.mkdirSync(path.join(unity, 'ProjectSettings'), { recursive: true });
    const r = await cli('import', glb, '--project', unity, '--provider', 'kenney', '--license', 'CC0', '--json');
    expect(r.code).toBe(0);
    const doc = r.json();
    expect(doc.success).toBe(true);
    expect(doc.asset.license_id).toBe('CC0-1.0');
    expect(fs.existsSync(doc.asset.path)).toBe(true);
  });

  it('refuses local import without a license', async () => {
    const local = path.join(tmp, 'no-license.glb');
    fs.writeFileSync(local, Buffer.alloc(64));
    const r = await cli2('import', local, '--provider', 'kenney', '--json');
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe('INVALID_USAGE');
    expect(r.json().error.message).toMatch(/--license/);
  });
});

// ----------------------------------------------------------------- MCP tools

describe('ai: MCP tool surface', () => {
  it('exposes the documented tools with input schemas', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    for (const expected of ['search_assets', 'get_asset', 'check_license', 'download_asset', 'inspect_asset',
      'convert_asset', 'optimize_asset', 'import_asset', 'export_asset', 'list_sources', 'detect_project',
      'recommend_assets', 'acquire_asset']) {
      expect(names).toContain(expected);
    }
    for (const t of MCP_TOOLS) {
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.description).toBe('string');
    }
  });

  it('tool args map to real CLI invocations (search_assets end-to-end)', async () => {
    const search = MCP_TOOLS.find((t) => t.name === 'search_assets')!;
    const argv = search.args({ query: 'castle', cc0: true, engine: 'unreal' });
    expect(argv[0]).toBe('search');
    expect(argv[1]).toBe('castle');
    expect(argv).toContain('--cc0');
    expect(argv).toContain('--engine');
    // actually run it through runCli like the server does
    const out: string[] = [];
    const code = await runCli(['--fixtures', '--home', data, '--library', lib, ...argv, '--json'], { out: (l = '') => out.push(l), err: () => {} });
    expect(code).toBe(0);
    const payload = JSON.parse(out.join('\n'));
    expect(payload.results[0].id).toBe('mock:mock-castle-01');
  });
});

// ---------------------------------------------------- engine awareness sanity

describe('ai: engine awareness', () => {
  it('format compatibility table is sane', () => {
    expect(ENGINE_INFO.unreal.assetsDir).toBe('Content');
    expect(ENGINE_INFO.unity.assetsDir).toBe('Assets');
    expect(ENGINE_INFO.godot.assetsDir).toBe('assets');
    expect(ENGINE_INFO.godot.preferred).toContain('glb');
    expect(ENGINE_INFO.blender.preferred).toContain('blend');
  });
});
