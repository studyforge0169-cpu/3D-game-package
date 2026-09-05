/**
 * Library tests (spec §17–§19) — search/info/import over a real mirror repo
 * built offline with the fixture provider. Import verifies integrity and
 * redistribution before copying, picks engine-aware destinations, and
 * generates attribution files (header written exactly once).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli/index';

process.setMaxListeners?.(0);

let tmp = '';
let data = '';
let lib = '';
let repo = '';
let godot = '';

async function cli(...argv: string[]): Promise<{ code: number; out: string[]; err: string[]; json<T = unknown>(): T }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    ['--fixtures', '--home', data, '--library', lib, '--repo', repo, ...argv],
    { out: (l = '') => out.push(l), err: (l = '') => err.push(l) },
  );
  return { code, out, err, json<T = unknown>(): T { return JSON.parse(out.join('\n')) as T; } };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-hub-lib-'));
  data = path.join(tmp, 'data');
  lib = path.join(tmp, 'lib');
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await cli('mirror', 'discover');
  await cli('mirror', 'download');
  await cli('mirror', 'commit');

  godot = path.join(tmp, 'MyGame');
  fs.mkdirSync(godot, { recursive: true });
  fs.writeFileSync(path.join(godot, 'project.godot'), '; godot project marker\n');
}, 120_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('library: search', () => {
  it('searches the local index (offline) with tokens, filters and limits', async () => {
    const r = await cli('library', 'search', 'medieval', 'castle', '--json');
    expect(r.code).toBe(0);
    const doc = r.json<{ index_source: string; total_matches: number; results: { id: string; category: string; license: string; source_url: string }[] }>();
    expect(doc.index_source).toContain('ASSET_INDEX.json');
    expect(doc.results.length).toBeGreaterThanOrEqual(1);
    expect(doc.results[0].id).toBe('mock:mock-castle-01');
    expect(doc.results[0].category).toBe('buildings');
    expect(doc.results[0].source_url).toContain('mock://');

    const cc0 = await cli('library', 'search', '--cc0', '--category', 'weapons', '--json');
    const cc0Doc = cc0.json<{ results: { id: string; license: string }[] }>();
    for (const it of cc0Doc.results) {
      expect(it.license).toMatch(/cc0/i);
    }
    // the CC-BY rifle is excluded by --cc0
    expect(cc0Doc.results.map((x) => x.id)).not.toContain('mock:mock-rifle-01');

    const limited = await cli('library', 'search', '--limit', '3', '--json');
    expect(limited.json<{ results: unknown[] }>().results.length).toBe(3);
  });

  it('returns an actionable message when nothing matches', async () => {
    const r = await cli('library', 'search', 'definitely-not-a-thing', '--json');
    expect(r.code).toBe(0);
    expect(r.json<{ results: unknown[]; total_matches: number }>().total_matches).toBe(0);
  });
});

describe('library: info', () => {
  it('reports verified integrity and full metadata for a mirrored asset', async () => {
    const r = await cli('library', 'info', 'mock:mock-castle-01', '--json');
    expect(r.code).toBe(0);
    const doc = r.json<{ asset: { id: string; license: string; file: string }; integrity: { verified: boolean; actual_sha256: string | null } }>();
    expect(doc.asset.id).toBe('mock:mock-castle-01');
    expect(doc.asset.license).toBe('CC0-1.0');
    expect(doc.asset.file).toMatch(/^original\/.+\.glb$/);
    expect(doc.integrity.verified).toBe(true);
    expect(doc.integrity.actual_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('flags integrity drift (exit 4) when the file no longer matches', async () => {
    const st = JSON.parse(fs.readFileSync(path.join(repo, '.asset-hub-mirror', 'state.json'), 'utf8'));
    const rel = st.entries['mock:mock-castle-01'].mirrorPath as string;
    const fileName = st.entries['mock:mock-castle-01'].fileName as string;
    const file = path.join(repo, rel, 'original', fileName);
    const backup = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, Buffer.from('corrupted'));
      const r = await cli('library', 'info', 'mock:mock-castle-01', '--json');
      expect(r.code).toBe(4);
      const doc = r.json<{ integrity: { verified: boolean } }>();
      expect(doc.integrity.verified).toBe(false);
    } finally {
      fs.writeFileSync(file, backup);
    }
  });
});

describe('library: import', () => {
  it('verifies integrity + redistribution, copies to the engine-aware destination', async () => {
    const r = await cli('library', 'import', 'mock:mock-tree-01', '--project', godot, '--json');
    expect(r.code).toBe(0);
    const doc = r.json<{
      success: boolean; engine: string | null; integrity_verified: boolean;
      copied_files: string[]; attribution_required: boolean; credit_line: string | null;
    }>();
    expect(doc.success).toBe(true);
    expect(doc.engine).toBe('godot');            // detected from project.godot
    expect(doc.integrity_verified).toBe(true);
    expect(doc.copied_files.length).toBe(1);
    expect(doc.copied_files[0]).toMatch(/MyGame[/\\]assets[/\\]vegetation[/\\].+\.glb$/);
    expect(fs.existsSync(doc.copied_files[0])).toBe(true);
    expect(doc.attribution_required).toBe(false); // CC0 tree
  });

  it('writes attribution records for CC-BY assets — header exactly once across imports', async () => {
    const first = await cli('library', 'import', 'mock:mock-rifle-01', '--project', godot, '--json');
    expect(first.code).toBe(0);
    const second = await cli('library', 'import', 'mock:mock-sword-01', '--project', godot, '--json');
    expect(second.code).toBe(0);

    const md = fs.readFileSync(path.join(godot, 'ATTRIBUTIONS.md'), 'utf8');
    const txt = fs.readFileSync(path.join(godot, 'ATTRIBUTIONS.txt'), 'utf8');
    expect(md.split('# Attributions').length - 1).toBe(1);
    expect(md).toContain('AK-style Rifle');
    expect(md).toContain('Fantasy Sword');
    expect(md).toContain('CC-BY-4.0');
    expect(md).toContain('mock://mock-rifle-01');
    expect(txt).toContain('AK-style Rifle');
    expect(txt).toContain('Fantasy Sword');
  });

  it('refuses to import when integrity verification fails', async () => {
    const st = JSON.parse(fs.readFileSync(path.join(repo, '.asset-hub-mirror', 'state.json'), 'utf8'));
    const rel = st.entries['mock:mock-rock-01'].mirrorPath as string;
    const fileName = st.entries['mock:mock-rock-01'].fileName as string;
    const file = path.join(repo, rel, 'original', fileName);
    const backup = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, Buffer.from('tampered'));
      const r = await cli('library', 'import', 'mock:mock-rock-01', '--project', godot, '--json');
      expect(r.code).not.toBe(0);
      const doc = r.json<{ success: boolean; error: { code: string; asset_id: string } }>();
      expect(doc.success).toBe(false);
      expect(doc.error.code).toBe('INVALID_ASSET');
      expect(doc.error.asset_id).toBe('mock:mock-rock-01');
      // nothing was copied (destination may not even exist)
      const dest = path.join(godot, 'assets', 'environments');
      const listing = fs.existsSync(dest) ? fs.readdirSync(dest) : [];
      expect(listing.some((f) => f.includes('rock'))).toBe(false);
    } finally {
      fs.writeFileSync(file, backup);
    }
  });

  it('refuses to import an asset flagged not redistributable', async () => {
    // flip a mirrored asset’s redistribution flag the way a revoked license would
    const st = JSON.parse(fs.readFileSync(path.join(repo, '.asset-hub-mirror', 'state.json'), 'utf8'));
    const rel = st.entries['mock:mock-tree-01'].mirrorPath as string;
    const metaFile = path.join(repo, rel, 'asset.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.redistribution_allowed = false;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    try {
      const r = await cli('library', 'import', 'mock:mock-tree-01', '--project', godot, '--json');
      expect(r.code).not.toBe(0);
      const doc = r.json<{ error: { code: string } }>();
      expect(doc.error.code).toBe('LICENSE_RESTRICTED');
    } finally {
      meta.redistribution_allowed = true;
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    }
  });

  it('never overwrites existing project files without confirmation', async () => {
    const r = await cli('library', 'import', 'mock:mock-tree-01', '--project', godot, '--json');
    expect(r.code).not.toBe(0);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('INVALID_USAGE');
  });
});
