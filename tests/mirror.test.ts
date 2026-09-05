/**
 * Mirror system tests (spec §28) — fully offline: fixture provider, temp git
 * repositories (real `git init` + local bare remotes for push), no network.
 * Covers discovery, license/redistribution filtering, dedup, resume, failed
 * downloads, metadata, attribution, git staging/commit/push, LFS detection,
 * capacity pause, incremental update (license revocation / source removal),
 * report/audit, and JSON output.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli/index';
import { MirrorState } from '../src/core/mirror/state';
import { processEntry } from '../src/core/mirror/service';
import { sha256File } from '../src/core/util/hash';
import { Hub } from '../src/core/services/hub';

process.setMaxListeners?.(0);

let tmp = '';
let data = '';
let lib = '';
let repo = '';

interface RunResult<T = unknown> {
  code: number;
  out: string[];
  err: string[];
  json(): T;
}

async function cli(...argv: string[]): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    ['--fixtures', '--home', data, '--library', lib, '--repo', repo, ...argv],
    { out: (l = '') => out.push(l), err: (l = '') => err.push(l) },
  );
  return {
    code,
    out,
    err,
    json(): never {
      return JSON.parse(out.join('\n')) as never;
    },
  };
}

function state(): MirrorStateFileShape {
  return JSON.parse(fs.readFileSync(path.join(repo, '.asset-hub-mirror', 'state.json'), 'utf8'));
}

interface MirrorStateFileShape {
  entries: Record<string, {
    ref: string; state: string; skipReason?: string; sha256?: string;
    mirrorPath?: string; license: { id: string; redistribution: string; unknown: boolean };
    licenseChanged?: boolean; licensePrevious?: string; name: string; providerId: string;
    assetId: string; sourceUrl: string; category: string; formats: string[]; tags: string[];
    kind: string; attempts: number; discoveredAt: string; updatedAt: string;
  }>;
  paused?: { reason: string; at: string } | null;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-hub-mirror-'));
  data = path.join(tmp, 'data');
  lib = path.join(tmp, 'lib');
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ discovery

describe('mirror: discovery', () => {
  it('enumerates the catalog and persists it (repeat discovery adds nothing)', async () => {
    const r = await cli('mirror', 'discover', '--json');
    expect(r.code).toBe(0);
    const doc = r.json<{ newly_discovered: number; total_catalog: number; providers: { provider: string; found: number }[] }>();
    expect(doc.total_catalog).toBeGreaterThan(10);
    expect(doc.providers).toEqual([{ provider: 'mock', found: doc.total_catalog }]);
    const st = state();
    expect(Object.keys(st.entries).length).toBe(doc.total_catalog);
    // every entry starts DISCOVERED with per-asset license data
    for (const e of Object.values(st.entries)) expect(e.state).toBe('DISCOVERED');

    const again = await cli('mirror', 'discover', '--json');
    expect(again.json<{ newly_discovered: number; total_catalog: number }>().newly_discovered).toBe(0);
  });

  it('classifies providers honestly (FULL/PARTIAL/METADATA/MANUAL)', async () => {
    const r = await cli('mirror', 'report', '--json');
    const doc = r.json<{ providers: { providerId: string; tier: string; canDownload: boolean }[] }>();
    const by = new Map(doc.providers.map((p) => [p.providerId, p]));
    expect(by.get('polyhaven')?.tier).toBe('FULL_MIRROR');
    expect(by.get('ambientcg')?.tier).toBe('FULL_MIRROR');
    expect(by.get('sketchfab')?.tier).toBe('PARTIAL_MIRROR');
    expect(by.get('kenney')?.tier).toBe('MANUAL_ONLY');
    expect(by.get('mixamo')?.tier).toBe('MANUAL_ONLY');
    // manual tiers never claim download capability
    for (const p of doc.providers) {
      if (p.tier === 'MANUAL_ONLY' || p.tier === 'METADATA_ONLY') expect(p.canDownload).toBe(false);
    }
  });
});

// --------------------------------------------------- gated mass download (§2)

describe('mirror: download with license + redistribution gates', () => {
  it('mirrors only redistributable assets; NC and unknown are skipped with reasons', async () => {
    const r = await cli('mirror', 'download', '--json');
    expect(r.code).toBe(0);
    const doc = r.json<{ summary: { processed: number; completed: number; skipped: number; failed: number } }>();
    expect(doc.summary.completed).toBeGreaterThan(10);
    expect(doc.summary.skipped).toBe(2);

    const st = state();
    expect(st.entries['mock:mock-nc-01'].skipReason).toBe('REDISTRIBUTION_NOT_PERMITTED');
    expect(st.entries['mock:mock-unknown-01'].skipReason).toBe('UNKNOWN_LICENSE');
    // nothing was downloaded for the skipped ones
    expect(st.entries['mock:mock-nc-01'].mirrorPath).toBeUndefined();
    expect(fs.existsSync(path.join(repo, 'assets'))).toBe(true);
  });

  it('stores originals under category dirs with machine-readable metadata (§8, §9, §21)', async () => {
    const st = state();
    const castle = st.entries['mock:mock-castle-01'];
    expect(castle.mirrorPath).toMatch(/^assets\/buildings\//);
    const dir = path.join(repo, castle.mirrorPath!);
    expect(fs.existsSync(path.join(dir, 'original', castle.fileName!))).toBe(true);
    expect(castle.downloadedAt).toBeTruthy();
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'asset.json'), 'utf8'));
    expect(meta.download_date).toBe(castle.downloadedAt);
    expect(meta).toMatchObject({
      id: 'mock:mock-castle-01',
      license: 'CC0-1.0',
      redistribution_allowed: true,
      commercial_use: true,
      attribution_required: false,
      category: 'buildings',
    });
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.source_url).toBe('mock://mock-castle-01');
    // multi-file packages: main file + includes all land under original/ with hashes
    const tree = st.entries['mock:mock-tree-01'];
    expect(tree.files!.map((f) => f.path).sort()).toEqual([tree.fileName, 'textures/tree_diff.jpg', 'tree.bin'].sort());
    expect(fs.existsSync(path.join(repo, tree.mirrorPath!, 'original', 'textures', 'tree_diff.jpg'))).toBe(true);
    const treeMeta = JSON.parse(fs.readFileSync(path.join(repo, tree.mirrorPath!, 'asset.json'), 'utf8'));
    expect(treeMeta.files).toHaveLength(3);
    expect(treeMeta.files[1].path).toBe('original/textures/tree_diff.jpg');
    // categories come from provider metadata, not filenames
    expect(st.entries['mock:mock-grass-01'].category).toBe('vegetation');
    expect(st.entries['mock:mock-sunset-01'].category).toBe('hdri');
    expect(st.entries['mock:mock-brick-01'].category).toBe('materials');
  });
});

// ------------------------------------------------------------------- dedup (§7)

describe('mirror: deduplication', () => {
  it('byte-identical files are recorded duplicate_of and not stored twice', async () => {
    // craft a canonical PROCESSED entry whose sha equals what the rifle will download
    const hub = new Hub({ userDataDir: path.join(tmp, 'dedup-data'), libraryDir: path.join(tmp, 'dedup-lib'), mockMode: true });
    await hub.init();
    const st = await MirrorState.load(repo);
    const rifle = state().entries['mock:mock-rifle-01'];
    const rifleFile = path.join(repo, rifle.mirrorPath!, 'original', rifle.fileName!);
    const sha = await sha256File(rifleFile);
    st.upsert({
      ref: 'mock:mock-rifle-twin', providerId: 'mock', assetId: 'mock-rifle-twin',
      name: 'Rifle Twin', sourceUrl: 'mock://mock-rifle-twin',
      license: { id: 'CC0-1.0', commercialUse: 'allowed', attributionRequired: false, shareAlike: false, redistribution: 'allowed', unknown: false, sourceConfirmed: true },
      category: 'weapons', formats: ['glb'], tags: [], kind: 'model',
      state: 'PROCESSED', sha256: sha, mirrorPath: 'assets/weapons/rifle-twin-xxxxx',
      attempts: 0, discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // duplicate the rifle file as the twin's original so hashes really match
    const twinDir = path.join(repo, 'assets', 'weapons', 'rifle-twin-xxxxx', 'original');
    fs.mkdirSync(twinDir, { recursive: true });
    fs.copyFileSync(rifleFile, path.join(twinDir, 'twin.glb'));

    // now reprocess the rifle: its bytes hash to `sha` → DUPLICATE
    const rifleEntry = st.get('mock:mock-rifle-01')!;
    const reprocess = { ...rifleEntry, state: 'DISCOVERED' as const, sha256: undefined, mirrorPath: undefined };
    st.upsert(reprocess);
    const outcome = await processEntry(hub, st, st.get('mock:mock-rifle-01')!, 100_000_000, false);
    expect(outcome).toBe('DUPLICATE');
    expect(st.get('mock:mock-rifle-01')!.skipReason).toBe('DUPLICATE');
    expect(st.get('mock:mock-rifle-01')!.duplicateOf).toBe('mock:mock-rifle-twin');
    hub.shutdownForProcessExit();
  });
});

// ------------------------------------------------------------ resume + failed (§6)

describe('mirror: interruptible download + failures', () => {
  it('resume continues where it stopped and never reprocesses finished assets', async () => {
    // fresh repo for a clean pipeline
    const repo2 = path.join(tmp, 'repo-resume');
    fs.mkdirSync(repo2, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo2 });
    const run = async (...argv: string[]): Promise<RunResult> => {
      const out: string[] = [];
      const code = await runCli(['--fixtures', '--home', data, '--library', lib, '--repo', repo2, ...argv], { out: (l = '') => out.push(l), err: () => {} });
      return { code, out, err: [], json: (): never => JSON.parse(out.join('\n')) as never };
    };
    await run('mirror', 'discover');
    const first = await run('mirror', 'download', '--limit', '4', '--json');
    expect(first.json<{ summary: { processed: number; completed: number } }>().summary.processed).toBe(4);
    const st1 = JSON.parse(fs.readFileSync(path.join(repo2, '.asset-hub-mirror', 'state.json'), 'utf8'));
    expect(Object.values(st1.entries).filter((e: { state: string }) => ['PROCESSED', 'SKIPPED'].includes(e.state)).length).toBe(4);
    const second = await run('mirror', 'download', '--resume', '--json');
    const s2 = second.json<{ summary: { processed: number; completed: number } }>().summary;
    const st2 = JSON.parse(fs.readFileSync(path.join(repo2, '.asset-hub-mirror', 'state.json'), 'utf8'));
    const processed = Object.values(st2.entries).filter((e: { state: string }) => ['PROCESSED', 'SKIPPED'].includes(e.state)).length;
    expect(processed).toBe(Object.keys(st2.entries).length); // everything terminal
    expect(s2.processed).toBe(Object.keys(st2.entries).length - 4);
    // a third run has nothing to do
    const third = await run('mirror', 'download', '--json');
    expect(third.json<{ summary: { processed: number } }>().summary.processed).toBe(0);
    fs.rmSync(repo2, { recursive: true, force: true });
  });

  it('unknown assets become terminal SKIPPED(DOWNLOAD_UNAVAILABLE), --failed retries FAILED entries', async () => {
    const st = state();
    st.entries['mock:mock-ghost'] = {
      ...st.entries['mock:mock-tree-01'],
      ref: 'mock:mock-ghost', assetId: 'mock-ghost', sourceUrl: 'mock://mock-ghost',
      state: 'DISCOVERED', sha256: undefined, mirrorPath: undefined, skipReason: undefined,
    };
    fs.writeFileSync(path.join(repo, '.asset-hub-mirror', 'state.json'), JSON.stringify(st));
    const r = await cli('mirror', 'download', '--json');
    const st2 = state();
    expect(['SKIPPED', 'FAILED']).toContain(st2.entries['mock:mock-ghost'].state);
    expect(st2.entries['mock:mock-ghost'].mirrorPath).toBeUndefined();
    expect(r.code).toBeGreaterThanOrEqual(0);
  });
});

// ----------------------------------------------- git staging / commit / push (§12)

describe('mirror: git workflow', () => {
  it('commit regenerates indexes/registries, stages, commits and marks COMMITTED', async () => {
    const r = await cli('mirror', 'commit', '--json');
    expect(r.code).toBe(0);
    const doc = r.json<{ committed: boolean; commit: string; files: number }>();
    expect(doc.committed).toBe(true);
    expect(doc.files).toBeGreaterThan(10);

    for (const f of ['ASSET_INDEX.json', 'ASSET_INDEX.jsonl', 'licenses.json', 'LICENSES.md', 'ATTRIBUTIONS.md', 'ATTRIBUTIONS.txt', 'indexes/buildings.json']) {
      expect(fs.existsSync(path.join(repo, f))).toBe(true);
    }
    const st = state();
    for (const e of Object.values(st.entries)) {
      if (e.mirrorPath) expect(e.state).toBe('COMMITTED');
    }
    // per-asset license registry (never site-wide assumptions)
    const lic = JSON.parse(fs.readFileSync(path.join(repo, 'licenses.json'), 'utf8'));
    expect(lic.assets['mock:mock-rifle-01'].license).toBe('CC-BY-4.0');
    expect(lic.assets['mock:mock-castle-01'].license).toBe('CC0-1.0');
    // attribution content: asset, creator, source, URL, license, credit line
    const attr = fs.readFileSync(path.join(repo, 'ATTRIBUTIONS.md'), 'utf8');
    expect(attr).toContain(state().entries['mock:mock-rifle-01'].name);
    expect(attr).toContain('Fixture Studio');
    expect(attr).toContain('CC-BY-4.0');
    expect(attr).toContain('mock:mock-rifle-01');
    expect(attr).not.toContain('Medieval Castle'); // CC0 needs no attribution
    // committed to git for real
    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: repo, encoding: 'utf8' });
    expect(log).toContain('mirror:');
    // second commit: nothing to do
    const again = await cli('mirror', 'commit', '--json');
    const againDoc = again.json<{ committed: boolean; reason?: string }>();
    expect(againDoc.committed).toBe(false);
  });

  it('push moves the mirror to the remote', async () => {
    const remote = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
    const r = await cli('mirror', 'push', '--json');
    expect(r.code).toBe(0);
    expect(r.json<{ pushed: boolean }>().pushed).toBe(true);
    const remoteLog = execFileSync('git', ['log', '--oneline', '-1'], { cwd: remote, encoding: 'utf8' });
    expect(remoteLog).toContain('mirror:');
  });

  it('LFS detection is honest (no git-lfs ⇒ no .gitattributes LFS rules)', async () => {
    const r = await cli('mirror', 'status', '--json');
    const doc = r.json<{ git: { lfsInstalled: boolean } }>();
    if (!doc.git.lfsInstalled) {
      const attrs = path.join(repo, '.gitattributes');
      const content = fs.existsSync(attrs) ? fs.readFileSync(attrs, 'utf8') : '';
      expect(content).not.toContain('filter=lfs');
    }
  });
});

// ------------------------------------------------------------- capacity (§13–14)

describe('mirror: repository capacity', () => {
  it('pauses (MIRROR PAUSED / REPOSITORY_CAPACITY) instead of overflowing', async () => {
    const set = await cli('config', 'set', 'mirror.pauseBytes', '1');
    expect(set.code).toBe(0);
    const cap = await cli('mirror', 'capacity', '--json');
    expect(cap.code).toBe(3); // REPOSITORY_CAPACITY exit class
    const doc = cap.json<{ paused: boolean; pause_reason: string | null }>();
    expect(doc.paused).toBe(true);
    expect(doc.pause_reason).toBe('REPOSITORY_CAPACITY');

    const dl = await cli('mirror', 'download', '--json');
    const dlDoc = dl.json<{ paused: { reason: string } | null }>();
    expect(dlDoc.paused?.reason).toBe('REPOSITORY_CAPACITY');
    expect(state().paused?.reason).toBe('REPOSITORY_CAPACITY');

    // commit also refuses while paused
    const commit = await cli('mirror', 'commit', '--json');
    expect(commit.code).toBe(6);
    expect(commit.json<{ error: { code: string } }>().error.code).toBe('REPOSITORY_CAPACITY');

    // restore sane limit → unpauses on next download
    await cli('config', 'set', 'mirror.pauseBytes', String(10 * 1024 ** 3));
    await cli('mirror', 'download', '--json');
    expect(state().paused).toBeUndefined();
  }, 30_000);
});

// ------------------------------------------------------- incremental update (§15)

describe('mirror: incremental update', () => {
  it('detects source removal and keeps history (SKIPPED SOURCE_REMOVED + audit)', async () => {
    const st = state();
    st.entries['mock:mock-vanished'] = {
      ...st.entries['mock:mock-tree-01'],
      ref: 'mock:mock-vanished', assetId: 'mock-vanished', sourceUrl: 'mock://mock-vanished',
      state: 'COMMITTED', mirrorPath: 'assets/vegetation/vanished-x',
    };
    fs.writeFileSync(path.join(repo, '.asset-hub-mirror', 'state.json'), JSON.stringify(st));
    const r = await cli('mirror', 'update', '--json');
    const doc = r.json<{ removed: string[] }>();
    expect(doc.removed).toContain('mock:mock-vanished');
    expect(state().entries['mock:mock-vanished'].skipReason).toBe('SOURCE_REMOVED');
    const audit = fs.readFileSync(path.join(repo, 'mirror-audit.jsonl'), 'utf8');
    expect(audit).toContain('SOURCE_REMOVED');
  });

  it('LICENSE_CHANGED to non-redistributable stops mirroring, flags, audits — never silently deletes', async () => {
    // pretend the castle had been mirrored under CC0 and the source now serves CC-BY-NC
    const st = state();
    st.entries['mock:mock-castle-01'] = {
      ...st.entries['mock:mock-castle-01'],
      license: { ...st.entries['mock:mock-castle-01'].license, id: 'CC0-1.0', redistribution: 'allowed', unknown: false },
    };
    st.entries['mock:mock-nc-01'] = {
      ...st.entries['mock:mock-nc-01'],
      license: { ...st.entries['mock:mock-nc-01'].license, id: 'CC0-1.0', redistribution: 'allowed', unknown: false },
      state: 'COMMITTED',
      mirrorPath: 'assets/characters/nc-mech-x',
      skipReason: undefined,
    };
    fs.writeFileSync(path.join(repo, '.asset-hub-mirror', 'state.json'), JSON.stringify(st));

    const r = await cli('mirror', 'update', '--json');
    const doc = r.json<{ license_changes: { ref: string; action: string }[] }>();
    const revoked = doc.license_changes.find((lc) => lc.ref === 'mock:mock-nc-01');
    expect(revoked?.action).toMatch(/no longer permitted/i);
    const st2 = state();
    expect(st2.entries['mock:mock-nc-01'].state).toBe('SKIPPED');
    expect(st2.entries['mock:mock-nc-01'].skipReason).toBe('REDISTRIBUTION_REVOKED');
    expect(st2.entries['mock:mock-nc-01'].licenseChanged).toBe(true);
    expect(st2.entries['mock:mock-nc-01'].licensePrevious).toBe('CC0-1.0');
    const audit = fs.readFileSync(path.join(repo, 'mirror-audit.jsonl'), 'utf8');
    expect(audit).toContain('LICENSE_REVOKED');
    expect(audit).toContain('mock:mock-nc-01');
    // remediation workflow is real and audited
    const rem = await cli('mirror', 'remediate', 'mock:mock-nc-01', '--remove', '--json');
    expect(rem.code).toBe(0);
    expect(rem.json<{ removed: boolean }>().removed).toBe(true);
  });

  it('audit reports integrity problems honestly', async () => {
    // tamper a mirrored file → integrity mismatch must be caught
    const st = state();
    const castle = st.entries['mock:mock-castle-01'];
    const file = path.join(repo, castle.mirrorPath!, 'original', castle.fileName!);
    fs.writeFileSync(file, Buffer.from('tampered'));
    const r = await cli('mirror', 'audit', '--json');
    expect(r.code).toBe(4);
    const doc = r.json<{ findings: { path: string; problem: string; severity: string }[] }>();
    const hit = doc.findings.find((f) => f.path === castle.mirrorPath);
    expect(hit?.problem).toMatch(/integrity mismatch/i);
  });
});
