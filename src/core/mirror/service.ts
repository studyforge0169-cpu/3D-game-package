/**
 * MirrorService — large-scale legally-compliant asset mirroring (spec §1–15).
 *
 * Pipeline: discover → license/redistribution gate → download → integrity
 * verify → deduplicate → metadata → organize into assets/<category>/ →
 * indexes/attribution/license registry → git staging/commit/push (via CLI).
 *
 * Only assets whose individual license explicitly allows redistribution are
 * ever downloaded; everything else is recorded with a skip reason and its
 * official source URL (metadata-only catalog). Nothing is faked.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { Hub } from '../services/hub';
import type { AssetCategory, AssetRef, DownloadOption, SearchPage } from '../types';
import { categorize } from '../library/categorize';
import { sha256File } from '../util/hash';
import { ensureDir, atomicWriteFile } from '../util/fsutil';
import { rootLogger } from '../util/logger';
import { MirrorEntry, MirrorState } from './state';
import * as git from './git';

const log = rootLogger.child('mirror');

export type MirrorTier = 'FULL_MIRROR' | 'PARTIAL_MIRROR' | 'METADATA_ONLY' | 'MANUAL_ONLY' | 'UNSUPPORTED';

export interface ProviderMirrorInfo {
  providerId: string;
  displayName: string;
  tier: MirrorTier;
  canEnumerate: boolean;
  canDownload: boolean;
  /** Site-wide redistributable blanket license (e.g. CC0), else per-asset. */
  redistributableSiteWide: boolean;
  licenseDiscoverable: boolean;
  automationPermitted: boolean;
  note: string;
}

const CATEGORY_DIRS: Record<AssetCategory, string> = {
  Characters: 'characters',
  Creatures: 'creatures',
  Weapons: 'weapons',
  Vehicles: 'vehicles',
  Buildings: 'buildings',
  Environment: 'environments',
  Props: 'props',
  Vegetation: 'vegetation',
  Materials: 'materials',
  Textures: 'textures',
  HDRIs: 'hdri',
  Animations: 'animations',
  VFX: 'vfx',
  Other: 'misc',
};

export function categoryDir(asset: AssetRef): string {
  return CATEGORY_DIRS[asset.categoryHint ?? categorize(asset)] ?? 'misc';
}

function slugify(name: string, ref: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'asset';
  let hash = 0;
  for (const ch of ref) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `${base}-${hash.toString(36).slice(0, 6)}`;
}

// ------------------------------------------------------------- classification

export function classifyProviders(hub: Hub): ProviderMirrorInfo[] {
  const out: ProviderMirrorInfo[] = [];
  for (const p of hub.providers.values()) {
    if (p.info.id === 'mock' && !hub.providers.has('mock')) continue;
    const c = p.info.capabilities;
    const siteCc0 = /^cc0|public domain/i.test(p.info.siteLicense ?? '');
    const canEnum = c.search === true;
    const canDownload = c.download === true;
    let tier: MirrorTier;
    if (canEnum && canDownload && siteCc0) tier = 'FULL_MIRROR';
    else if (canEnum && canDownload) tier = 'PARTIAL_MIRROR';
    else if (canEnum && !canDownload) tier = 'METADATA_ONLY';
    else tier = 'MANUAL_ONLY';
    if (tier === 'MANUAL_ONLY' && !c.browserSearch) tier = 'UNSUPPORTED';
    out.push({
      providerId: p.info.id,
      displayName: p.info.displayName,
      tier,
      canEnumerate: canEnum,
      canDownload: canDownload && canEnum, // downloads require enumerable asset ids
      redistributableSiteWide: siteCc0,
      licenseDiscoverable: c.perAssetLicense === true || !!p.info.siteLicense,
      automationPermitted: canEnum,
      note: tier === 'FULL_MIRROR'
        ? 'site-wide redistributable license (CC0) — every asset mirrorable'
        : tier === 'PARTIAL_MIRROR'
          ? 'per-asset licenses — each asset gated on redistribution permission'
          : tier === 'METADATA_ONLY'
            ? 'discovery possible; automated redistribution not permitted — metadata catalog only'
            : tier === 'MANUAL_ONLY'
              ? 'no permitted automation — official page links only'
              : 'no reliable permitted integration',
    });
  }
  return out;
}

// ---------------------------------------------------------------- discovery

function toEntry(a: AssetRef, discoveredAt: string): MirrorEntry {
  return {
    ref: `${a.providerId}:${a.id}`,
    providerId: a.providerId,
    assetId: a.id,
    name: a.name,
    creator: a.creator,
    sourceUrl: a.assetUrl,
    previewUrl: a.previewUrl,
    license: {
      id: a.license.id,
      raw: a.license.raw,
      url: a.license.url,
      commercialUse: a.license.commercialUse,
      attributionRequired: a.license.attributionRequired,
      shareAlike: a.license.shareAlike,
      redistribution: a.license.redistribution,
      unknown: a.license.unknown,
      sourceConfirmed: a.license.sourceConfirmed,
    },
    category: categoryDir(a),
    formats: a.formats ?? [],
    polyCount: a.polyCount,
    textureResolution: a.textureResolution,
    tags: a.tags ?? [],
    kind: a.kind,
    state: 'DISCOVERED',
    attempts: 0,
    discoveredAt,
    updatedAt: discoveredAt,
  };
}

export interface DiscoverOpts {
  providers?: string[];
  maxPages?: number;
  perPage?: number;
}

export interface DiscoverResult {
  discovered: number;
  total: number;
  providers: { provider: string; found: number; error?: string }[];
  /** Refs the enumeration actually observed this run (used to detect removals). */
  seenRefs: Set<string>;
  /** Providers whose full listing succeeded this run (removals are only inferred for these). */
  enumeratedProviders: Set<string>;
}

export async function discover(hub: Hub, state: MirrorState, opts: DiscoverOpts = {}): Promise<DiscoverResult> {
  const cfg = hub.getConfig().mirror;
  const maxPages = opts.maxPages ?? cfg.maxPagesPerProvider;
  const perPage = opts.perPage ?? 100;
  const classifications = classifyProviders(hub);
  const tierById = new Map(classifications.map((c) => [c.providerId, c]));
  const targets = (opts.providers?.length
    ? opts.providers
    : classifications.filter((c) => c.canEnumerate).map((c) => c.providerId)
  ).filter((id) => {
    if (hub.isMockMode && id !== 'mock') return false;
    const t = tierById.get(id);
    if (!t) return false;
    if (!t.canEnumerate) {
      log.info('skip discovery: provider is not enumerable', { provider: id, tier: t.tier });
      return false;
    }
    return true;
  });

  const now = new Date().toISOString();
  const result: DiscoverResult = { discovered: 0, total: 0, providers: [], seenRefs: new Set(), enumeratedProviders: new Set() };
  for (const providerId of targets) {
    const p = hub.providers.get(providerId);
    if (!p) continue;
    const key = await hub.apiKeyFor(providerId);
    if (!p.isConfigured(key)) {
      result.providers.push({ provider: providerId, found: 0, error: 'AUTH_REQUIRED — add your API key (asset-hub key set)' });
      continue;
    }
    let found = 0;
    let err: string | undefined;
    try {
      for (let page = 1; page <= maxPages; page++) {
        const res: SearchPage = await p.search({ text: '', page, perPage }, key);
        if (res.error) throw new Error(res.error);
        for (const a of res.results) {
          const entry = toEntry(a, now);
          const prev = state.get(entry.ref);
          if (prev) {
            // keep progress; refresh mutable metadata (name/tags/license snapshot)
            state.upsert({
              ...entry,
              state: prev.state,
              attempts: prev.attempts,
              sha256: prev.sha256,
              sizeBytes: prev.sizeBytes,
              fileName: prev.fileName,
              mirrorPath: prev.mirrorPath,
              downloadedAt: prev.downloadedAt,
              previewStored: prev.previewStored,
              skipReason: prev.skipReason,
              duplicateOf: prev.duplicateOf,
              error: prev.error,
              licenseChanged: prev.license.id !== entry.license.id ? true : prev.licenseChanged,
              licensePrevious: prev.license.id !== entry.license.id ? prev.license.id : prev.licensePrevious,
              discoveredAt: prev.discoveredAt,
            });
          } else {
            state.upsert(entry);
            result.discovered++;
          }
          result.seenRefs.add(entry.ref);
          found++;
        }
        if (!res.hasMore) break;
      }
    } catch (e) {
      err = String((e as Error).message ?? e);
      log.warn('discovery failed for provider', { provider: providerId, error: err });
    }
    if (!err) result.enumeratedProviders.add(providerId);
    result.providers.push({ provider: providerId, found, error: err });
  }
  result.total = state.all().length;
  return result;
}

// ----------------------------------------------------------------- download

export interface DownloadOpts {
  providers?: string[];
  resume?: boolean;
  failed?: boolean;
  limit?: number;
  onEvent?: (ev: { ref: string; state: string; detail?: string }) => void;
  shouldAbort?: () => boolean;
}

export interface DownloadSummary {
  processed: number;
  completed: number;
  skipped: number;
  failed: number;
  duplicates: number;
  paused: { reason: string; at: string } | null;
  aborted: boolean;
}

const REDISTRIBUTABLE = (e: MirrorEntry) =>
  !e.license.unknown && e.license.redistribution === 'allowed';

export async function downloadAssets(hub: Hub, state: MirrorState, opts: DownloadOpts = {}): Promise<DownloadSummary> {
  const cfg = hub.getConfig().mirror;
  const repoRoot = state.repoRoot;
  const summary: DownloadSummary = { processed: 0, completed: 0, skipped: 0, failed: 0, duplicates: 0, paused: null, aborted: false };

  const capacityNow = await capacity(hub, state);
  if (capacityNow.paused) {
    state.setPaused('REPOSITORY_CAPACITY');
    await state.save();
    summary.paused = state.paused ?? null;
    return summary;
  }

  const candidates = state.all().filter((e) => {
    if (opts.providers?.length && !opts.providers.includes(e.providerId)) return false;
    if (['PROCESSED', 'COMMITTED', 'VERIFIED'].includes(e.state)) return false;
    if (e.state === 'FAILED') return opts.failed === true;
    if (e.state === 'SKIPPED') return false;
    return true; // DISCOVERED / LICENSE_VERIFIED / QUEUED / DOWNLOADING / DOWNLOADED
  });

  for (const entry of candidates) {
    if (opts.limit && summary.processed >= opts.limit) break;
    if (opts.shouldAbort?.()) {
      summary.aborted = true;
      await state.save();
      break;
    }
    summary.processed++;
    const outcome = await processEntry(hub, state, entry, cfg.maxFileBytes, cfg.storePreviews, opts.onEvent);
    switch (outcome) {
      case 'PROCESSED': summary.completed++; break;
      case 'SKIPPED': summary.skipped++; break;
      case 'DUPLICATE': summary.duplicates++; break;
      case 'FAILED': summary.failed++; break;
      default: break;
    }
    await state.save(); // durable after every entry (spec §6)
  }

  // pause re-check after new bytes arrived
  const after = await capacity(hub, state);
  if (after.paused) {
    state.setPaused('REPOSITORY_CAPACITY');
    summary.paused = state.paused ?? null;
  } else if (state.paused?.reason === 'REPOSITORY_CAPACITY') {
    state.setPaused(null); // capacity freed (e.g. limits raised)
  }
  await state.save();
  return summary;
}

export async function processEntry(
  hub: Hub,
  state: MirrorState,
  entry: MirrorEntry,
  maxFileBytes: number,
  storePreviews: boolean,
  onEvent?: DownloadOpts['onEvent'],
): Promise<'PROCESSED' | 'SKIPPED' | 'DUPLICATE' | 'FAILED' | string> {
  const emit = (s: string, detail?: string) => {
    entry.state = s as MirrorEntry['state'];
    onEvent?.({ ref: entry.ref, state: s, detail });
  };

  // ---- license + redistribution gates (spec §2) — never bypassed
  if (entry.license.unknown) {
    entry.skipReason = 'UNKNOWN_LICENSE';
    entry.error = 'license could not be verified from official data — mirroring refused';
    emit('SKIPPED', entry.error);
    return 'SKIPPED';
  }
  if (entry.license.redistribution !== 'allowed') {
    entry.skipReason = 'REDISTRIBUTION_NOT_PERMITTED';
    entry.error = `license ${entry.license.id} redistribution=${entry.license.redistribution} — metadata-only record kept`;
    emit('SKIPPED', entry.error);
    return 'SKIPPED';
  }

  // ---- fresh verification when the search license was not source-confirmed
  const provider = hub.providers.get(entry.providerId);
  if (!provider) {
    entry.skipReason = 'PROVIDER_UNAVAILABLE';
    entry.error = `provider ${entry.providerId} unavailable`;
    emit('SKIPPED', entry.error);
    return 'SKIPPED';
  }
  if (!entry.license.sourceConfirmed && provider.info.capabilities.perAssetLicense) {
    try {
      const key = await hub.apiKeyFor(entry.providerId);
      const lic = await provider.getLicense(entry.assetId, key);
      entry.license = {
        ...entry.license,
        id: lic.id, raw: lic.raw, url: lic.url,
        commercialUse: lic.commercialUse, attributionRequired: lic.attributionRequired,
        shareAlike: lic.shareAlike, redistribution: lic.redistribution, unknown: lic.unknown,
        sourceConfirmed: lic.sourceConfirmed,
      };
      if (lic.unknown || lic.redistribution !== 'allowed') {
        entry.skipReason = lic.unknown ? 'UNKNOWN_LICENSE' : 'REDISTRIBUTION_NOT_PERMITTED';
        entry.error = `license re-verification: ${lic.id} (redistribution=${lic.redistribution})`;
        emit('SKIPPED', entry.error);
        return 'SKIPPED';
      }
    } catch (e) {
      entry.attempts++;
      entry.error = `license verification failed: ${String((e as Error).message ?? e)}`;
      emit('FAILED', entry.error);
      return 'FAILED';
    }
  }
  emit('LICENSE_VERIFIED');

  // ---- duplicate gates
  const dupByUrl = state.all().find((o) => o.ref !== entry.ref && o.sourceUrl === entry.sourceUrl && (o.state === 'PROCESSED' || o.state === 'COMMITTED'));
  if (dupByUrl) {
    entry.skipReason = 'DUPLICATE';
    entry.duplicateOf = dupByUrl.ref;
    entry.error = `same source URL already mirrored as ${dupByUrl.ref}`;
    emit('SKIPPED', entry.error);
    return 'DUPLICATE';
  }

  // ---- download via the provider's official mechanism
  let options;
  try {
    const key = await hub.apiKeyFor(entry.providerId);
    options = await provider.getDownloadOptions(entry.assetId, key);
  } catch (e) {
    entry.attempts++;
    entry.error = String((e as Error).message ?? e);
    emit('FAILED', entry.error);
    return 'FAILED';
  }
  if (!options.length) {
    entry.skipReason = 'DOWNLOAD_UNAVAILABLE';
    entry.error = 'no permitted automated download option — official page recorded in catalog';
    emit('SKIPPED', entry.error);
    return 'SKIPPED';
  }
  // Option selection (live-API verified against Poly Haven's /files tree):
  // user-preferred formats first, then a sane rank that prefers complete,
  // engine-ready artifacts (glb/gltf/blend/fbx/zip/hdr) over loose texture
  // maps (a model's /files listing starts with its Diffuse 8k jpg). Within
  // the winning format the SMALLEST variant that fits the repository file
  // limit wins, so e.g. HDRIs mirror at 1k-2k instead of failing on 24k.
  const preferred = hub.getConfig().downloads.preferredFormats ?? [];
  const packageBytes = (o: DownloadOption): number =>
    (o.sizeBytes ?? 0) + (o.includes?.reduce((n, i) => n + (i.sizeBytes ?? 0), 0) ?? 0);
  const withinLimit = (o: DownloadOption): boolean => packageBytes(o) === 0 || packageBytes(o) <= maxFileBytes;
  const usable = options.filter(withinLimit);
  if (!usable.length) {
    const biggest = options.reduce((a, b) => (b.sizeBytes ?? 0) > (a.sizeBytes ?? 0) ? b : a);
    entry.skipReason = 'TOO_LARGE';
    entry.sizeBytes = biggest.sizeBytes ?? 0;
    entry.error = `all ${options.length} download option(s) exceed the ${maxFileBytes}-byte repository file limit (largest ${biggest.sizeBytes ?? '?'} bytes) — recorded in catalog, not mirrored`;
    emit('SKIPPED', entry.error);
    return 'SKIPPED';
  }
  const rank = [...preferred.map((f: string) => f.toLowerCase()), 'glb', 'gltf', 'blend', 'fbx', 'usdz', 'zip', 'mtlx', 'hdr', 'exr'];
  let option = usable[0];
  for (const f of rank) {
    const cands = usable.filter((o) => o.format.toLowerCase() === f).sort((a, b) => packageBytes(a) - packageBytes(b));
    if (cands.length) { option = cands[0]; break; }
  }
  const tmpDir = path.join(MirrorState.dir(state.repoRoot), 'tmp');
  await ensureDir(tmpDir);
  const ext = path.extname(new URL('http://x/' + encodeURIComponent(option.id)).pathname).toLowerCase() || `.${option.format || 'bin'}`;
  const tmpPath = path.join(tmpDir, slugify(entry.name, entry.ref) + ext);
  emit('DOWNLOADING');
  let result;
  try {
    result = await provider.download(option, {
      destDir: tmpDir,
      destPath: tmpPath,
      apiKey: await hub.apiKeyFor(entry.providerId),
      onProgress: undefined,
    });
  } catch (e) {
    result = { ok: false, bytes: 0, error: String((e as Error).message ?? e), errorCode: 'DOWNLOAD_FAILED' };
  }
  if (!result.ok || !result.path) {
    entry.attempts++;
    entry.error = result.error ?? 'download failed';
    emit('FAILED', entry.error);
    return 'FAILED';
  }
  emit('DOWNLOADED');

  // ---- integrity verification (spec §5 step 7)
  const sha = result.sha256 ?? (await sha256File(result.path).catch(() => undefined));
  const stat = await fsp.stat(result.path).catch(() => null);
  if (!sha || !stat) {
    entry.attempts++;
    entry.error = 'downloaded file unreadable — quarantined in mirror tmp dir';
    emit('FAILED', entry.error);
    return 'FAILED';
  }
  if (stat.size > maxFileBytes) {
    await fsp.rm(result.path, { force: true });
    entry.skipReason = 'TOO_LARGE';
    entry.error = `${stat.size} bytes exceeds the ${maxFileBytes}-byte repository file limit — recorded in catalog, not mirrored`;
    entry.sizeBytes = stat.size;
    emit('SKIPPED', entry.error);
    return 'SKIPPED';
  }
  emit('VERIFIED');

  // ---- sha deduplication across the whole mirror (spec §7)
  const dupBySha = state.all().find((o) => o.ref !== entry.ref && o.sha256 === sha && (o.state === 'PROCESSED' || o.state === 'COMMITTED'));
  if (dupBySha) {
    await fsp.rm(result.path, { force: true });
    entry.skipReason = 'DUPLICATE';
    entry.duplicateOf = dupBySha.ref;
    entry.sha256 = sha;
    entry.error = `byte-identical to ${dupBySha.ref} — source/license metadata preserved in catalog`;
    emit('SKIPPED', entry.error);
    return 'DUPLICATE';
  }

  // ---- organize into the repository (spec §8, §9, §21)
  const slug = slugify(entry.name, entry.ref);
  const assetDir = path.join(state.repoRoot, 'assets', entry.category, slug);
  const originalDir = path.join(assetDir, 'original');
  await ensureDir(originalDir);
  const fileName = path.basename(result.path);
  await fsp.rename(result.path, path.join(originalDir, fileName));

  entry.sha256 = sha;
  entry.fileName = fileName;
  if (!entry.downloadedAt) entry.downloadedAt = new Date().toISOString();
  entry.mirrorPath = path.relative(state.repoRoot, assetDir).split(path.sep).join('/');
  entry.files = [{ path: fileName, sha256: sha, sizeBytes: stat.size }];
  let totalBytes = stat.size;

  // Multi-file packages (live-API verified: Poly Haven gltf/mtlx/blend/fbx
  // variants ship as main file + `include` dependencies). Download each into
  // its relative location and hash it; a missing dependency would leave an
  // unusable stub, so any failure fails the whole asset (cleaned up).
  const key = await hub.apiKeyFor(entry.providerId);
  for (const inc of option.includes ?? []) {
    const rel = inc.path.split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
    if (!rel) continue;
    const incPath = path.join(originalDir, rel);
    await ensureDir(path.dirname(incPath));
    const incOption: DownloadOption = {
      id: `${option.id}::${rel}`, label: rel, format: path.extname(rel).replace('.', '') || 'bin',
      url: inc.url, sizeBytes: inc.sizeBytes, md5: inc.md5, licenseId: option.licenseId,
    };
    let incResult;
    try {
      incResult = await provider.download(incOption, { destDir: originalDir, destPath: incPath, apiKey: key });
    } catch (e) {
      incResult = { ok: false, bytes: 0, error: String((e as Error).message ?? e), errorCode: 'DOWNLOAD_FAILED' };
    }
    if (!incResult.ok || !incResult.path) {
      await fsp.rm(assetDir, { recursive: true, force: true });
      entry.mirrorPath = undefined;
      entry.files = undefined;
      entry.attempts++;
      entry.error = `required file ${rel} failed: ${incResult.error ?? 'download failed'}`;
      emit('FAILED', entry.error);
      return 'FAILED';
    }
    entry.files.push({ path: rel, sha256: incResult.sha256 ?? (await sha256File(incPath)), sizeBytes: (await fsp.stat(incPath)).size });
    totalBytes += entry.files[entry.files.length - 1].sizeBytes;
  }
  if (totalBytes > maxFileBytes) {
    await fsp.rm(assetDir, { recursive: true, force: true });
    entry.skipReason = 'TOO_LARGE';
    entry.sizeBytes = totalBytes;
    entry.mirrorPath = undefined;
    entry.files = undefined;
    entry.error = `${totalBytes} bytes (package total) exceeds the ${maxFileBytes}-byte repository file limit — recorded in catalog, not mirrored`;
    emit('SKIPPED', entry.error);
    return 'SKIPPED';
  }
  entry.sizeBytes = totalBytes;

  // preview only when its redistribution is clearly permitted (CC0/PD assets)
  entry.previewStored = false;
  if (storePreviews && entry.previewUrl && /^https?:/i.test(entry.previewUrl)
    && /^cc0|public domain/i.test(entry.license.id)) {
    try {
      const previewPath = path.join(assetDir, 'preview' + path.extname(new URL(entry.previewUrl).pathname || '.jpg').toLowerCase() || '.jpg');
      await hub.mirrorHttp.download({ url: entry.previewUrl, destPath: previewPath });
      entry.previewStored = fs.existsSync(previewPath);
    } catch {
      entry.previewStored = false; // preview is best-effort, never fatal
    }
  }

  await writeAssetJson(state.repoRoot, entry);
  emit('PROCESSED');
  return 'PROCESSED';
}

// ---------------------------------------------------------- per-asset metadata

export function mirrorAssetJson(e: MirrorEntry): Record<string, unknown> {
  return {
    id: e.ref,
    name: e.name,
    creator: e.creator ?? null,
    source: e.providerId,
    source_url: e.sourceUrl,
    license: e.license.id,
    license_url: e.license.url ?? null,
    license_raw: e.license.raw ?? null,
    redistribution_allowed: !e.license.unknown && e.license.redistribution === 'allowed',
    commercial_use: e.license.commercialUse === 'allowed',
    attribution_required: e.license.attributionRequired,
    share_alike: e.license.shareAlike,
    modification: e.license.unknown ? null : true,
    download_date: e.downloadedAt ?? e.updatedAt,
    sha256: e.sha256 ?? null,
    size_bytes: e.sizeBytes ?? null,
    formats: e.formats,
    category: e.category,
    kind: e.kind,
    tags: e.tags,
    polygon_count: e.polyCount ?? null,
    texture_resolution: e.textureResolution ?? null,
    duplicate_of: e.duplicateOf ?? null,
    preview: e.previewStored === true,
    file: e.fileName ? `original/${e.fileName}` : null,
    files: e.files?.map((f) => ({ path: `original/${f.path}`, sha256: f.sha256, size_bytes: f.sizeBytes })) ?? null,
  };
}

export async function writeAssetJson(repoRoot: string, e: MirrorEntry): Promise<void> {
  const file = path.join(repoRoot, e.mirrorPath ?? '', 'asset.json');
  await ensureDir(path.dirname(file));
  await atomicWriteFile(file, JSON.stringify(mirrorAssetJson(e), null, 2));
}

// ------------------------------------------------------------------- update

export interface UpdateResult {
  discovered: DiscoverResult;
  added: string[];
  removedRefs: string[];
  changedMetadata: string[];
  licenseChanges: { ref: string; from: string; to: string; action: string }[];
}

export async function updateMirror(hub: Hub, state: MirrorState, opts: DiscoverOpts = {}): Promise<UpdateResult> {
  const before = new Map(state.all().map((e) => [e.ref, e]));
  const discovered = await discover(hub, state, opts);
  const after = state.all();

  const res: UpdateResult = { discovered, added: [], removedRefs: [], changedMetadata: [], licenseChanges: [] };

  for (const e of after) {
    const prev = before.get(e.ref);
    if (!prev) {
      res.added.push(e.ref);
      continue;
    }
    if (prev.license.id !== e.license.id) {
      const redistributableNow = !e.license.unknown && e.license.redistribution === 'allowed';
      const wasMirrored = ['PROCESSED', 'COMMITTED'].includes(prev.state);
      let action: string;
      if (!redistributableNow) {
        action = 'LICENSE_CHANGED — redistribution no longer permitted; future mirroring stopped';
        if (wasMirrored) {
          e.skipReason = 'REDISTRIBUTION_REVOKED';
          e.state = 'SKIPPED';
          e.licenseChanged = true;
          e.licensePrevious = prev.license.id;
          await appendAudit(state.repoRoot, {
            event: 'LICENSE_REVOKED', ref: e.ref,
            from: prev.license.id, to: e.license.id,
            mirror_path: e.mirrorPath ?? null,
            remediation: 'asset-hub mirror remediate <ref> --remove  (history preserved unless you explicitly remove)',
          });
        }
      } else {
        action = `LICENSE_CHANGED ${prev.license.id} → ${e.license.id} (still redistributable)`;
        e.licenseChanged = true;
        e.licensePrevious = prev.license.id;
        if (wasMirrored) await writeAssetJson(state.repoRoot, e); // refresh metadata
      }
      res.licenseChanges.push({ ref: e.ref, from: prev.license.id, to: e.license.id, action });
    } else if (prev.name !== e.name || prev.category !== e.category) {
      res.changedMetadata.push(e.ref);
      if (['PROCESSED', 'COMMITTED'].includes(e.state)) await writeAssetJson(state.repoRoot, e);
    }
  }
  for (const [ref, e] of before) {
    // Only infer removal for providers whose full listing succeeded this run —
    // a filtered/failed enumeration must never look like a vanished source.
    if (discovered.enumeratedProviders.has(e.providerId) && !discovered.seenRefs.has(ref)) {
      // source no longer lists the asset: keep files, record removal
      state.upsert({ ...e, state: 'SKIPPED', skipReason: 'SOURCE_REMOVED', error: 'asset no longer listed by the source (historical mirror kept)', updatedAt: new Date().toISOString() });
      res.removedRefs.push(ref);
      await appendAudit(state.repoRoot, { event: 'SOURCE_REMOVED', ref });
    }
  }
  await state.save();
  return res;
}

// ------------------------------------------------------------------ audit log

export interface AuditEvent {
  event: string;
  ref?: string;
  ts?: string;
  [k: string]: unknown;
}

export async function appendAudit(repoRoot: string, ev: AuditEvent): Promise<void> {
  const file = path.join(repoRoot, 'mirror-audit.jsonl');
  const { ts: _ignored, ...rest } = ev;
  await fsp.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...rest }) + '\n');
}

// ------------------------------------------------------ indexes & registries

export interface GeneratedFiles {
  assetIndex: string;
  assetIndexJsonl: string;
  licensesJson: string;
  licensesMd: string;
  attributionsMd: string;
  attributionsTxt: string;
  indexes: string[];
}

export function mirroredEntries(state: MirrorState): MirrorEntry[] {
  return state.all().filter((e) => e.mirrorPath && ['PROCESSED', 'COMMITTED'].includes(e.state));
}

export async function regenerateRepoFiles(state: MirrorState): Promise<GeneratedFiles> {
  const repoRoot = state.repoRoot;
  const entries = mirroredEntries(state);
  // Day-granularity keeps regenerated files byte-stable across repeated commits
  // within a day — index churn creates pointless diffs in the mirror repo.
  const now = new Date().toISOString().slice(0, 10);

  const indexItems = entries.map((e) => ({
    id: e.ref,
    path: e.mirrorPath!,
    name: e.name,
    creator: e.creator ?? null,
    category: e.category,
    tags: e.tags,
    license: e.license.id,
    license_url: e.license.url ?? null,
    commercial_use: e.license.commercialUse === 'allowed',
    attribution_required: e.license.attributionRequired,
    formats: e.formats,
    file: e.fileName ? `${e.mirrorPath}/original/${e.fileName}` : null,
    sha256: e.sha256 ?? null,
    size_bytes: e.sizeBytes ?? null,
    polygon_count: e.polyCount ?? null,
    texture_resolution: e.textureResolution ?? null,
    source: e.providerId,
    source_url: e.sourceUrl,
    kind: e.kind,
    preview: e.previewStored === true,
    mirrored_at: e.downloadedAt ?? e.updatedAt,
  }));

  await ensureDir(path.join(repoRoot, 'indexes'));
  const byCategory = new Map<string, unknown[]>();
  for (const item of indexItems) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }
  const indexFiles: string[] = [];
  for (const [cat, items] of byCategory) {
    const f = path.join(repoRoot, 'indexes', `${cat}.json`);
    await atomicWriteFile(f, JSON.stringify({ category: cat, generated_at: now, count: items.length, assets: items }, null, 2));
    indexFiles.push(path.relative(repoRoot, f));
  }

  const indexPath = path.join(repoRoot, 'ASSET_INDEX.json');
  await atomicWriteFile(indexPath, JSON.stringify({ generated_at: now, count: indexItems.length, assets: indexItems }, null, 2));
  const jsonlPath = path.join(repoRoot, 'ASSET_INDEX.jsonl');
  await atomicWriteFile(jsonlPath, indexItems.map((i) => JSON.stringify(i)).join('\n') + (indexItems.length ? '\n' : ''));

  // licenses.json + LICENSES.md (per asset — never site-wide assumptions)
  const licRecords = Object.fromEntries(entries.map((e) => [e.ref, {
    license: e.license.id,
    license_url: e.license.url ?? null,
    redistribution_allowed: true,
    commercial_use: e.license.commercialUse === 'allowed',
    attribution_required: e.license.attributionRequired,
    share_alike: e.license.shareAlike,
    source: e.providerId,
    source_url: e.sourceUrl,
    path: e.mirrorPath,
  }]));
  const licJson = path.join(repoRoot, 'licenses.json');
  await atomicWriteFile(licJson, JSON.stringify({ generated_at: now, count: entries.length, assets: licRecords }, null, 2));

  const byLic = new Map<string, MirrorEntry[]>();
  for (const e of entries) {
    const list = byLic.get(e.license.id) ?? [];
    list.push(e);
    byLic.set(e.license.id, list);
  }
  const md = [
    '# Licenses — mirrored asset registry',
    '',
    `Generated by asset-hub on ${now}. Every record is tied to the individual asset's official license data.`,
    '',
    ...[...byLic.entries()].flatMap(([id, list]) => [
      `## ${id} (${list.length} asset${list.length === 1 ? '' : 's'})`,
      '',
      ...list.map((e) => `- \`${e.ref}\` — ${e.name}${e.creator ? ` by ${e.creator}` : ''} — ${e.mirrorPath}${e.license.attributionRequired ? ' — ⚠ attribution required' : ''}`),
      '',
    ]),
  ].join('\n');
  const licMd = path.join(repoRoot, 'LICENSES.md');
  await atomicWriteFile(licMd, md);

  // ATTRIBUTIONS.md/.txt (spec §11) — attribution-required assets, full detail
  const needAttr = entries.filter((e) => e.license.attributionRequired);
  const attrLines = (fmt: 'md' | 'txt') => needAttr.map((e) => fmt === 'md'
    ? [
      `### ${e.name}`,
      ``,
      `- **Asset:** ${e.name}`,
      `- **Asset ID:** ${e.ref}`,
      `- **Creator:** ${e.creator ?? 'unknown'}`,
      `- **Source:** ${e.providerId} (${e.sourceUrl})`,
      `- **License:** ${e.license.id}${e.license.url ? ` (${e.license.url})` : ''}`,
      `- **Required attribution:** "${e.name}" by ${e.creator ?? 'unknown'} — ${e.license.id} — ${e.sourceUrl}`,
      ``,
    ].join('\n')
    : [
      `Asset:      ${e.name}`,
      `AssetID:    ${e.ref}`,
      `Creator:    ${e.creator ?? 'unknown'}`,
      `Source:     ${e.providerId}`,
      `URL:        ${e.sourceUrl}`,
      `License:    ${e.license.id}`,
      `LicenseURL: ${e.license.url ?? 'n/a'}`,
      `Credit:     "${e.name}" by ${e.creator ?? 'unknown'} — ${e.license.id} — ${e.sourceUrl}`,
      ``,
    ].join('\n')).join('\n');

  const header = (fmt: 'md' | 'txt') => fmt === 'md'
    ? `# Attributions\n\nGenerated by asset-hub on ${now}. Assets whose licenses require attribution.\nCC0 assets are tracked in licenses.json regardless.\n\n${needAttr.length ? '' : '(no attribution-required assets mirrored yet)\n'}`
    : `ATTRIBUTIONS\n============\nGenerated by asset-hub on ${now}.\n${needAttr.length ? '' : '(no attribution-required assets mirrored yet)\n'}`;
  const attrMd = path.join(repoRoot, 'ATTRIBUTIONS.md');
  const attrTxt = path.join(repoRoot, 'ATTRIBUTIONS.txt');
  await atomicWriteFile(attrMd, header('md') + attrLines('md'));
  await atomicWriteFile(attrTxt, header('txt') + attrLines('txt'));

  return {
    assetIndex: 'ASSET_INDEX.json',
    assetIndexJsonl: 'ASSET_INDEX.jsonl',
    licensesJson: 'licenses.json',
    licensesMd: 'LICENSES.md',
    attributionsMd: 'ATTRIBUTIONS.md',
    attributionsTxt: 'ATTRIBUTIONS.txt',
    indexes: indexFiles,
  };
}

// ------------------------------------------------------------------ capacity

export interface CapacityReport {
  assets_discovered: number;
  assets_mirrorable: number;
  assets_mirrored: number;
  assets_skipped: number;
  assets_failed: number;
  assets_pending: number;
  repository_bytes: number;
  git_object_store_bytes: number;
  lfs_bytes: number;
  estimated_additional_bytes: number;
  warn_bytes: number;
  pause_bytes: number;
  paused: boolean;
  pause_reason: string | null;
}

async function walkBytes(dir: string, patterns: string[] = []): Promise<{ total: number; lfs: number }> {
  let total = 0;
  let lfs = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const st = await fsp.stat(full).catch(() => null);
        if (!st) continue;
        total += st.size;
        if (patterns.some((p) => e.name.toLowerCase().endsWith(p.replace(/\*/g, '').toLowerCase()))) lfs += st.size;
      }
    }
  };
  await walk(dir);
  return { total, lfs };
}

export async function capacity(hub: Hub, state: MirrorState): Promise<CapacityReport> {
  const cfg = hub.getConfig().mirror;
  const entries = state.all();
  const assetsDir = path.join(state.repoRoot, 'assets');
  const { total, lfs } = await walkBytes(assetsDir, cfg.lfsPatterns);
  const gitBytes = git.gitInfo(state.repoRoot).isRepo ? git.gitObjectStoreBytes(state.repoRoot) : 0;
  const mirrored = mirroredEntries(state);
  const mirrorable = entries.filter(REDISTRIBUTABLE);
  const pendingKnown = entries.filter((e) => REDISTRIBUTABLE(e) && !['PROCESSED', 'COMMITTED', 'SKIPPED', 'FAILED'].includes(e.state) && e.sizeBytes);
  const report: CapacityReport = {
    assets_discovered: entries.length,
    assets_mirrorable: mirrorable.length,
    assets_mirrored: mirrored.length,
    assets_skipped: entries.filter((e) => e.state === 'SKIPPED').length,
    assets_failed: entries.filter((e) => e.state === 'FAILED').length,
    assets_pending: entries.filter((e) => !['PROCESSED', 'COMMITTED', 'SKIPPED', 'FAILED'].includes(e.state)).length,
    repository_bytes: total,
    git_object_store_bytes: gitBytes,
    lfs_bytes: lfs,
    estimated_additional_bytes: pendingKnown.reduce((n, e) => n + (e.sizeBytes ?? 0), 0),
    warn_bytes: cfg.warnBytes,
    pause_bytes: cfg.pauseBytes,
    paused: total + gitBytes >= cfg.pauseBytes,
    pause_reason: total + gitBytes >= cfg.pauseBytes ? 'REPOSITORY_CAPACITY' : null,
  };
  return report;
}

// --------------------------------------------------------------------- audit

export interface AuditFinding {
  path: string;
  ref?: string;
  severity: 'WARNING' | 'ERROR';
  problem: string;
}

export async function auditMirror(state: MirrorState): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const byMirrorPath = new Map(state.all().filter((e) => e.mirrorPath).map((e) => [e.mirrorPath!, e]));
  const assetsRoot = path.join(state.repoRoot, 'assets');

  const walk = async (d: string): Promise<void> => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'original') {
          const assetDir = path.dirname(full);
          const rel = path.relative(state.repoRoot, assetDir).split(path.sep).join('/');
          const metaFile = path.join(assetDir, 'asset.json');
          if (!fs.existsSync(metaFile)) {
            findings.push({ path: rel, severity: 'ERROR', problem: 'asset.json metadata missing' });
            continue;
          }
          let meta: Record<string, unknown>;
          try {
            meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          } catch {
            findings.push({ path: rel, severity: 'ERROR', problem: 'asset.json is not valid JSON' });
            continue;
          }
          const entry = byMirrorPath.get(rel);
          const need = (label: string, field: string): void => {
            const v = meta[field];
            if (v === undefined || v === null || v === '') findings.push({ path: rel, ref: entry?.ref, severity: 'WARNING', problem: `${label} missing in asset.json` });
          };
          need('Source', 'source');
          need('Source URL', 'source_url');
          need('License', 'license');
          need('License URL', 'license_url');
          need('Integrity hash', 'sha256');
          if (meta.redistribution_allowed !== true) findings.push({ path: rel, ref: entry?.ref, severity: 'ERROR', problem: 'redistribution status is not confirmed — asset must not be mirrored' });
          if (meta.attribution_required === true) {
            const attrTxt = path.join(state.repoRoot, 'ATTRIBUTIONS.txt');
            if (!fs.existsSync(attrTxt) || !fs.readFileSync(attrTxt, 'utf8').includes(String(meta.id))) {
              findings.push({ path: rel, ref: entry?.ref, severity: 'ERROR', problem: 'attribution required but missing from ATTRIBUTIONS (run: asset-hub mirror commit)' });
            }
          }
          // integrity re-hash
          const origFiles = await fsp.readdir(full).catch(() => []);
          const main = meta.file ? path.join(assetDir, String(meta.file)) : (origFiles[0] ? path.join(full, origFiles[0]) : null);
          if (main && fs.existsSync(main) && typeof meta.sha256 === 'string' && meta.sha256.length === 64) {
            const actual = await sha256File(main).catch(() => null);
            if (actual && actual !== meta.sha256) findings.push({ path: rel, ref: entry?.ref, severity: 'ERROR', problem: `integrity mismatch: file hashes to ${actual.slice(0, 12)}… but asset.json records ${String(meta.sha256).slice(0, 12)}…` });
          }
        } else {
          await walk(full);
        }
      }
    }
  };
  await walk(assetsRoot);

  // state ↔ disk cross-check
  for (const e of mirroredEntries(state)) {
    const dir = path.join(state.repoRoot, e.mirrorPath!);
    if (!fs.existsSync(dir)) findings.push({ path: e.mirrorPath!, ref: e.ref, severity: 'ERROR', problem: 'catalog says mirrored but directory is missing' });
  }
  return findings;
}

// ---------------------------------------------------------------- remediation

export async function remediate(state: MirrorState, ref: string, opts: { remove: boolean }): Promise<{ removed: boolean; auditPath: string }> {
  const entry = state.get(ref);
  if (!entry) throw new Error(`unknown ref ${ref}`);
  let removed = false;
  if (opts.remove && entry.mirrorPath) {
    const dir = path.join(state.repoRoot, entry.mirrorPath);
    await fsp.rm(dir, { recursive: true, force: true });
    const catDir = path.dirname(dir);
    if ((await fsp.readdir(catDir).catch(() => [])).length === 0) await fsp.rm(catDir, { recursive: true, force: true }).catch(() => {});
    entry.mirrorPath = undefined;
    removed = true;
  }
  entry.state = 'SKIPPED';
  entry.skipReason = 'REMEDIATED';
  entry.error = 'removed/flagged by operator remediation after a license change';
  state.upsert(entry);
  await appendAudit(state.repoRoot, { event: 'REMEDIATED', ref, removed, previous_path: entry.mirrorPath ?? null, previous_license: entry.licensePrevious ?? entry.license.id });
  await state.save();
  return { removed, auditPath: 'mirror-audit.jsonl' };
}
