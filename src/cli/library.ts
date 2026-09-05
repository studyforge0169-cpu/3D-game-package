/**
 * `asset-hub library …` — AI access to the local Git-backed asset library
 * (spec §17–19). Searches the repository index (ASSET_INDEX.json), never the
 * internet; import verifies integrity before copying into a game project.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { CommandCtx } from './commands';
import { UserError, flag } from './commands';
import { CliError } from './errors';
import { fmtBytes, table } from './output';
import { resolveRepo } from './mirror';
import { MirrorState } from '../core/mirror/state';
import { EXPORT_PRESETS } from '../core/export/presets';
import { sha256File } from '../core/util/hash';
import { ensureDir } from '../core/util/fsutil';
import type { EngineId } from '../core/types';

interface IndexItem {
  id: string;
  path: string;
  name: string;
  creator: string | null;
  category: string;
  tags: string[];
  license: string;
  license_url: string | null;
  commercial_use: boolean;
  attribution_required: boolean;
  formats: string[];
  file: string | null;
  sha256: string | null;
  size_bytes: number | null;
  polygon_count: number | null;
  texture_resolution: number | null;
  source: string;
  source_url: string;
  kind: string;
}

function loadIndex(repoRoot: string): { items: IndexItem[]; source: string } {
  const file = path.join(repoRoot, 'ASSET_INDEX.json');
  if (fs.existsSync(file)) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { assets: IndexItem[] };
      return { items: doc.assets ?? [], source: 'ASSET_INDEX.json' };
    } catch {
      // fall through to scan
    }
  }
  // Fallback: scan assets/**/asset.json (slower, same shape)
  const items: IndexItem[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'asset.json') {
        try {
          const m = JSON.parse(fs.readFileSync(full, 'utf8'));
          items.push({
            id: String(m.id), path: path.dirname(path.relative(repoRoot, full)).split(path.sep).join('/'),
            name: String(m.name ?? ''), creator: m.creator ?? null, category: String(m.category ?? 'misc'),
            tags: m.tags ?? [], license: String(m.license ?? 'unknown'), license_url: m.license_url ?? null,
            commercial_use: m.commercial_use === true, attribution_required: m.attribution_required === true,
            formats: m.formats ?? [], file: m.file ?? null, sha256: m.sha256 ?? null, size_bytes: m.size_bytes ?? null,
            polygon_count: m.polygon_count ?? null, texture_resolution: m.texture_resolution ?? null,
            source: String(m.source ?? ''), source_url: String(m.source_url ?? ''), kind: String(m.kind ?? 'model'),
          });
        } catch { /* skip broken metadata */ }
      }
    }
  };
  walk(path.join(repoRoot, 'assets'));
  return { items, source: 'filesystem-scan' };
}

function findItem(items: IndexItem[], idOrPath: string): IndexItem | undefined {
  return items.find((i) => i.id === idOrPath)
    ?? items.find((i) => i.path === idOrPath)
    ?? items.find((i) => i.path.endsWith('/' + idOrPath));
}

export async function cmdLibrary(ctx: CommandCtx): Promise<number> {
  const sub = ctx.args.positionals.shift() ?? '';
  if (sub === 'search') return libSearch(ctx);
  if (sub === 'info') return libInfo(ctx);
  if (sub === 'import') return libImport(ctx);
  throw new UserError('unknown library subcommand "${sub}" — use search | info | import'.replace('${sub}', sub));
}

// ------------------------------------------------------------------- search

async function libSearch(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const query = ctx.args.positionals.join(' ').trim();
  const { items, source } = loadIndex(repoRoot);

  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const category = flag(ctx, 'category');
  const license = flag(ctx, 'license');
  const format = flag(ctx, 'format');
  const provider = flag(ctx, 'provider');

  let results = items.filter((i) => {
    if (category && i.category !== category.toLowerCase()) return false;
    if (license && !i.license.toLowerCase().includes(license.toLowerCase())) return false;
    if (format && !i.formats.some((f) => f.toLowerCase() === format.toLowerCase()) && !(i.file ?? '').toLowerCase().endsWith('.' + format.toLowerCase())) return false;
    if (provider && i.source !== provider) return false;
    if (ctx.args.booleans.has('cc0') && !/cc0|public domain/i.test(i.license)) return false;
    if (ctx.args.booleans.has('commercial') && !i.commercial_use) return false;
    if (ctx.args.booleans.has('attribution') && !i.attribution_required) return false;
    if (!tokens.length) return true;
    const hay = `${i.name} ${i.tags.join(' ')} ${i.creator ?? ''} ${i.category} ${i.source}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });

  const limit = Number(flag(ctx, 'limit') ?? 50);
  const totalMatches = results.length;
  results = results.slice(0, limit);

  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      query,
      repo: repoRoot,
      index_source: source,
      total_matches: totalMatches,
      results: results.map((i) => ({
        id: i.id,
        path: i.path,
        name: i.name,
        category: i.category,
        license: i.license,
        format: (i.file ? path.extname(i.file).replace('.', '') : i.formats[0]) ?? null,
        formats: i.formats,
        source: i.source,
        source_url: i.source_url,
        commercial_use: i.commercial_use,
        attribution_required: i.attribution_required,
        sha256: i.sha256,
        size_bytes: i.size_bytes,
      })),
    }, null, 2));
    return 0;
  }
  if (!results.length) {
    ctx.io.out(items.length
      ? `No matches for "${query}". Index has ${items.length} asset(s) — try fewer tokens or --category.`
      : `Library index is empty at ${repoRoot}. Run: asset-hub mirror discover && asset-hub mirror download && asset-hub mirror commit`);
    return 0;
  }
  const rows = results.map((i) => [i.name.slice(0, 30), i.category, i.license, i.formats.join('/') || (i.file ?? '').split('.').pop() || '?', i.source, i.id]);
  ctx.io.out(table(rows, ['Name', 'Category', 'License', 'Format', 'Source', 'ID']).join('\n'));
  ctx.io.out('');
  ctx.io.out(`${results.length}/${items.length} asset(s) — import with: asset-hub library import <ID> --project ./MyGame`);
  return 0;
}

// --------------------------------------------------------------------- info

async function libInfo(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const idOrPath = ctx.args.positionals[0];
  if (!idOrPath) throw new UserError('usage: asset-hub library info <asset-id | assets/path>');
  const { items } = loadIndex(repoRoot);
  const item = findItem(items, idOrPath);
  if (!item) throw new CliError('INVALID_ASSET', `no library asset matches "${idOrPath}"`, { asset_id: idOrPath, path: repoRoot });
  const assetDir = path.join(repoRoot, item.path);
  const metaFile = path.join(assetDir, 'asset.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  // item.file is repo-relative (ASSET_INDEX) — resolve accordingly, with a
  // metadata fallback for indexes built by filesystem scan.
  const target = item.file
    ? (fs.existsSync(path.join(repoRoot, item.file)) ? path.join(repoRoot, item.file) : path.join(assetDir, item.file))
    : null;
  const actualSha = target ? await sha256File(target).catch(() => null) : null;
  const integrity = {
    file: target ? path.relative(repoRoot, target) : null,
    expected_sha256: item.sha256,
    actual_sha256: actualSha,
    verified: !!item.sha256 && !!actualSha && item.sha256 === actualSha,
  };
  if (ctx.json) {
    ctx.io.out(JSON.stringify({ asset: meta, integrity, attribution_required: item.attribution_required }, null, 2));
    return integrity.verified ? 0 : 4;
  }
  ctx.io.out(`${item.name}  [${item.id}]`);
  ctx.io.out(`  Path:        ${item.path}`);
  ctx.io.out(`  Category:    ${item.category} · Format: ${item.formats.join('/') || '?'}`);
  ctx.io.out(`  License:     ${item.license}${item.license_url ? ` — ${item.license_url}` : ''}`);
  ctx.io.out(`  Commercial:  ${item.commercial_use ? 'YES' : 'no/conditions'} · Attribution: ${item.attribution_required ? 'REQUIRED' : 'not required'}`);
  ctx.io.out(`  Source:      ${item.source} — ${item.source_url}`);
  ctx.io.out(`  Integrity:   ${integrity.verified ? '✓ sha256 verified' : integrity.actual_sha256 ? '✗ MISMATCH' : 'file missing'}`);
  return integrity.verified ? 0 : 4;
}

// ------------------------------------------------------------------- import

async function libImport(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const idOrPath = ctx.args.positionals[0];
  if (!idOrPath) throw new UserError('usage: asset-hub library import <asset-id | assets/path> --project ./MyGame [--engine <id>]');
  const project = flag(ctx, 'project') ?? flag(ctx, 'output');
  if (!project) throw new UserError('library import requires --project <dir> (or --output)');
  const { items } = loadIndex(repoRoot);
  const item = findItem(items, idOrPath);
  if (!item) throw new CliError('INVALID_ASSET', `no library asset matches "${idOrPath}"`, { asset_id: idOrPath, path: repoRoot });

  const assetDir = path.join(repoRoot, item.path);
  const originalDir = path.join(assetDir, 'original');
  const files = await fsp.readdir(originalDir).catch(() => [] as string[]);
  if (!files.length) throw new CliError('NOT_FOUND', `no original files under ${item.path}/original/`, { path: item.path });

  // 1. verify integrity of every original file against asset.json (spec §18)
  const meta = JSON.parse(fs.readFileSync(path.join(assetDir, 'asset.json'), 'utf8'));
  if (meta.redistribution_allowed !== true) {
    throw new CliError('LICENSE_RESTRICTED', `${item.id} is flagged as not redistributable — import refused`, { asset_id: item.id });
  }
  const main = String(meta.file ?? `original/${files[0]}`);
  const mainAbs = path.join(assetDir, main);
  const actualSha = await sha256File(mainAbs).catch(() => null);
  if (typeof meta.sha256 === 'string' && meta.sha256.length === 64 && actualSha !== meta.sha256) {
    throw new CliError('INVALID_ASSET', `integrity verification failed for ${item.id}: asset.json records ${String(meta.sha256).slice(0, 12)}… but the file hashes to ${String(actualSha ?? 'null').slice(0, 12)}… — import refused`, { asset_id: item.id });
  }
  // multi-file packages: verify every packaged file before copying any
  if (Array.isArray(meta.files)) {
    for (const mf of meta.files as { path: string; sha256: string }[]) {
      const abs = path.join(assetDir, String(mf.path));
      const sha = await sha256File(abs).catch(() => null);
      if (sha !== mf.sha256) {
        throw new CliError('INVALID_ASSET', `integrity verification failed for ${item.id}: ${String(mf.path)} hashes to ${String(sha ?? 'null').slice(0, 12)}… but asset.json records ${String(mf.sha256).slice(0, 12)}… — import refused`, { asset_id: item.id });
      }
    }
  }

  // 2. engine + destination layout
  let engine = flag(ctx, 'engine') as EngineId | undefined;
  const projectAbs = path.resolve(project);
  if (!engine) {
    const detect = (await import('./ai')).detectProject(projectAbs);
    engine = detect.engine ?? undefined;
  }
  const preset = engine ? EXPORT_PRESETS[engine] : null;
  const destDir = preset
    ? path.join(projectAbs, preset.rootDirName, item.category)
    : path.join(projectAbs, 'assets', item.category);
  await ensureDir(destDir);
  const copied: string[] = [];
  const copyTree = async (srcDir: string, relDir: string): Promise<void> => {
    for (const ent of await fsp.readdir(srcDir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await copyTree(path.join(srcDir, ent.name), rel);
        continue;
      }
      const dest = path.join(destDir, rel);
      if (fs.existsSync(dest)) {
        throw new CliError('INVALID_USAGE', `destination exists: ${dest} (asset-hub never overwrites project files without confirmation)`, { path: dest });
      }
      await ensureDir(path.dirname(dest));
      await fsp.copyFile(path.join(srcDir, ent.name), dest);
      copied.push(dest);
    }
  };
  await copyTree(originalDir, '');

  // 3. attribution when required
  let attributionFiles: string[] = [];
  if (item.attribution_required) {
    const credit = `"${item.name}" by ${item.creator ?? 'unknown'} — ${item.license}${item.license_url ? ` (${item.license_url})` : ''} — ${item.source_url}`;
    const md = path.join(projectAbs, 'ATTRIBUTIONS.md');
    const txt = path.join(projectAbs, 'ATTRIBUTIONS.txt');
    const entry = `- ${credit}`;
    if (!fs.existsSync(md)) await fsp.writeFile(md, `# Attributions\n\n${entry}\n`);
    else await fsp.appendFile(md, `${entry}\n`);
    if (!fs.existsSync(txt)) await fsp.writeFile(txt, `${credit}\n`);
    else await fsp.appendFile(txt, `${credit}\n`);
    attributionFiles = [md, txt];
  }

  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      success: true,
      asset: { id: item.id, name: item.name, license: item.license, source: item.source, category: item.category },
      integrity_verified: actualSha !== null,
      engine: engine ?? null,
      copied_files: copied,
      attribution_required: item.attribution_required,
      attribution_files: attributionFiles,
      credit_line: item.attribution_required ? `"${item.name}" by ${item.creator ?? 'unknown'} — ${item.license} — ${item.source_url}` : null,
    }, null, 2));
    return 0;
  }
  ctx.io.out(`✓ imported ${item.name} [${item.id}]`);
  ctx.io.out(`  license ${item.license} · integrity ${actualSha !== null ? 'verified' : 'unverified'}`);
  for (const f of copied) ctx.io.out(`  ${f}`);
  if (attributionFiles.length) ctx.io.out(`  ⚠ attribution required — updated ${attributionFiles.join(' and ')}`);
  return 0;
}
