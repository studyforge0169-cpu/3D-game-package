/**
 * asset-hub command implementations.
 *
 * Every command is a pure function over (args, io, hub factory) returning a
 * process exit code, so tests can drive them without spawning a process.
 * The hub is created lazily from global flags (--home/--library/--fixtures).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { Hub } from '../core/services/hub';
import type {
  AssetCategory, AssetRef, ConvertOptions, DownloadOption, DownloadTask, EngineId,
  LibraryAsset, SearchFilters, SearchPage, SearchQuery, SortKey, TaskState,
} from '../core/types';
import { ASSET_CATEGORIES } from '../core/types';
import { LICENSE_REGISTRY, UNKNOWN_LICENSE_DEFINITION } from '../core/licenses/registry';
import { loadModel, convertAsset } from '../core/convert/pipeline';
import { computeBoundingBox, triangleCount } from '../core/convert/mesh';
import { geometryFingerprint } from '../core/convert/stats';
import { CliIo, fmtBytes, fmtInt, table, assetBlock, licenseSummary } from './output';

export interface CliArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
}

export interface CommandCtx {
  args: CliArgs;
  io: CliIo;
  json: boolean;
  getHub(): Promise<Hub>;
}

const TERMINAL_STATES: TaskState[] = ['completed', 'failed', 'canceled', 'corrupt', 'skipped_duplicate', 'blocked_license'];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class UserError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

function flag(ctx: CommandCtx, name: string): string | undefined {
  return ctx.args.flags.get(name)?.[0];
}
function flagList(ctx: CommandCtx, name: string): string[] {
  return ctx.args.flags.get(name) ?? [];
}
function num(ctx: CommandCtx, name: string): number | undefined {
  const v = flag(ctx, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) throw new UserError(`--${name} expects a number, got "${v}"`);
  return n;
}
function requireFlag(ctx: CommandCtx, name: string): string {
  const v = flag(ctx, name);
  if (v === undefined) throw new UserError(`missing required flag --${name}`);
  return v;
}

// ---------------------------------------------------------------- shared bits

export function parseAssetRef(ref: string): { provider: string; assetId: string } {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) {
    throw new UserError(
      `asset reference "${ref}" must look like <provider>:<asset-id>, e.g. polyhaven:castle_ruins`,
    );
  }
  return { provider: ref.slice(0, i), assetId: ref.slice(i + 1) };
}

function categoryOr(cat: string): AssetCategory {
  const hit = ASSET_CATEGORIES.find((c) => c.toLowerCase() === cat.toLowerCase());
  if (!hit) throw new UserError(`unknown category "${cat}". Valid: ${ASSET_CATEGORIES.join(', ')}`);
  return hit;
}

function buildFilters(ctx: CommandCtx): SearchFilters {
  const f: SearchFilters = {};
  if (ctx.args.booleans.has('cc0')) f.cc0Only = true;
  if (ctx.args.booleans.has('commercial')) f.commercialOnly = true;
  if (ctx.args.booleans.has('free')) f.freeOnly = true;
  if (ctx.args.booleans.has('no-attribution')) f.noAttributionOnly = true;
  const licenses = flagList(ctx, 'license');
  if (licenses.length) f.licenses = licenses;
  const format = flag(ctx, 'format');
  if (format) f.formats = [format.toLowerCase()];
  const kind = flag(ctx, 'kind');
  if (kind) f.kind = kind as SearchFilters['kind'];
  const topicList = flagList(ctx, 'topic');
  if (topicList.length) f.topics = topicList;
  const maxPoly = num(ctx, 'max-poly');
  if (maxPoly !== undefined) f.maxPolyCount = maxPoly;
  const minPoly = num(ctx, 'min-poly');
  if (minPoly !== undefined) f.minPolyCount = minPoly;
  const minRes = num(ctx, 'min-res');
  if (minRes !== undefined) f.minTextureResolution = minRes;
  if (ctx.args.booleans.has('pbr')) f.pbrOnly = true;
  if (ctx.args.booleans.has('rigged')) f.riggedOnly = true;
  if (ctx.args.booleans.has('animated')) f.animatedOnly = true;
  const maxMb = num(ctx, 'max-size');
  if (maxMb !== undefined) f.maxFileSize = Math.round(maxMb * 1024 * 1024);
  return f;
}

/** Client-side re-filter so behavior is uniform regardless of provider support. */
function resultPasses(ctx: CommandCtx, a: AssetRef): boolean {
  const lic = a.license;
  if (ctx.args.booleans.has('cc0') && !/cc0|public domain/i.test(lic.id)) return false;
  if (ctx.args.booleans.has('commercial') && lic.commercialUse !== 'allowed') return false;
  if (ctx.args.booleans.has('free') && !a.free) return false;
  if (ctx.args.booleans.has('no-attribution') && lic.attributionRequired) return false;
  const licenses = flagList(ctx, 'license');
  if (licenses.length) {
    const ok = licenses.some((l) => {
      const ln = l.toLowerCase().replace(/[\s_-]/g, '');
      const id = lic.id.toLowerCase().replace(/[\s_-]/g, '');
      const name = lic.name.toLowerCase().replace(/[\s_-]/g, '');
      return id.includes(ln) || name.includes(ln) || ln === 'unknown' && lic.unknown;
    });
    if (!ok) return false;
  }
  const format = flag(ctx, 'format');
  if (format && !a.formats.some((x) => x.toLowerCase() === format.toLowerCase())) return false;
  const kind = flag(ctx, 'kind');
  if (kind && a.kind !== kind) return false;
  const maxPoly = num(ctx, 'max-poly');
  if (maxPoly !== undefined && a.polyCount !== undefined && a.polyCount > maxPoly) return false;
  const minPoly = num(ctx, 'min-poly');
  if (minPoly !== undefined && a.polyCount !== undefined && a.polyCount < minPoly) return false;
  const minRes = num(ctx, 'min-res');
  if (minRes !== undefined && a.textureResolution !== undefined && a.textureResolution < minRes) return false;
  if (ctx.args.booleans.has('pbr') && a.pbr !== true) return false;
  if (ctx.args.booleans.has('rigged') && a.rigged !== true) return false;
  if (ctx.args.booleans.has('animated') && a.animated !== true) return false;
  return true;
}

function sortResults(results: AssetRef[], sort: string): AssetRef[] {
  const by: Record<string, (a: AssetRef, b: AssetRef) => number> = {
    popularity: (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0),
    quality: (a, b) => (b.likes ?? 0) - (a.likes ?? 0),
    polygons: (a, b) => (a.polyCount ?? Infinity) - (b.polyCount ?? Infinity),
    textureResolution: (a, b) => (b.textureResolution ?? 0) - (a.textureResolution ?? 0),
    fileSize: (a, b) => (a.fileSize ?? Infinity) - (b.fileSize ?? Infinity),
    newest: (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
  };
  const fn = by[sort];
  return fn ? [...results].sort(fn) : results;
}

// ------------------------------------------------------------------- commands

export async function cmdSearch(ctx: CommandCtx): Promise<number> {
  const text = ctx.args.positionals.join(' ').trim();
  if (!text) throw new UserError('usage: asset-hub search "<terms>" [filters]');
  const providers = flagList(ctx, 'provider').flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
  const query: SearchQuery = {
    text,
    providers: providers.length ? providers : undefined,
    page: num(ctx, 'page'),
    perPage: num(ctx, 'limit'),
    filters: buildFilters(ctx),
    sort: flag(ctx, 'sort') as SortKey | undefined,
  };
  const hub = await ctx.getHub();
  const pages: SearchPage[] = await hub.search(query);

  const errors: { provider: string; error: string; searchUrl?: string }[] = [];
  const results: AssetRef[] = [];
  for (const p of pages) {
    if (p.error) {
      errors.push({ provider: p.providerId, error: p.error, searchUrl: (p as { searchUrl?: string }).searchUrl });
    }
    for (const r of p.results) if (resultPasses(ctx, r)) results.push(r);
  }
  const sort = flag(ctx, 'sort');
  const ordered = sort ? sortResults(results, sort) : results;

  if (ctx.json) {
    ctx.io.out(JSON.stringify({ query: text, results: ordered, providerErrors: errors }, null, 2));
    return 0;
  }
  ordered.forEach((a, i) => ctx.io.out(assetBlock(i + 1, a).join('\n')));
  ctx.io.out('');
  ctx.io.out(`${ordered.length} result(s)${ordered.length ? ' — download with: asset-hub download <provider>:<asset-id>' : ''}`);
  for (const e of errors) {
    ctx.io.out(`! ${e.provider}: ${e.error}${e.searchUrl ? ` → ${e.searchUrl}` : ''}`);
  }
  return 0;
}

export async function cmdInfo(ctx: CommandCtx): Promise<number> {
  const ref = parseAssetRef(ctx.args.positionals[0] ?? '');
  const hub = await ctx.getHub();
  const { asset, license, options } = await hub.getAssetDetail(ref.provider, ref.assetId);
  let metadata: Record<string, unknown> = {};
  try {
    const p = hub.providers.get(ref.provider);
    metadata = (await p?.getMetadata(ref.assetId)) ?? {};
  } catch (e) {
    metadata = { error: String((e as Error).message ?? e) };
  }
  if (ctx.json) {
    ctx.io.out(JSON.stringify({ asset, license, downloadOptions: options, metadata }, null, 2));
    return 0;
  }
  if (!asset) {
    ctx.io.out(`Asset not found: ${ref.provider}:${ref.assetId}`);
    return 1;
  }
  const lines = [
    `${asset.name}  (${ref.provider}:${ref.assetId})`,
    ...(asset.creator ? [`Creator: ${asset.creator}`] : []),
    `Kind: ${asset.kind}${asset.categoryHint ? ` (category hint: ${asset.categoryHint})` : ''}`,
    `URL: ${asset.assetUrl}`,
    ...(asset.previewUrl ? [`Preview: ${asset.previewUrl}`] : []),
    ...(asset.description ? ['', (asset.description ?? '').slice(0, 400)] : []),
    '',
    ...licenseSummary(license),
    '',
    'Download options:',
    ...(options.length
      ? options.map((o: DownloadOption, i) =>
          `  [${i}] ${o.id} — ${o.format}${o.sizeBytes ? ` (${fmtBytes(o.sizeBytes)})` : ''}${o.requiresAuth ? ' · requires your account/API key' : ''}`)
      : ['  (none exposed programmatically — open the official page)']),
  ];
  if (asset.polyCount !== undefined || asset.textureResolution !== undefined) {
    lines.push('', `Poly count: ${fmtInt(asset.polyCount)} · Texture res: ${fmtInt(asset.textureResolution)}px`);
  }
  const metaKeys = Object.keys(metadata);
  if (metaKeys.length) {
    lines.push('', 'Metadata:', ...metaKeys.map((k) => `  ${k}: ${JSON.stringify(metadata[k]).slice(0, 160)}`));
  }
  ctx.io.out(lines.join('\n'));
  return 0;
}

interface DownloadOutcome {
  task: DownloadTask;
  asset?: LibraryAsset;
}

async function runDownloads(
  ctx: CommandCtx,
  refs: { provider: string; assetId: string; optionId?: string }[],
): Promise<DownloadOutcome[]> {
  const hub = await ctx.getHub();
  const concurrency = num(ctx, 'concurrency');
  if (concurrency !== undefined) hub.setDownloadConcurrency(Math.max(1, Math.min(16, concurrency)));

  const outcomes: DownloadOutcome[] = [];
  const pending = new Map<string, string>(); // taskId -> label
  const lastProgress = new Map<string, number>();
  const assetIdByTask = new Map<string, string>();
  hub.on('download-completed', (ev: { taskId: string; assetId: string }) => {
    assetIdByTask.set(ev.taskId, ev.assetId);
  });

  hub.on('download-progress', (ev: { taskId: string; bytes?: number; totalBytes?: number }) => {
    const label = pending.get(ev.taskId);
    if (!label) return;
    if ((ev.totalBytes ?? 0) < 1_000_000) return; // small files: no progress spam
    const now = Date.now();
    if (now - (lastProgress.get(ev.taskId) ?? 0) < 700) return;
    lastProgress.set(ev.taskId, now);
    const pct = ev.totalBytes ? ` ${Math.floor(((ev.bytes ?? 0) / ev.totalBytes) * 100)}%` : '';
    ctx.io.out(`  … ${label}${pct}`);
  });

  for (const r of refs) {
    let task: DownloadTask;
    try {
      task = await hub.enqueueDownload(r.provider, r.assetId, r.optionId);
    } catch (e) {
      ctx.io.err(`! ${r.provider}:${r.assetId}: ${(e as Error).message}`);
      continue;
    }
    pending.set(task.id, `${r.provider}:${r.assetId}`);
    if (TERMINAL_STATES.includes(task.state)) {
      outcomes.push({ task });
      pending.delete(task.id);
    }
  }

  const deadline = Date.now() + 15 * 60_000;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const t of hub.downloads()) {
      if (pending.has(t.id) && TERMINAL_STATES.includes(t.state)) {
        pending.delete(t.id);
        outcomes.push({ task: t });
      }
    }
    if (pending.size === 0) break;
    await sleep(120);
  }
  if (pending.size > 0) {
    for (const [id, label] of pending) {
      const t = hub.downloads().find((x) => x.id === id);
      ctx.io.err(`! ${label}: timed out waiting for download to finish`);
      if (t) outcomes.push({ task: t });
    }
  }

  // Attach library assets to completed downloads (event-sourced: race-free).
  for (const o of outcomes) {
    if (o.task.state !== 'completed') continue;
    const assetId = assetIdByTask.get(o.task.id);
    if (assetId) o.asset = hub.asset(assetId) ?? undefined;
  }
  // Keep the library-root ATTRIBUTIONS files in sync (spec: attribution §).
  const completedAny = outcomes.some((o) => o.task.state === 'completed');
  if (completedAny) {
    const ids = hub.librarySearch({}).map((a) => a.id);
    await hub.writeAttributionFiles(ids, hub.libraryDir).catch(() => {});
  }
  return outcomes;
}

function describeOutcome(o: DownloadOutcome): string {
  const t = o.task;
  switch (t.state) {
    case 'completed':
      return `saved ${t.destPath}${o.asset ? ` (${fmtBytes(o.asset.fileSize)}, sha256 ${o.asset.sha256?.slice(0, 12) ?? 'n/a'}…)` : ''}`;
    case 'skipped_duplicate':
      return 'already in library — skipped (duplicate)';
    case 'blocked_license':
      return 'BLOCKED — license could not be verified from official data; open the asset page to obtain it manually';
    case 'failed':
      return `failed: ${t.error ?? 'unknown error'}`;
    case 'corrupt':
      return `downloaded file failed verification and was quarantined: ${t.error ?? ''}`;
    case 'canceled':
      return 'canceled';
    default:
      return t.state;
  }
}

export async function cmdDownload(ctx: CommandCtx): Promise<number> {
  const ref = parseAssetRef(ctx.args.positionals[0] ?? '');
  const optionId = flag(ctx, 'option');
  const category = flag(ctx, 'category');

  const outcomes = await runDownloads(ctx, [{ provider: ref.provider, assetId: ref.assetId, optionId }]);
  if (outcomes.length === 0) return 1;
  const o = outcomes[0];
  const hub = await ctx.getHub();

  if (o.task.state === 'completed' && o.asset) {
    if (category) {
      await hub.moveAssetCategory(o.asset.id, categoryOr(category));
      o.asset = hub.asset(o.asset.id)!;
    }
    const a = o.asset;
    const lines = [
      `✓ ${a.name}`,
      `   Saved:      ${a.localPath}`,
      `   Category:   ${a.category}   (…/${path.relative(hub.libraryDir, path.dirname(a.originalDir)).split(path.sep).slice(0, 2).join('/')})`,
      `   Size:       ${fmtBytes(a.fileSize)}`,
      `   SHA-256:    ${a.sha256}`,
      `   License:    ${a.licenseId === 'unknown' ? 'LICENSE UNKNOWN' : a.licenseId}${a.licenseUrl ? ` — ${a.licenseUrl}` : ''}`,
      `   Metadata:   ${path.join(path.dirname(a.originalDir), 'asset.json')}`,
    ].filter(Boolean) as string[];
    ctx.io.out(lines.join('\n'));
    if (a.licenseId !== 'CC0-1.0') {
      ctx.io.out(`   ⚠ This asset requires attribution — see ATTRIBUTIONS.md in your library root.`);
    }
    return 0;
  }
  if (o.task.state === 'skipped_duplicate') {
    ctx.io.out(`= ${ref.provider}:${ref.assetId}: ${describeOutcome(o)}`);
    return 0;
  }
  ctx.io.err(`✗ ${ref.provider}:${ref.assetId}: ${describeOutcome(o)}`);
  return o.task.state === 'blocked_license' ? 3 : 4;
}

export async function cmdBatch(ctx: CommandCtx): Promise<number> {
  const file = ctx.args.positionals[0];
  if (!file) throw new UserError('usage: asset-hub download-list <file-with-provider:asset-id-lines>');
  const text = await fsp.readFile(file, 'utf8');
  const refs = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => parseAssetRef(l));
  if (!refs.length) throw new UserError(`no asset references found in ${file} (expected lines like polyhaven:castle)`);
  ctx.io.out(`Downloading ${refs.length} asset(s)…`);
  const outcomes = await runDownloads(ctx, refs);
  const counts = new Map<string, number>();
  for (const o of outcomes) counts.set(o.task.state, (counts.get(o.task.state) ?? 0) + 1);
  for (const o of outcomes) {
    const icon = o.task.state === 'completed' ? '✓' : o.task.state === 'skipped_duplicate' ? '=' : '✗';
    ctx.io.out(`${icon} ${o.task.providerId}:${o.task.assetRef.id} — ${describeOutcome(o)}`);
  }
  const failed = outcomes.filter((o) => ['failed', 'corrupt', 'blocked_license', 'canceled'].includes(o.task.state)).length;
  const missing = refs.length - outcomes.length;
  ctx.io.out('');
  ctx.io.out(`Summary: ${counts.get('completed') ?? 0} completed · ${counts.get('skipped_duplicate') ?? 0} duplicates skipped · ${failed} failed${missing ? ` · ${missing} never queued (see errors above)` : ''}`);
  return failed + missing > 0 ? 4 : 0;
}

export async function cmdSources(ctx: CommandCtx): Promise<number> {
  const hub = await ctx.getHub();
  const infos = await hub.providerInfos();
  if (ctx.json) {
    ctx.io.out(JSON.stringify(infos, null, 2));
    return 0;
  }
  const rows = (infos as {
    id: string; displayName: string; tier: string; configured?: boolean;
    capabilities: { search: boolean; download: boolean; perAssetLicense: boolean; needsApiKey: boolean };
    homeUrl: string; docsUrl?: string; siteLicense?: string;
  }[]).map((p) => [
    p.id,
    p.displayName,
    p.capabilities.search ? 'yes' : 'no',
    p.capabilities.download ? 'yes' : 'browser',
    p.tier,
    p.capabilities.perAssetLicense ? 'per-asset' : (p.siteLicense ?? 'manual'),
    p.capabilities.needsApiKey ? (p.configured ? 'key ✓' : 'key needed') : '—',
  ]);
  ctx.io.out(table(rows, ['Provider', 'Name', 'Search', 'Download', 'API tier', 'License data', 'Auth']).join('\n'));
  ctx.io.out('');
  ctx.io.out('Tiers: full = official API search+download · hybrid = official data, partial automation · manual = no API; open the official page and use "asset-hub import" via the desktop app.');
  return 0;
}

export async function cmdLicenses(ctx: CommandCtx): Promise<number> {
  const defs = Object.values(LICENSE_REGISTRY);
  const all = [...defs, UNKNOWN_LICENSE_DEFINITION];
  if (ctx.json) {
    ctx.io.out(JSON.stringify(all, null, 2));
    return 0;
  }
  const rows = all.map((d) => [
    d.id,
    d.name.slice(0, 34),
    d.commercialUse === 'allowed' ? 'YES' : d.commercialUse === 'conditions' ? 'CONDITIONS' : d.commercialUse === 'forbidden' ? 'NO' : 'UNKNOWN',
    d.attributionRequired ? 'required' : 'not required',
    d.shareAlike ? 'yes' : 'no',
  ]);
  ctx.io.out(table(rows, ['ID', 'License', 'Commercial use', 'Attribution', 'Share-alike']).join('\n'));
  ctx.io.out('');
  ctx.io.out('Downloads are blocked whenever an asset resolves to "unknown".');
  return 0;
}

export async function cmdInspect(ctx: CommandCtx): Promise<number> {
  const file = ctx.args.positionals[0];
  if (!file) throw new UserError('usage: asset-hub inspect <model-file>');
  if (!fs.existsSync(file)) throw new UserError(`file not found: ${file}`);
  const stat = await fsp.stat(file);
  const ext = path.extname(file).toLowerCase().replace('.', '');
  let model;
  try {
    model = await loadModel(file);
  } catch (e) {
    ctx.io.err(`cannot parse .${ext}: ${(e as Error).message}`);
    if (['fbx', 'blend', 'dae'].includes(ext)) {
      ctx.io.err(`.${ext} needs an external converter — configure one with:`);
      ctx.io.err('  asset-hub config set converters.assimpPath <path-to-assimp>');
      ctx.io.err('  asset-hub config set converters.blenderPath <path-to-blender>');
    }
    return 2;
  }
  const meshes = model.meshes;
  const bbox = computeBoundingBox(meshes);
  const dims = [
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2],
  ].map((v) => v.toFixed(2));
  const vertices = meshes.reduce((n, m) => n + m.positions.length / 3, 0);
  const triangles = meshes.reduce((n, m) => n + triangleCount(m), 0);
  const info = {
    file: path.resolve(file),
    format: ext,
    bytes: stat.size,
    meshes: meshes.length,
    vertices,
    triangles,
    materials: model.materials.length,
    images: model.images.length,
    animations: model.animations.map((a) => a.name),
    skeleton: model.hasSkeleton,
    boundingBox: { min: bbox.min, max: bbox.max, dimensions: dims },
    geometryFingerprint: geometryFingerprint(model),
  };
  if (ctx.json) {
    ctx.io.out(JSON.stringify(info, null, 2));
    return 0;
  }
  ctx.io.out([
    `File:      ${info.file}`,
    `Format:    ${info.format.toUpperCase()}   (${fmtBytes(info.bytes)})`,
    `Meshes:    ${info.meshes}   Vertices: ${fmtInt(vertices)}   Triangles: ${fmtInt(triangles)}`,
    `Materials: ${info.materials}   Textures: ${info.images}   Animations: ${info.animations.length}${info.animations.length ? ` (${info.animations.slice(0, 5).join(', ')}${info.animations.length > 5 ? '…' : ''})` : ''}`,
    `Skeleton:  ${info.skeleton ? 'yes' : 'no'}`,
    `Bounds:    ${dims.join(' × ')}`,
    `Geometry fingerprint: ${info.geometryFingerprint.slice(0, 24)}…`,
  ].join('\n'));
  return 0;
}

function convertOptionsFrom(ctx: CommandCtx, targetFormat: string): ConvertOptions {
  const opts: ConvertOptions = { targetFormat: targetFormat as ConvertOptions['targetFormat'] };
  const axis = flag(ctx, 'axis');
  if (axis) opts.axisMode = axis === 'z-up' ? 'z-up' : 'y-up';
  const texMax = num(ctx, 'texture-max');
  if (texMax !== undefined) opts.textureResize = { maxSize: texMax };
  const texFormat = flag(ctx, 'texture-format');
  if (texFormat) {
    opts.textureCompress = {
      format: texFormat === 'png' ? 'png' : 'jpeg',
      quality: num(ctx, 'texture-quality') ?? 85,
    };
  }
  if (ctx.args.booleans.has('weld')) opts.weldVertices = true;
  if (ctx.args.booleans.has('normals')) opts.recomputeNormals = true;
  if (ctx.args.booleans.has('prune')) opts.pruneUnusedMaterials = true;
  const lods = flag(ctx, 'lods');
  if (lods) {
    const levels = lods.split(',').map((s) => Number(s.trim())).filter((n) => n > 0 && n < 1);
    if (!levels.length) throw new UserError('--lods expects ratios like 0.5,0.25');
    opts.generateLods = { levels: levels.map((ratio, i) => ({ ratio, suffix: `_lod${i + 1}` })) };
  }
  const collision = flag(ctx, 'collision');
  if (collision) {
    if (!['bbox', 'decimated'].includes(collision)) throw new UserError('--collision expects bbox or decimated');
    opts.generateCollision = collision as ConvertOptions['generateCollision'];
  }
  const decimate = num(ctx, 'decimate');
  if (decimate !== undefined) opts.decimateRatio = decimate;
  opts.embedTextures = ctx.args.booleans.has('no-embed') ? false : undefined;
  return opts;
}

async function runConvert(ctx: CommandCtx, opts: ConvertOptions, file: string, outDir: string): Promise<number> {
  const result = await convertAsset(file, outDir, opts);
  if (ctx.json) {
    ctx.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 2;
  }
  if (!result.ok) {
    ctx.io.err(`conversion failed: ${result.error}`);
    return 2;
  }
  for (const w of result.warnings) ctx.io.out(`  ⚠ ${w}`);
  for (const o of result.outputs) {
    ctx.io.out(`✓ ${o.kind.padEnd(9)} ${o.path}  (${fmtBytes(o.bytes)})`);
  }
  if (result.stats) {
    const s = result.stats;
    ctx.io.out(`  meshes ${s.meshes} · vertices ${fmtInt(s.vertices)} · faces ${fmtInt(s.faces)} · normals ${s.hasNormals ? 'yes' : 'no'} · uvs ${s.hasUvs ? 'yes' : 'no'}`);
  }
  return 0;
}

export async function cmdConvert(ctx: CommandCtx): Promise<number> {
  const file = ctx.args.positionals[0];
  if (!file) throw new UserError('usage: asset-hub convert <file> --format <glb|gltf|obj> [options]');
  if (!fs.existsSync(file)) throw new UserError(`file not found: ${file}`);
  const hub = await ctx.getHub();
  const cfg = hub.getConfig();
  const format = (flag(ctx, 'format') ?? cfg.converters.defaultTargetFormat).toLowerCase();
  if (!['glb', 'gltf', 'obj'].includes(format)) {
    throw new UserError(`target format "${format}" is not supported natively (glb / gltf / obj). FBX/BLEND/DAE output requires external tools.`);
  }
  const outDir = flag(ctx, 'out') ?? path.join(path.dirname(path.resolve(file)), 'converted');
  const opts = convertOptionsFrom(ctx, format);
  ctx.io.out(`Converting ${path.basename(file)} → ${format.toUpperCase()} (${outDir})`);
  return runConvert(ctx, opts, file, outDir);
}

export async function cmdOptimize(ctx: CommandCtx): Promise<number> {
  const file = ctx.args.positionals[0];
  if (!file) throw new UserError('usage: asset-hub optimize <file> [--texture-max N] [--out DIR]');
  if (!fs.existsSync(file)) throw new UserError(`file not found: ${file}`);
  const hub = await ctx.getHub();
  const cfg = hub.getConfig();
  const ext = path.extname(file).toLowerCase().replace('.', '');
  const format = ['glb', 'gltf', 'obj'].includes(ext) ? ext : cfg.converters.defaultTargetFormat;
  const outDir = flag(ctx, 'out') ?? path.join(path.dirname(path.resolve(file)), 'optimized');
  const opts: ConvertOptions = {
    targetFormat: format as ConvertOptions['targetFormat'],
    weldVertices: true,
    recomputeNormals: true,
    pruneUnusedMaterials: true,
    embedTextures: true,
    textureCompress: { format: 'jpeg', quality: 85 },
    ...(num(ctx, 'texture-max') !== undefined ? { textureResize: { maxSize: num(ctx, 'texture-max')! } } : {}),
  };
  ctx.io.out(`Optimizing ${path.basename(file)} (weld · normals · prune · jpeg textures → ${outDir})`);
  return runConvert(ctx, opts, file, outDir);
}

export async function cmdExport(ctx: CommandCtx): Promise<number> {
  const ids = ctx.args.positionals;
  if (!ids.length) throw new UserError('usage: asset-hub export <library-id | provider:asset-id>… --engine <unreal|unity|godot|blender> --output <dir>');
  const engine = requireFlag(ctx, 'engine') as EngineId;
  if (!['unreal', 'unity', 'godot', 'blender'].includes(engine)) throw new UserError(`unknown engine "${engine}"`);
  const output = requireFlag(ctx, 'output');
  const hub = await ctx.getHub();

  // Resolve references to library assets, downloading when needed.
  const assetIds: string[] = [];
  for (const idOrRef of ids) {
    const existing = hub.asset(idOrRef);
    if (existing) {
      assetIds.push(existing.id);
      continue;
    }
    const ref = parseAssetRef(idOrRef);
    const outcomes = await runDownloads(ctx, [ref]);
    const done = outcomes.find((o) => o.task.state === 'completed');
    if (!done?.asset) {
      throw new UserError(`could not fetch ${idOrRef}: ${outcomes[0] ? describeOutcome(outcomes[0]) : 'enqueue failed'}`);
    }
    assetIds.push(done.asset.id);
  }
  if (!assetIds.length) throw new UserError('no assets to export');

  const outAbs = path.resolve(output);
  // --output is the game project root; the exporter writes <root>/<project>/<Content|Assets|assets|…>.
  const projectName = flag(ctx, 'project') ?? path.basename(outAbs);
  const exportRoot = flag(ctx, 'project') ? outAbs : path.dirname(outAbs);
  const source = (flag(ctx, 'source') ?? 'original') as 'original' | 'processed' | 'gameReady';
  if (!['original', 'processed', 'gameReady'].includes(source)) {
    throw new UserError(`--source must be original | processed | gameReady (got "${source}")`);
  }
  const onConflict = (flag(ctx, 'on-conflict') ?? 'skip') as 'skip' | 'rename' | 'overwrite';
  if (!['skip', 'rename', 'overwrite'].includes(onConflict)) {
    throw new UserError(`--on-conflict must be skip | rename | overwrite (got "${onConflict}")`);
  }

  hub.on('export-conflicts', (ev: { req: unknown }) => {
    hub.resolveExportConflicts(ev.req as never, onConflict);
  });

  const result = await hub.exportAssets({
    engine, projectName, exportRoot, assetIds, source, collisionPolicy: onConflict,
  });
  if (ctx.json) {
    ctx.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 2;
  }
  if (!result.ok) {
    ctx.io.err(`export failed: ${result.error}`);
    return 2;
  }
  for (const e of result.exported) {
    for (const f of e.files) ctx.io.out(`✓ ${f}`);
  }
  for (const s of result.skipped) ctx.io.out(`= skipped ${s}`);
  if (result.conflicts.length) ctx.io.out(`  (${result.conflicts.length} conflict(s) resolved with policy "${onConflict}")`);
  for (const f of result.attributionFiles) ctx.io.out(`© ${f}`);
  return 0;
}

export async function cmdUpdate(ctx: CommandCtx): Promise<number> {
  const hub = await ctx.getHub();
  const dryRun = ctx.args.booleans.has('dry-run');
  const onlyId = flag(ctx, 'id');
  const assets = onlyId
    ? [hub.asset(onlyId)].filter(Boolean) as LibraryAsset[]
    : hub.librarySearch({});
  if (!assets.length) {
    ctx.io.out('Library is empty — nothing to update.');
    return 0;
  }
  const counts = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const rows: string[][] = [];
  for (const a of assets) {
    const r = await hub.refreshAssetLicense(a.id, dryRun);
    counts[r.status === 'unchanged' ? 'unchanged' : r.status === 'updated' ? 'updated' : r.status === 'skipped' ? 'skipped' : 'failed'] += 1;
    const icon = r.status === 'updated' ? 'Δ' : r.status === 'failed' ? '✗' : r.status === 'skipped' ? '-' : '=';
    rows.push([icon, a.name.slice(0, 40), a.providerId, a.licenseId, `${r.status}: ${r.detail}`.slice(0, 70)]);
    await sleep(150); // politeness on top of per-host rate limits
  }
  ctx.io.out(table(rows, ['', 'Asset', 'Provider', 'License', 'Result']).join('\n'));
  ctx.io.out('');
  ctx.io.out(`${dryRun ? '(dry run) ' : ''}${counts.updated} updated · ${counts.unchanged} unchanged · ${counts.skipped} skipped · ${counts.failed} failed`);
  return counts.failed > 0 ? 4 : 0;
}

export async function cmdList(ctx: CommandCtx): Promise<number> {
  const hub = await ctx.getHub();
  const assets = hub.librarySearch({
    ...(flag(ctx, 'category') ? { categories: [categoryOr(flag(ctx, 'category')!)] } : {}),
    ...(flag(ctx, 'provider') ? { providers: flagList(ctx, 'provider') } : {}),
    ...(flag(ctx, 'tag') ? { tag: flag(ctx, 'tag')! } : {}),
    ...(ctx.args.booleans.has('favorite') ? { favorites: true } : {}),
    ...(ctx.args.positionals.length ? { text: ctx.args.positionals.join(' ') } : {}),
  });
  if (ctx.json) {
    ctx.io.out(JSON.stringify(assets, null, 2));
    return 0;
  }
  if (!assets.length) {
    ctx.io.out('Library is empty. Download something first: asset-hub search "castle"');
    return 0;
  }
  const rows = assets.map((a) => [
    a.name.slice(0, 36),
    a.providerId,
    a.licenseId,
    a.category,
    fmtBytes(a.fileSize),
    a.id,
  ]);
  ctx.io.out(table(rows, ['Name', 'Source', 'License', 'Category', 'Size', 'Library ID']).join('\n'));
  ctx.io.out('');
  ctx.io.out(`${assets.length} asset(s) — export with: asset-hub export <Library ID> --engine <unreal|unity|godot|blender> --output <dir>`);
  return 0;
}

export async function cmdAttributions(ctx: CommandCtx): Promise<number> {
  const hub = await ctx.getHub();
  const ids = flagList(ctx, 'ids').flatMap((v) => v.split(','));
  const all = hub.librarySearch({});
  const chosen = ids.length ? ids : all.map((a) => a.id);
  if (!chosen.length) throw new UserError('library is empty — nothing to attribute yet');
  const dir = flag(ctx, 'output') ?? hub.libraryDir;
  const files = await hub.writeAttributionFiles(chosen, dir);
  ctx.io.out(`Attribution files written for ${chosen.length} asset(s):`);
  for (const f of files) ctx.io.out(`  ${f}`);
  return 0;
}

// ---------------------------------------------------------------- API keys

const KEY_PROVIDERS: { id: 'sketchfab' | 'polypizza' | 'blenderkit'; name: string; url: string }[] = [
  { id: 'sketchfab', name: 'Sketchfab (download token)', url: 'https://sketchfab.com/settings/password' },
  { id: 'polypizza', name: 'Poly Pizza', url: 'https://poly.pizza/api' },
  { id: 'blenderkit', name: 'BlenderKit', url: 'https://www.blenderkit.com/accounts/dashboard/profile/' },
];

export async function cmdKey(ctx: CommandCtx): Promise<number> {
  const sub = ctx.args.positionals[0] ?? 'list';
  const hub = await ctx.getHub();
  if (sub === 'list') {
    const rows: string[][] = [];
    for (const k of KEY_PROVIDERS) {
      rows.push([k.id, k.name, (await hub.hasApiKey(k.id)) ? 'set ✓' : 'not set', k.url]);
    }
    ctx.io.out(table(rows, ['Provider', 'Used for', 'Status', 'Get a key']).join('\n'));
    ctx.io.out('');
    ctx.io.out(`Keys are stored in: ${hub.getSecretBackend()} (OS credential storage where available).`);
    ctx.io.out('Set with: asset-hub key set <provider> <key>   — values are never printed or logged.');
    return 0;
  }
  if (sub === 'set') {
    const provider = ctx.args.positionals[1] as 'sketchfab' | 'polypizza' | 'blenderkit' | undefined;
    const value = ctx.args.positionals[2];
    if (!provider || !value) throw new UserError('usage: asset-hub key set <sketchfab|polypizza|blenderkit> <key>');
    if (!KEY_PROVIDERS.some((k) => k.id === provider)) throw new UserError(`unknown key provider "${provider}"`);
    await hub.setApiKey(provider, value);
    ctx.io.out(`✓ ${provider} key stored in ${hub.getSecretBackend()}.`);
    return 0;
  }
  if (sub === 'remove') {
    const provider = ctx.args.positionals[1] as 'sketchfab' | 'polypizza' | 'blenderkit' | undefined;
    if (!provider) throw new UserError('usage: asset-hub key remove <provider>');
    await hub.setApiKey(provider, '');
    ctx.io.out(`✓ ${provider} key removed.`);
    return 0;
  }
  throw new UserError(`unknown key subcommand "${sub}" (list | set | remove)`);
}

// ------------------------------------------------------------------- config

const CONFIG_KEYS: Record<string, { type: 'string' | 'number' | 'boolean' | 'number|null' | 'string|null' | 'string[]'; help: string }> = {
  libraryDir: { type: 'string', help: 'root directory for downloaded assets' },
  enabledProviders: { type: 'string[]', help: 'provider allow-list (empty = all)' },
  'downloads.globalConcurrency': { type: 'number', help: 'parallel downloads (1–16)' },
  'downloads.retryLimit': { type: 'number', help: 'retries per download' },
  'downloads.timeoutMs': { type: 'number', help: 'per-request timeout ms' },
  'downloads.speedLimitBps': { type: 'number|null', help: 'speed cap bytes/sec, null = unlimited' },
  'downloads.preferredFormats': { type: 'string[]', help: 'preferred formats e.g. glb,fbx' },
  'network.userAgentExtra': { type: 'string', help: 'appended to the HTTP User-Agent' },
  'network.respectRobots': { type: 'boolean', help: 'honor robots.txt (keep true!)' },
  'converters.blenderPath': { type: 'string|null', help: 'Blender executable for BLEND/FBX conversion' },
  'converters.assimpPath': { type: 'string|null', help: 'assimp executable for FBX/DAE conversion' },
  'converters.defaultTargetFormat': { type: 'string', help: 'glb | gltf | obj' },
  'attribution.includeCc0': { type: 'boolean', help: 'courtesy-list CC0 assets too' },
  'attribution.format': { type: 'string', help: 'txt | md | both' },
  'ui.theme': { type: 'string', help: 'desktop app theme' },
  'ui.perPage': { type: 'number', help: 'search page size' },
};

function getPath(cfg: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], cfg);
}

function setPath<T extends object>(obj: T, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur: Record<string, unknown> = obj as Record<string, unknown>;
  for (const k of parts.slice(0, -1)) {
    cur[k] = { ...(cur[k] as object) };
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function parseValue(raw: string, type: string): unknown {
  if (type === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new UserError(`expected a number, got "${raw}"`);
    return n;
  }
  if (type === 'boolean') {
    if (!['true', 'false'].includes(raw)) throw new UserError(`expected true/false, got "${raw}"`);
    return raw === 'true';
  }
  if (type === 'number|null') return raw === 'null' ? null : parseValue(raw, 'number');
  if (type === 'string|null') return raw === 'null' ? null : raw;
  if (type === 'string[]') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return raw;
}

export async function cmdConfig(ctx: CommandCtx): Promise<number> {
  const sub = ctx.args.positionals[0] ?? 'list';
  const hub = await ctx.getHub();
  const cfg = hub.getConfig() as unknown as Record<string, unknown>;

  if (sub === 'path') {
    ctx.io.out(path.join(hub.paths.userDataDir, 'config.json'));
    return 0;
  }
  if (sub === 'list') {
    const rows = Object.entries(CONFIG_KEYS).map(([k, meta]) => [
      k,
      meta.type,
      JSON.stringify(getPath(cfg, k)) ?? '—',
      meta.help,
    ]);
    ctx.io.out(table(rows, ['Key', 'Type', 'Current', 'Description']).join('\n'));
    ctx.io.out('');
    ctx.io.out(`Config file: ${path.join(hub.paths.userDataDir, 'config.json')}`);
    return 0;
  }
  if (sub === 'get') {
    const key = ctx.args.positionals[1];
    if (!key) throw new UserError('usage: asset-hub config get <key>');
    ctx.io.out(JSON.stringify(getPath(cfg, key), null, 2));
    return 0;
  }
  if (sub === 'set') {
    const key = ctx.args.positionals[1];
    const raw = ctx.args.positionals[2];
    if (!key || raw === undefined) throw new UserError('usage: asset-hub config set <key> <value>');
    const meta = CONFIG_KEYS[key];
    if (!meta) throw new UserError(`unknown config key "${key}". Run "asset-hub config list" for valid keys.`);
    if (key === 'network.respectRobots' && raw === 'false') {
      throw new UserError('robots.txt compliance cannot be disabled — it is a core legal guarantee of this tool.');
    }
    const value = parseValue(raw, meta.type);
    // updateConfig merges top-level keys shallowly, so send the whole section.
    const patch: Record<string, unknown> = {};
    const current = JSON.parse(JSON.stringify(cfg));
    setPath(current, key, value);
    const top = key.split('.')[0];
    patch[top] = current[top];
    await hub.updateConfig(patch as never);
    ctx.io.out(`✓ ${key} = ${JSON.stringify(value)}`);
    return 0;
  }
  throw new UserError(`unknown config subcommand "${sub}" (path | list | get | set)`);
}
