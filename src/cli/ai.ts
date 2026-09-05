/**
 * AI-native commands: find / recommend / acquire / project / import.
 *
 * Deterministic natural-language request parsing (no external LLM), ranked
 * candidate selection with transparent factor metadata, one-command
 * acquisition with license safety, and game-project detection.
 * All machine-readable output follows schemas/*.schema.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Hub } from '../core/services/hub';
import type { EngineId, SearchFilters, SearchPage, AssetRef } from '../core/types';
import { loadModel } from '../core/convert/pipeline';
import { computeBoundingBox, triangleCount } from '../core/convert/mesh';
import { CliError, errorForTask } from './errors';
import {
  CommandCtx, UserError, parseAssetRef, runDownloads, buildFilters, flag, num, cliErrorForEnqueue,
} from './commands';
import {
  AiSearchResult, aiSearchResult, aiProviderErrors, aiLibraryAsset,
} from './output';

// ------------------------------------------------------------------ engines

export const ENGINE_INFO: Record<EngineId, {
  label: string;
  preferred: string[];   // import directly
  convertible: string[]; // asset-hub can convert natively
  assetsDir: string;     // conventional asset folder (relative)
}> = {
  unreal: { label: 'Unreal Engine', preferred: ['fbx', 'glb', 'gltf', 'obj'], convertible: ['glb', 'gltf', 'obj', 'stl', 'ply'], assetsDir: 'Content' },
  unity: { label: 'Unity', preferred: ['fbx', 'glb', 'gltf', 'obj'], convertible: ['glb', 'gltf', 'obj', 'stl', 'ply'], assetsDir: 'Assets' },
  godot: { label: 'Godot', preferred: ['glb', 'gltf', 'obj', 'fbx'], convertible: ['glb', 'gltf', 'obj', 'stl', 'ply', 'dae'], assetsDir: 'assets' },
  blender: { label: 'Blender', preferred: ['blend', 'glb', 'gltf', 'obj', 'fbx', 'stl', 'ply'], convertible: ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx', 'dae'], assetsDir: '' },
};

export type Compatibility = 'preferred' | 'convertible' | 'incompatible' | 'unknown';

export function engineCompatibility(formats: string[], engine: EngineId): { status: Compatibility; note: string } {
  if (!formats || formats.length === 0) {
    return { status: 'unknown', note: 'source does not report formats before download' };
  }
  const f = formats.map((x) => x.toLowerCase());
  const pref = ENGINE_INFO[engine].preferred;
  if (f.some((x) => pref.includes(x))) return { status: 'preferred', note: `direct ${engine} import format: ${f.find((x) => pref.includes(x))}` };
  const conv = ENGINE_INFO[engine].convertible;
  if (f.some((x) => conv.includes(x))) return { status: 'convertible', note: `asset-hub converts to ${pref[0]} before export` };
  return { status: 'incompatible', note: `no supported path to ${engine} (formats: ${f.join(', ')})` };
}

// -------------------------------------------------- deterministic NL parsing

export interface ParsedRequest {
  query: string;
  engine: EngineId | null;
  style: string | null;
  license_filters: { cc0_only: boolean; free_only: boolean; commercial_only: boolean };
  kind: string | null;
  rigged: boolean;
  animated: boolean;
  max_poly: number | null;
  notes: string[];
}

const ENGINE_WORDS: { re: RegExp; engine: EngineId }[] = [
  { re: /\b(unreal|ue4|ue5|unreal\s*engine)\b/i, engine: 'unreal' },
  { re: /\b(unity|unity3d)\b/i, engine: 'unity' },
  { re: /\bgodot\b/i, engine: 'godot' },
  { re: /\bblender\b/i, engine: 'blender' },
];

const STYLE_WORDS = ['realistic', 'low poly', 'lowpoly', 'low-poly', 'stylized', 'cartoon', 'toon', 'sci fi', 'scifi', 'sci-fi', 'fantasy', 'pixel'];

const FILLER_PATTERNS = [
  /\bi\s+(need|want|would like)\s+(a|an|some)?\b/gi,
  /\b(?:please\s+)?(?:find|get|give|show)\s+(?:me\s+)?(?:a|an|some)?\b/gi,
  /\bfor\s+my\s+(?:unreal\s*engine\s*|unity\s*|godot\s*|blender\s+)?(?:game|project)s?\b/gi,
  /\bfor\s+(?:unreal\s*engine|ue4|ue5|unity3d|unity|godot|blender)\b/gi,
  /\badd\s+(?:a|an)\b/gi,
];

export function parseRequest(text: string): ParsedRequest {
  const notes: string[] = [];
  let engine: EngineId | null = null;
  for (const { re, engine: e } of ENGINE_WORDS) {
    if (re.test(text)) {
      engine = e;
      break;
    }
  }
  let style: string | null = null;
  for (const s of STYLE_WORDS) {
    if (new RegExp(s.replace(/[-\s]/g, '[-\\s]?'), 'i').test(text)) {
      style = s.replace(/[-\s]/g, '-').toLowerCase();
      break;
    }
  }
  const cc0Only = /\bcc0\b|public\s*domain|no\s*attribution/i.test(text);
  const freeOnly = /\bfree\b/i.test(text);
  const commercialOnly = /\bcommercial(\s*use)?\b/i.test(text);

  let kind: string | null = null;
  if (/\btexture|material|pbr\b/i.test(text)) kind = /\bmaterial\b/i.test(text) ? 'material' : 'texture';
  else if (/\bhdri|skybox|environment\s*map\b/i.test(text)) kind = 'hdri';

  const rigged = /\brigged?|with\s*(a\s*)?skeleton/i.test(text);
  const animated = /\banimated?|animation\b/i.test(text);

  let max_poly: number | null = null;
  const polyM = /\b(?:under|less\s*than|max(?:imum)?|below)\s+(\d+(?:\.\d+)?)\s*(k|m)?\s*(poly|polys|tris|triangles?|faces)\b/i.exec(text)
    ?? /\b(\d+(?:\.\d+)?)\s*(k|m)?\s*(poly|polys|tris|triangles?)\s*(?:or\s*less|max)?\b/i.exec(text);
  if (polyM) {
    max_poly = parseFloat(polyM[1]) * (polyM[2]?.toLowerCase() === 'k' ? 1000 : polyM[2]?.toLowerCase() === 'm' ? 1_000_000 : 1);
  }
  if (/\blow[-\s]?poly\b/i.test(text) && max_poly === null) {
    max_poly = 10_000;
    notes.push('"low-poly" interpreted as ≤ 10,000 triangles (override with --max-poly)');
  }

  // Query extraction: strip engine words, license words, filler phrases.
  let q = text;
  for (const re of FILLER_PATTERNS) q = q.replace(re, ' ');
  q = q
    .replace(/\b(unreal\s*engine|ue4|ue5|unity3d|unity|godot|blender)\b/gi, ' ')
    .replace(/\bfor\s+my\b|\bgame\b|\bproject\b/gi, ' ')
    .replace(/\bcc0\b|public\s*domain|royalty[-\s]free\b/gi, ' ')
    .replace(/\bfree\b|\bcommercial(\s*use)?\b/gi, ' ')
    .replace(/\bunder\s+\d+(?:\.\d+)?\s*[km]?\s*(poly|polys|tris|triangles?|faces)\b/gi, ' ')
    .replace(/\brigged?|animated?|animation\b/gi, ' ');
  const query = q.replace(/\s+/g, ' ').trim() || text.trim();

  return {
    query,
    engine,
    style,
    license_filters: { cc0_only: cc0Only, free_only: freeOnly, commercial_only: commercialOnly },
    kind,
    rigged,
    animated,
    max_poly,
    notes,
  };
}

// ------------------------------------------------------------------ ranking

export interface ScoreFactor {
  name: string;
  weight: number;
  value: number;
  detail: string;
}

export interface RankedCandidate {
  result: AiSearchResult;
  engine_compatibility?: { engine: EngineId; status: Compatibility; note: string };
  score: { total: number; factors: ScoreFactor[]; basis: string };
}

export interface RankInput {
  engine: EngineId | null;
  query: string;
  wantsRigged: boolean;
  wantsAnimated: boolean;
  maxPoly: number | null;
  tierByProvider: Map<string, string>;
  sizeRange: { min: number; max: number } | null;
}

function relevanceScore(query: string, r: AiSearchResult): { v: number; detail: string } {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!tokens.length) return { v: 0.5, detail: 'no query tokens' };
  const haystack = `${r.name} ${r.tags.join(' ')} ${r.creator ?? ''}`.toLowerCase();
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  const nameHits = tokens.filter((t) => r.name.toLowerCase().includes(t)).length;
  const v = Math.min(1, (hits / tokens.length) * 0.7 + (nameHits / tokens.length) * 0.3);
  return { v, detail: `${hits}/${tokens.length} terms match name/tags${nameHits ? ` (${nameHits} in name)` : ''}` };
}

function licenseScore(r: AiSearchResult): { v: number; detail: string } {
  const id = r.license_id.toLowerCase();
  if (id.includes('cc0') || id.includes('pddc')) return { v: 1, detail: 'CC0 / public domain — safest for any project' };
  if (id.startsWith('cc-by') && !id.includes('nc')) return { v: 0.9, detail: `${r.license_id}: attribution required, commercial-safe` };
  if (r.commercial_use === true) return { v: 0.8, detail: `${r.license_id}: permitted with conditions` };
  return { v: 0.2, detail: `${r.license_id}: restrictive` };
}

function polyScore(r: AiSearchResult, maxPoly: number | null): { v: number; detail: string } | null {
  if (r.polygon_count === null && maxPoly === null) return null;
  if (r.polygon_count === null) return { v: 0.5, detail: 'polygon count not reported by source' };
  const cap = maxPoly ?? 50_000;
  if (r.polygon_count <= cap) return { v: 1, detail: `${r.polygon_count.toLocaleString()} triangles (≤ ${cap.toLocaleString()} budget)` };
  const over = r.polygon_count / cap;
  return { v: Math.max(0.1, 1 - Math.min(over, 3) * 0.3), detail: `${r.polygon_count.toLocaleString()} triangles exceeds ${cap.toLocaleString()} budget` };
}

function textureScore(r: AiSearchResult): { v: number; detail: string } | null {
  if (r.texture_resolution === null) return null;
  const px = r.texture_resolution;
  const v = px >= 4096 ? 1 : px >= 2048 ? 0.8 : px >= 1024 ? 0.6 : 0.4;
  return { v, detail: `${px}px textures` };
}

function sizeScore(r: AiSearchResult, range: { min: number; max: number } | null): { v: number; detail: string } | null {
  if (r.file_size_bytes === null || !range || range.max === range.min) return null;
  const t = (Math.log(r.file_size_bytes + 1) - Math.log(range.min + 1)) / (Math.log(range.max + 1) - Math.log(range.min + 1));
  return { v: Math.max(0.3, 1 - t * 0.7), detail: `${(r.file_size_bytes / 1024 / 1024).toFixed(1)} MB` };
}

export function rankCandidates(results: AiSearchResult[], input: RankInput): { ranked: RankedCandidate[]; excluded: { id: string; name: string; reason: string }[] } {
  const ranked: RankedCandidate[] = [];
  const excluded: { id: string; name: string; reason: string }[] = [];
  for (const r of results) {
    if (r.license.unknown) {
      excluded.push({ id: r.id, name: r.name, reason: 'license unknown — never auto-selected (LICENSE_UNKNOWN)' });
      continue;
    }
    if (r.commercial_use === false) {
      excluded.push({ id: r.id, name: r.name, reason: `license ${r.license_id} is not commercial-safe` });
      continue;
    }
    const factors: ScoreFactor[] = [];
    const lic = licenseScore(r);
    factors.push({ name: 'license_safety', weight: 3, value: lic.v, detail: lic.detail });
    factors.push({ name: 'download_availability', weight: 2, value: r.download_available ? 1 : 0, detail: r.download_available ? 'official automated download available' : 'manual download only' });
    const rel = relevanceScore(input.query, r);
    factors.push({ name: 'relevance', weight: 3, value: rel.v, detail: rel.detail });
    if (input.engine) {
      const compat = engineCompatibility(r.formats, input.engine);
      const v = compat.status === 'preferred' ? 1 : compat.status === 'convertible' ? 0.7 : compat.status === 'unknown' ? 0.5 : 0;
      factors.push({ name: 'engine_compatibility', weight: 2, value: v, detail: `${compat.status}: ${compat.note}` });
    }
    const native = ['glb', 'gltf', 'obj', 'stl', 'ply'];
    const hasNative = r.formats.some((f) => native.includes(f.toLowerCase()));
    factors.push({
      name: 'format_compatibility', weight: 1,
      value: hasNative ? 1 : r.formats.length ? 0.6 : 0.5,
      detail: hasNative ? `formats ${r.formats.join('/')} natively supported` : r.formats.length ? `formats ${r.formats.join('/')} need external converters` : 'formats unreported',
    });
    const poly = polyScore(r, input.maxPoly);
    if (poly) factors.push({ name: 'polygon_count', weight: 1, value: poly.v, detail: poly.detail });
    const tex = textureScore(r);
    if (tex) factors.push({ name: 'texture_quality', weight: 1, value: tex.v, detail: tex.detail });
    if (input.wantsRigged || input.wantsAnimated) {
      const v = (input.wantsRigged ? r.rigged : true) && (input.wantsAnimated ? r.animated : true) ? 1 : 0;
      factors.push({ name: 'rigging_animation', weight: 2, value: v, detail: `rigged=${r.rigged} animated=${r.animated}` });
    }
    const tier = input.tierByProvider.get(r.provider) ?? 'manual';
    factors.push({ name: 'source_reliability', weight: 1, value: tier === 'full' ? 1 : tier === 'hybrid' ? 0.8 : 0.5, detail: `provider ${r.provider} (${tier} API tier)` });
    const size = sizeScore(r, input.sizeRange);
    if (size) factors.push({ name: 'file_size', weight: 1, value: size.v, detail: size.detail });

    const wSum = factors.reduce((n, f) => n + f.weight, 0);
    const total = wSum ? factors.reduce((n, f) => n + f.weight * f.value, 0) / wSum : 0;
    ranked.push({
      result: r,
      ...(input.engine ? { engine_compatibility: { engine: input.engine, ...engineCompatibility(r.formats, input.engine) } } : {}),
      score: {
        total: Math.round(total * 1000) / 1000,
        factors,
        basis: 'weighted mean over factors with available data only; missing metadata never lowers a score',
      },
    });
  }
  ranked.sort((a, b) => b.score.total - a.score.total);
  return { ranked, excluded };
}

// ---------------------------------------------------------- project detection

export interface ProjectInfo {
  detected: boolean;
  engine: EngineId | null;
  project_path: string | null;
  asset_directory: string | null;
  markers: string[];
  note: string;
}

export function detectProject(root: string): ProjectInfo {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { detected: false, engine: null, project_path: null, asset_directory: null, markers: [], note: `cannot read ${root}` };
  }
  const markers: string[] = [];
  const uproject = entries.find((e) => e.isFile() && e.name.endsWith('.uproject'));
  if (uproject) markers.push(uproject.name);
  const hasGodot = entries.some((e) => e.isFile() && e.name === 'project.godot');
  if (hasGodot) markers.push('project.godot');
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const unityLike = dirs.includes('Assets') && dirs.includes('ProjectSettings');
  if (unityLike) markers.push('Assets/', 'ProjectSettings/');
  const blend = entries.find((e) => e.isFile() && e.name.endsWith('.blend'));
  if (blend) markers.push(blend.name);

  let engine: EngineId | null = null;
  if (uproject) engine = 'unreal';
  else if (hasGodot) engine = 'godot';
  else if (unityLike) engine = 'unity';
  else if (blend) engine = 'blender';

  return {
    detected: !!engine,
    engine,
    project_path: engine ? path.resolve(root) : null,
    asset_directory: engine ? ENGINE_INFO[engine].assetsDir : null,
    markers,
    note: engine
      ? `${ENGINE_INFO[engine].label} project detected via ${markers[0]}`
      : 'no game-project markers found (looked for *.uproject, project.godot, Assets/+ProjectSettings/, *.blend)',
  };
}

// ------------------------------------------------------------------ commands

async function searchAndRank(ctx: CommandCtx, parsed: ParsedRequest, engineOverride: EngineId | null, limit: number | null) {
  const hub = await ctx.getHub();
  const engine = engineOverride ?? parsed.engine;
  const filters: SearchFilters = {
    ...buildFilters(ctx),
    ...(parsed.license_filters.cc0_only ? { cc0Only: true } : {}),
    ...(parsed.license_filters.free_only ? { freeOnly: true } : {}),
    ...(parsed.license_filters.commercial_only ? { commercialOnly: true } : {}),
    ...(parsed.kind ? { kind: parsed.kind as SearchFilters['kind'] } : {}),
    ...(parsed.max_poly !== null ? { maxPolyCount: parsed.max_poly } : {}),
    ...(parsed.rigged ? { riggedOnly: true } : {}),
    ...(parsed.animated ? { animatedOnly: true } : {}),
  };
  const providers = (ctx.args.flags.get('provider') ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
  const pages: SearchPage[] = await hub.search({
    text: parsed.query,
    providers: providers.length ? providers : undefined,
    filters,
    perPage: limit ?? 24,
  });
  const providerErrors = aiProviderErrors(pages);
  const results = pages.flatMap((p) => p.results).map(aiSearchResult);
  const tierByProvider = new Map<string, string>();
  for (const info of await hub.providerInfos()) tierByProvider.set(String(info.id), String(info.tier));
  const sizes = results.map((r) => r.file_size_bytes).filter((n): n is number => n !== null);
  const { ranked, excluded } = rankCandidates(results, {
    engine,
    query: parsed.query,
    wantsRigged: parsed.rigged,
    wantsAnimated: parsed.animated,
    maxPoly: parsed.max_poly ?? num(ctx, 'max-poly') ?? null,
    tierByProvider,
    sizeRange: sizes.length >= 2 ? { min: Math.min(...sizes), max: Math.max(...sizes) } : null,
  });
  return { hub, engine, parsed, filters, providerErrors, results, ranked, excluded };
}

export async function cmdFind(ctx: CommandCtx): Promise<number> {
  const text = ctx.args.positionals.join(' ').trim();
  if (!text) throw new UserError('usage: asset-hub find "<natural-language asset request>"');
  const parsed = parseRequest(text);
  const { engine, providerErrors, results } = await searchAndRank(ctx, parsed, null, num(ctx, 'limit') ?? 12);
  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      request: text,
      parsed: { ...parsed, engine_hint: engine },
      results,
      provider_errors: providerErrors,
    }, null, 2));
    return 0;
  }
  ctx.io.out(`Parsed request:`);
  ctx.io.out(`  query:    "${parsed.query}"`);
  if (engine) ctx.io.out(`  engine:   ${engine}`);
  if (parsed.style) ctx.io.out(`  style:    ${parsed.style}`);
  const lf = Object.entries(parsed.license_filters).filter(([, v]) => v).map(([k]) => k);
  if (lf.length) ctx.io.out(`  license:  ${lf.join(', ')}`);
  if (parsed.max_poly !== null) ctx.io.out(`  max poly: ${parsed.max_poly}`);
  ctx.io.out('');
  results.forEach((r, i) => ctx.io.out(assetLine(i + 1, r)));
  ctx.io.out('');
  ctx.io.out(`${results.length} result(s). Refine with: asset-hub search "${parsed.query}" --cc0 --json`);
  for (const e of providerErrors) ctx.io.out(`! ${e.provider}: ${e.message}`);
  return 0;
}

function assetLine(n: number, r: AiSearchResult): string {
  return [
    `${n}. ${r.name}  [${r.id}]`,
    `   ${r.license_id}${r.commercial_use === false ? ' (non-commercial!)' : r.commercial_use ? '' : ''} · ${r.formats.join('/') || 'formats unreported'}${r.polygon_count ? ` · ${r.polygon_count.toLocaleString()} tris` : ''}`,
  ].join('\n');
}

export async function cmdRecommend(ctx: CommandCtx): Promise<number> {
  const text = ctx.args.positionals.join(' ').trim();
  if (!text) throw new UserError('usage: asset-hub recommend "<natural-language asset request>" [--engine <id>] [--dry-run] [--json]');
  const parsed = parseRequest(text);
  const engineFlag = flag(ctx, 'engine') as EngineId | undefined;
  if (engineFlag && !(engineFlag in ENGINE_INFO)) throw new UserError(`unknown engine "${engineFlag}" (unreal | unity | godot | blender)`);
  const { engine, ranked, excluded, providerErrors } = await searchAndRank(ctx, parsed, engineFlag ?? null, num(ctx, 'limit') ?? 24);
  const top = ranked.slice(0, num(ctx, 'limit') ?? 10);
  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      request: text,
      parsed: { ...parsed, engine_hint: engine },
      candidates: top.map((c) => ({ ...c.result, engine_compatibility: c.engine_compatibility, score: c.score })),
      recommendation: top.length
        ? { id: top[0].result.id, name: top[0].result.name, score: top[0].score.total, reason: topReason(top[0]) }
        : null,
      excluded,
      provider_errors: providerErrors,
      dry_run: true, // recommend never downloads
    }, null, 2));
    return top.length ? 0 : 4;
  }
  if (!top.length) {
    ctx.io.err(`No safe candidates (${excluded.length} excluded). Reasons:`);
    for (const e of excluded.slice(0, 8)) ctx.io.err(`  - ${e.id}: ${e.reason}`);
    return 4;
  }
  top.forEach((c, i) => {
    ctx.io.out(`${i + 1}. ${c.result.name}  [${c.result.id}]  score ${c.score.total}`);
    ctx.io.out(`   ${c.result.license_id} · ${c.result.formats.join('/') || 'formats unreported'}${c.result.polygon_count ? ` · ${c.result.polygon_count.toLocaleString()} tris` : ''}${c.engine_compatibility ? ` · ${c.engine_compatibility.status} for ${engine}` : ''}`);
    ctx.io.out(`   why: ${topReason(c)}`);
  });
  ctx.io.out('');
  ctx.io.out(`Recommended: ${top[0].result.id} — acquire with: asset-hub acquire "${text}"${engine ? ` --engine ${engine}` : ''}`);
  return 0;
}

function topReason(c: RankedCandidate): string {
  const f = [...c.score.factors].sort((a, b) => b.weight * b.value - a.weight * a.value);
  return f.slice(0, 3).map((x) => x.detail).join('; ');
}

// ------------------------------------------------------------------- acquire

export async function cmdProject(ctx: CommandCtx): Promise<number> {
  const root = flag(ctx, 'path') ?? process.cwd();
  const info = detectProject(root);
  if (ctx.json) {
    ctx.io.out(JSON.stringify(info, null, 2));
    return info.detected ? 0 : 1;
  }
  ctx.io.out(`Path:     ${path.resolve(root)}`);
  ctx.io.out(`Detected: ${info.detected ? `${info.engine} (${ENGINE_INFO[info.engine!].label})` : 'no'}`);
  if (info.markers.length) ctx.io.out(`Markers:  ${info.markers.join(', ')}`);
  if (info.asset_directory) ctx.io.out(`Assets:   ${info.asset_directory}${path.sep}`);
  ctx.io.out(info.note);
  return info.detected ? 0 : 1;
}

export async function cmdAcquire(ctx: CommandCtx): Promise<number> {
  const text = ctx.args.positionals.join(' ').trim();
  if (!text) throw new UserError('usage: asset-hub acquire "<request>" [--engine <id>] [--project DIR|--output DIR] [--dry-run] [--require-confirmation] [--yes] [--optimize] [--json]');
  const parsed = parseRequest(text);
  const engineFlag = flag(ctx, 'engine') as EngineId | undefined;
  if (engineFlag && !(engineFlag in ENGINE_INFO)) throw new UserError(`unknown engine "${engineFlag}" (unreal | unity | godot | blender)`);

  const projectFlag = flag(ctx, 'project');
  const outputFlag = flag(ctx, 'output');
  let project: ProjectInfo | null = null;
  if (projectFlag) {
    project = detectProject(projectFlag);
    if (!project.detected) {
      if (!engineFlag) throw new CliError('INVALID_USAGE', `--project ${projectFlag} has no detectable engine markers; pass --engine explicitly`, { path: projectFlag });
      project = { ...project, detected: true, engine: engineFlag, project_path: path.resolve(projectFlag), asset_directory: ENGINE_INFO[engineFlag].assetsDir };
    }
  }
  const cwdProject = detectProject(process.cwd());
  const engine: EngineId | null = engineFlag ?? parsed.engine ?? project?.engine ?? (cwdProject.detected && !outputFlag ? cwdProject.engine : null);
  const exportRoot = project?.project_path ?? (outputFlag ? path.resolve(outputFlag) : (engine && cwdProject.detected ? cwdProject.project_path : null));

  const dryRun = ctx.args.booleans.has('dry-run');
  const optimize = ctx.args.booleans.has('optimize') || /optimi[sz]ed?\b/i.test(text);
  const { hub, ranked, excluded, providerErrors } = await searchAndRank(ctx, parsed, engine, num(ctx, 'limit') ?? 24);
  if (!ranked.length) {
    const code = excluded.length ? 'LICENSE_RESTRICTED' : 'NOT_FOUND';
    throw new CliError(code,
      excluded.length
        ? `all ${excluded.length} candidate(s) were excluded for license reasons; nothing can be safely auto-acquired`
        : `no candidates found for "${parsed.query}"`,
      { command: 'acquire' });
  }
  const chosen = ranked[0];

  // Fresh license verification from official provider data (never cached guesswork).
  const [prov, assetId] = chosen.result.id.split(/:(.+)/) as [string, string];
  const detail = await hub.getAssetDetail(prov, assetId);
  if (detail.license.unknown) {
    throw new CliError('LICENSE_UNKNOWN', `license for ${chosen.result.id} could not be verified from official data; acquisition blocked`, { asset_id: chosen.result.id, source: prov });
  }

  const steps: string[] = [];
  steps.push(`search "${parsed.query}" → ${ranked.length} safe candidate(s)`);
  steps.push(`verify license of ${chosen.result.id} → ${detail.license.id} (official data)`);
  const compat = engine ? engineCompatibility(chosen.result.formats, engine) : null;
  const needsConvert = engine ? compat?.status === 'convertible' : false;
  const plan = {
    selected: chosen.result.id,
    name: chosen.result.name,
    license: detail.license.id,
    estimated_size_bytes: chosen.result.file_size_bytes ?? detail.options[0]?.sizeBytes ?? null,
    steps: [...steps],
    processing: [
      ...(needsConvert ? [`convert to ${ENGINE_INFO[engine!].preferred[0]} for ${engine}`] : []),
      ...(optimize ? ['optimize (weld · normals · prune · compressed textures)'] : []),
    ],
    export: exportRoot
      ? { engine, project_path: exportRoot, asset_directory: engine ? ENGINE_INFO[engine].assetsDir : null }
      : null,
    attribution_required: detail.license.attributionRequired,
    attribution_note: detail.license.attributionRequired
      ? 'ATTRIBUTIONS.txt/.md will be generated next to the exported files — ship them with your game.'
      : 'license recorded in asset.json; CC0 credit is courtesy, not obligation',
    alternatives: ranked.slice(1, 4).map((c) => ({ id: c.result.id, score: c.score.total })),
    runner_up_note: undefined as string | undefined,
  };

  if (dryRun) {
    if (ctx.json) {
      ctx.io.out(JSON.stringify({
        success: true, dry_run: true, request: text,
        parsed: { ...parsed, engine_hint: engine },
        plan,
        candidates: ranked.slice(0, 5).map((c) => ({ ...c.result, score: c.score })),
        excluded, provider_errors: providerErrors,
      }, null, 2));
      return 0;
    }
    printHumanPlan(ctx, text, plan, chosen.result.name);
    return 0;
  }

  if (ctx.args.booleans.has('require-confirmation') && !ctx.args.booleans.has('yes')) {
    if (ctx.json) throw new CliError('CONFIRMATION_REQUIRED', 'use --json --dry-run to inspect the plan, then run with --yes (or without --json for an interactive prompt)', { command: 'acquire' });
    printHumanPlan(ctx, text, plan, chosen.result.name);
    const ok = await promptYesNo();
    if (!ok) {
      ctx.io.out('aborted — nothing was downloaded.');
      return 0;
    }
  }

  // ---- execute: download → verify → inspect → convert/optimize → export
  const outcomes = await runDownloads(ctx, [{ provider: prov, assetId }]);
  const enqueueErrors = (outcomes as unknown as { enqueueErrors: { ref: string; message: string }[] }).enqueueErrors ?? [];
  const outcome = outcomes[0];
  if (!outcome) throw cliErrorForEnqueue(chosen.result.id, enqueueErrors[0]?.message ?? 'could not enqueue download');
  if (outcome.task.state !== 'completed' && outcome.task.state !== 'skipped_duplicate') {
    throw errorForOutcome(outcome, chosen.result.id, prov);
  }
  const duplicate = outcome.task.state === 'skipped_duplicate';
  let asset = outcome.asset ?? null;
  if (!asset) {
    // duplicate path: locate the existing library asset by source URL
    asset = hub.librarySearch({}).find((a) => a.sourceUrl === chosen.result.source_url) ?? null;
  }
  if (!asset) throw new CliError('DOWNLOAD_UNAVAILABLE', 'download finished but the library asset could not be resolved');

  // inspect (best effort — zip archives may not be directly parseable)
  let inspection: Record<string, unknown> | null = null;
  try {
    const model = await loadModel(asset.localPath);
    const bbox = computeBoundingBox(model.meshes);
    inspection = {
      meshes: model.meshes.length,
      vertices: model.meshes.reduce((n, m) => n + m.positions.length / 3, 0),
      triangle_count: model.meshes.reduce((n, m) => n + triangleCount(m), 0),
      materials: model.materials.length,
      animations: model.animations.map((a) => a.name),
      skeleton: model.hasSkeleton,
      dimensions: [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]].map((v) => Math.round(v * 100) / 100),
    };
  } catch {
    inspection = { note: `native inspection unavailable for .${path.extname(asset.localPath).slice(1)} (use inspect after extraction/external conversion)` };
  }

  // convert if the engine prefers a format we can produce from what we got
  let processing: Record<string, unknown> = { converted: false, optimized: false };
  const targetFormat = needsConvert ? (ENGINE_INFO[engine!].preferred[0] === 'fbx' ? 'glb' : ENGINE_INFO[engine!].preferred[0]) : null;
  if (targetFormat || optimize) {
    const opts: Record<string, unknown> = { targetFormat: targetFormat ?? path.extname(asset.localPath).replace('.', '') };
    if (optimize) Object.assign(opts, { weldVertices: true, recomputeNormals: true, pruneUnusedMaterials: true, textureCompress: { format: 'jpeg', quality: 85 } });
    const conv = await hub.convertAsset(asset.id, opts as never);
    if (conv.ok) {
      processing = {
        converted: !!targetFormat,
        optimized: optimize,
        target_format: targetFormat,
        outputs: conv.outputs.map((o) => ({ path: o.path, kind: o.kind, size_bytes: o.bytes })),
        ...(conv.stats ? { stats: { vertices: conv.stats.vertices, triangle_count: conv.stats.faces } } : {}),
      };
    } else {
      if (targetFormat) throw new CliError('CONVERSION_FAILED', conv.error ?? 'conversion failed', { asset_id: chosen.result.id });
      processing = { converted: false, optimized: false, warning: conv.error };
    }
  }

  // export into the game project when a target exists
  let exportInfo: Record<string, unknown> | null = null;
  if (exportRoot && engine) {
    hub.on('export-conflicts', (ev: { req: unknown }) => hub.resolveExportConflicts(ev.req as never, 'skip'));
    const exp = await hub.exportAssets({
      engine, projectName: '', exportRoot, assetIds: [asset.id],
      source: processing.outputs ? 'gameReady' : 'original',
      collisionPolicy: 'skip',
    });
    if (!exp.ok) throw new CliError('EXPORT_FAILED', exp.error ?? 'export failed', { asset_id: chosen.result.id });
    exportInfo = {
      engine,
      path: exportRoot,
      files: exp.exported.flatMap((e) => e.files),
      attribution_files: exp.attributionFiles,
    };
  }

  const result = {
    success: true as const,
    dry_run: false,
    request: text,
    parsed: { ...parsed, engine_hint: engine },
    asset: {
      ref: chosen.result.id,
      name: asset.name,
      source: asset.providerId,
      source_url: asset.sourceUrl,
      license: asset.licenseId,
      license_url: asset.licenseUrl ?? null,
      library_id: asset.id,
    },
    download: {
      duplicate,
      path: asset.localPath,
      category: asset.category,
      size_bytes: asset.fileSize,
      sha256: asset.sha256 ?? null,
      verified: !!asset.sha256,
      metadata_path: path.join(path.dirname(asset.originalDir), 'asset.json'),
    },
    inspection,
    processing,
    export: exportInfo,
    attribution: {
      required: detail.license.attributionRequired,
      license: detail.license.id,
      text: asset.attributionText ?? null,
      files: exportInfo
        ? (exportInfo.attribution_files as string[])
        : [path.join(hub.libraryDir, 'ATTRIBUTIONS.txt'), path.join(hub.libraryDir, 'ATTRIBUTIONS.md')],
    },
  };
  if (ctx.json) {
    ctx.io.out(JSON.stringify(result, null, 2));
    return 0;
  }
  printHumanResult(ctx, result);
  return 0;
}

function errorForOutcome(outcome: { task: { state: string; error?: string; errorCode?: string } } | undefined, ref: string, provider: string): CliError {
  if (!outcome) return new CliError('DOWNLOAD_UNAVAILABLE', `could not enqueue ${ref}`, { asset_id: ref, source: provider });
  const e = errorForTask(outcome.task.state, outcome.task.errorCode, outcome.task.error);
  e.context = { ...e.context, asset_id: ref, source: provider };
  return e;
}

function printHumanPlan(ctx: CommandCtx, text: string, plan: Record<string, unknown>, name: string): void {
  ctx.io.out(`Plan for: "${text}"`);
  ctx.io.out(`  selected:  ${plan.selected} (${name})`);
  ctx.io.out(`  license:   ${plan.license}${plan.attribution_required ? ' — attribution required' : ''}`);
  ctx.io.out(`  size:      ${plan.estimated_size_bytes ? `${(Number(plan.estimated_size_bytes) / 1024 / 1024).toFixed(1)} MB (estimate)` : 'unknown'}`);
  for (const s of plan.steps as string[]) ctx.io.out(`  · ${s}`);
  for (const s of (plan.processing as string[]) ?? []) ctx.io.out(`  · ${s}`);
  const ex = plan.export as { engine: string; project_path: string } | null;
  ctx.io.out(`  export:    ${ex ? `${ex.engine} → ${ex.project_path}` : 'library only (no project target given)'}`);
  ctx.io.out(`  ${plan.attribution_note}`);
}

async function promptYesNo(): Promise<boolean> {
  const tty = process.stdin.isTTY;
  if (!tty) {
    throw new CliError('CONFIRMATION_REQUIRED', 'no interactive terminal available; re-run with --yes (license checks still apply) or --dry-run');
  }
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Proceed with this acquisition? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printHumanResult(ctx: CommandCtx, r: Record<string, unknown>): void {
  const a = r.asset as Record<string, string>;
  const d = r.download as Record<string, unknown>;
  ctx.io.out(`✓ Acquired ${a.name} [${a.ref}]`);
  ctx.io.out(`   License: ${a.license}${(r.attribution as { required: boolean }).required ? ' (attribution required — see ATTRIBUTIONS files)' : ''}`);
  ctx.io.out(`   Saved:   ${d.path} (${((Number(d.size_bytes)) / 1024).toFixed(1)} KB, sha256 ${String(d.sha256).slice(0, 12)}…)`);
  ctx.io.out(`   Duplicate: ${d.duplicate ? 'already had it — reused' : 'no'}`);
  const ins = r.inspection as Record<string, unknown> | null;
  if (ins && ins.triangle_count !== undefined) ctx.io.out(`   Mesh:    ${ins.triangle_count} triangles · ${ins.vertices} vertices`);
  const p = r.processing as Record<string, unknown>;
  if (p.converted || p.optimized) ctx.io.out(`   Processed: ${[p.converted ? 'converted' : null, p.optimized ? 'optimized' : null].filter(Boolean).join(' + ')}`);
  const e = r.export as { engine: string; files: string[] } | null;
  if (e) {
    ctx.io.out(`   Export:  ${e.engine} → ${e.files.length} file(s)`);
    for (const f of e.files.slice(0, 4)) ctx.io.out(`     ${f}`);
  }
}

// -------------------------------------------------------------------- import

export async function cmdImport(ctx: CommandCtx): Promise<number> {
  const target = ctx.args.positionals[0];
  if (!target) throw new UserError('usage: asset-hub import <provider:asset-id | model-file> --project ./MyGame [--engine <id>] [--json]');
  const projectFlag = flag(ctx, 'project') ?? flag(ctx, 'output');
  const engineFlag = flag(ctx, 'engine') as EngineId | undefined;

  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    // ---- local file import: register with an explicit license, then export
    const licenseRaw = flag(ctx, 'license');
    if (!licenseRaw) {
      throw new CliError('INVALID_USAGE', 'importing a local file requires --license <id-or-name> (the license is recorded and enforced; unknown licenses are refused)', { path: target });
    }
    const providerId = flag(ctx, 'provider');
    if (!providerId) throw new CliError('INVALID_USAGE', 'importing a local file requires --provider <id> (where you obtained it — see asset-hub sources)', { path: target });
    const hub = await ctx.getHub();
    const { asset, duplicates } = await hub.importLocalFile({
      filePath: path.resolve(target),
      providerId,
      name: flag(ctx, 'name') ?? undefined,
      creator: flag(ctx, 'creator') ?? undefined,
      sourceUrl: flag(ctx, 'source-url') ?? undefined,
      licenseRaw,
      licenseUrl: flag(ctx, 'license-url') ?? undefined,
    });
    let exportInfo: Record<string, unknown> | null = null;
    const engine = engineFlag ?? (projectFlag ? detectProject(projectFlag).engine : null);
    if (projectFlag && engine) {
      const exp = await hub.exportAssets({
        engine, projectName: '', exportRoot: path.resolve(projectFlag),
        assetIds: [asset.id], source: 'original', collisionPolicy: 'skip',
      });
      exportInfo = { engine, path: path.resolve(projectFlag), files: exp.exported.flatMap((e) => e.files), attribution_files: exp.attributionFiles };
    }
    if (ctx.json) {
      ctx.io.out(JSON.stringify({
        success: true,
        imported_local_file: path.resolve(target),
        asset: aiLibraryAsset(asset),
        duplicate: duplicates.duplicate,
        export: exportInfo,
      }, null, 2));
      return 0;
    }
    ctx.io.out(`✓ imported ${asset.name} (license ${asset.licenseId})`);
    ctx.io.out(`  library: ${asset.localPath}`);
    if (exportInfo) ctx.io.out(`  export:  ${String(exportInfo.path)} (${(exportInfo.files as string[]).length} files)`);
    return 0;
  }

  // ---- provider ref: full pipeline (verify → download → export) into the project
  parseAssetRef(target); // validate shape (throws INVALID_ASSET otherwise)
  return await cmdAcquireRef(ctx, target);
}

/** acquire, but with an explicit asset ref instead of a search request. */
async function cmdAcquireRef(ctx: CommandCtx, ref: string): Promise<number> {
  const { provider, assetId } = parseAssetRef(ref);
  const hub = await ctx.getHub();
  const detail = await hub.getAssetDetail(provider, assetId);
  if (!detail.asset) throw new CliError('INVALID_ASSET', `asset not found: ${ref}`, { asset_id: ref });
  if (detail.license.unknown) throw new CliError('LICENSE_UNKNOWN', `license for ${ref} could not be verified; import blocked`, { asset_id: ref, source: provider });

  const dryRun = ctx.args.booleans.has('dry-run');
  const engineFlag = flag(ctx, 'engine') as EngineId | null;
  const projectFlag = flag(ctx, 'project') ?? flag(ctx, 'output');
  let engine: EngineId | null = engineFlag;
  if (!engine && projectFlag) engine = detectProject(projectFlag).engine;
  if (!engine) engine = detectProject(process.cwd()).engine;

  const plan = {
    selected: ref,
    name: detail.asset.name,
    license: detail.license.id,
    estimated_size_bytes: detail.options[0]?.sizeBytes ?? null,
    steps: [`verify license of ${ref} → ${detail.license.id}`],
    processing: [],
    export: projectFlag && engine ? { engine, project_path: path.resolve(projectFlag), asset_directory: ENGINE_INFO[engine].assetsDir } : null,
    attribution_required: detail.license.attributionRequired,
    attribution_note: detail.license.attributionRequired ? 'ATTRIBUTIONS.txt/.md will be generated next to the exported files.' : 'license recorded in asset.json.',
  };
  if (dryRun) {
    if (ctx.json) ctx.io.out(JSON.stringify({ success: true, dry_run: true, plan }, null, 2));
    else printHumanPlan(ctx, ref, plan, detail.asset.name);
    return 0;
  }

  const outcomes = await runDownloads(ctx, [{ provider, assetId }]);
  const enqueueErrors = (outcomes as unknown as { enqueueErrors: { ref: string; message: string }[] }).enqueueErrors ?? [];
  const outcome = outcomes[0];
  if (!outcome) throw cliErrorForEnqueue(ref, enqueueErrors[0]?.message ?? 'could not enqueue download');
  if (outcome.task.state !== 'completed' && outcome.task.state !== 'skipped_duplicate') {
    throw errorForOutcome(outcome, ref, provider);
  }
  const duplicate = outcome.task.state === 'skipped_duplicate';
  const asset = outcome.asset ?? hub.librarySearch({}).find((a) => a.sourceUrl === detail.asset!.assetUrl) ?? null;
  if (!asset) throw new CliError('DOWNLOAD_UNAVAILABLE', 'download finished but the library asset could not be resolved');

  let exportInfo: Record<string, unknown> | null = null;
  if (projectFlag && engine) {
    const exp = await hub.exportAssets({
      engine, projectName: '', exportRoot: path.resolve(projectFlag),
      assetIds: [asset.id], source: 'original', collisionPolicy: 'skip',
    });
    if (!exp.ok) throw new CliError('EXPORT_FAILED', exp.error ?? 'export failed', { asset_id: ref });
    exportInfo = { engine, path: path.resolve(projectFlag), files: exp.exported.flatMap((e) => e.files), attribution_files: exp.attributionFiles };
  }
  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      success: true,
      asset: { ref, name: asset.name, source: asset.providerId, source_url: asset.sourceUrl, license: asset.licenseId, library_id: asset.id },
      download: { duplicate, path: asset.localPath, sha256: asset.sha256 ?? null, verified: !!asset.sha256, metadata_path: path.join(path.dirname(asset.originalDir), 'asset.json') },
      export: exportInfo,
      attribution: { required: detail.license.attributionRequired, license: detail.license.id },
    }, null, 2));
    return 0;
  }
  ctx.io.out(`✓ imported ${asset.name} [${ref}] → ${asset.localPath}`);
  if (exportInfo) ctx.io.out(`  export: ${String(exportInfo.path)} (${(exportInfo.files as string[]).length} files)`);
  return 0;
}
