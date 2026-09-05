/**
 * Poly Haven connector — official public API (https://api.polyhaven.com).
 *
 * Verified: the API is free for everyone including commercial use; they ask
 * for a descriptive User-Agent (our HttpClient sends one). All assets are
 * CC0. `/assets` lists the catalog; `/files/{id}` returns official
 * dl.polyhaven.org URLs with sizes and md5 checksums — we verify md5 after
 * download. This mirrors exactly how Poly Haven's own official add-on works
 * (catalog fetch + local filtering), which keeps request volume tiny.
 */

import type {
  AssetKind, AssetRef, DownloadOption, LicenseInfo, PreviewImage, ProviderInfo,
  SearchPage, SearchQuery, SearchFilters, SortKey,
} from '../types';
import { BaseProvider, siteWideLicense, textScore } from './base';
import { LICENSE_REGISTRY } from '../licenses/registry';
import { sha256File, md5File } from '../util/hash';

const API = 'https://api.polyhaven.com';
const CATALOG_TTL = 60 * 60 * 1000; // 1h — the catalog barely changes

interface PhAsset {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  thumbnail_url?: string;
  max_resolution?: number[];
  download_count?: number;
  authors?: Record<string, string>;
  date_published?: number;
  dimensions?: number[];
  polycount?: number;
  lods?: boolean;
  type: number; // 0 HDRI, 1 texture, 2 model
}

export class PolyHavenProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'polyhaven',
    displayName: 'Poly Haven',
    homeUrl: 'https://polyhaven.com',
    docsUrl: 'https://polyhaven.com/our-api',
    legalNote: 'Official public API, free incl. commercial use. All assets CC0 — no attribution required. MD5 checksums verified after download.',
    siteLicense: 'CC0',
    tier: 'full',
    capabilities: {
      search: true, download: true, perAssetLicense: true,
      browserSearch: true, urlImport: false, needsApiKey: false,
      apiDocsUrl: 'https://polyhaven.com/our-api', robotsScope: 'api',
    },
  };

  private cache = new Map<string, Map<string, PhAsset>>(); // kind → id → asset

  private kindToType(kind: AssetKind | 'all'): string {
    switch (kind) {
      case 'model': return 'models';
      case 'hdri': return 'hdris';
      case 'texture': case 'material': return 'textures';
      default: return 'all';
    }
  }

  private async catalog(kind: AssetKind | 'all'): Promise<Map<string, PhAsset>> {
    const t = this.kindToType(kind);
    if (this.cache.has(t)) return this.cache.get(t)!;
    const data = await this.http.getJson<Record<string, PhAsset>>(`${API}/assets?t=${t === 'all' ? 'all' : t}`);
    const map = new Map<string, PhAsset>(Object.entries(data));
    this.cache.set(t, map);
    return map;
  }

  private toRef(id: string, a: PhAsset): AssetRef {
    const kind: AssetKind = a.type === 0 ? 'hdri' : a.type === 1 ? 'texture' : 'model';
    return {
      id,
      providerId: 'polyhaven',
      name: a.name ?? id,
      creator: Object.keys(a.authors ?? {}).join(', ') || undefined,
      description: a.description,
      kind,
      categoryHint: kind === 'hdri' ? 'HDRIs' : kind === 'texture' ? 'Textures' : undefined,
      previewUrl: a.thumbnail_url,
      assetUrl: `https://polyhaven.com/a/${id}`,
      license: siteWideLicense('CC0'),
      free: true,
      polyCount: a.polycount,
      textureResolution: a.max_resolution?.[0],
      formats: kind === 'hdri' ? ['hdr', 'exr'] : kind === 'texture' ? ['jpg', 'zip'] : ['blend', 'gltf', 'fbx', 'usdc'],
      fileSize: undefined,
      tags: a.tags ?? [],
      createdAt: a.date_published ? new Date(a.date_published * 1000).toISOString() : undefined,
      downloads: a.download_count,
      pbr: kind !== 'hdri',
      raw: { type: a.type },
    };
  }

  async search(query: SearchQuery): Promise<SearchPage> {
    const filters = query.filters;
    const kinds: (AssetKind | 'all')[] = filters?.kind
      ? [filters.kind]
      : [['model', 'hdri', 'texture'] as AssetKind[]].flat().filter(Boolean) as (AssetKind | 'all')[];
    const wanted = filters?.kind ? [filters.kind] : (['model', 'hdri', 'texture'] as AssetKind[]);
    const results: AssetRef[] = [];
    for (const k of wanted) {
      const cat = await this.catalog(k).catch(() => new Map<string, PhAsset>());
      for (const [id, a] of cat) results.push(this.toRef(id, a));
    }
    // Local filtering (same technique as the official Poly Haven add-on).
    let filtered = results;
    if (query.text) {
      filtered = filtered
        .map((r) => ({ r, s: textScore([r.name, ...(r.tags ?? []), r.description ?? ''], query.text) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.r);
    }
    filtered = applyFilters(filtered, filters);
    filtered = applySort(filtered, query.sort ?? 'relevance');
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 48;
    const slice = filtered.slice((page - 1) * perPage, page * perPage);
    return { providerId: 'polyhaven', results: slice, total: filtered.length, page, hasMore: page * perPage < filtered.length };
  }

  async getAsset(id: string): Promise<AssetRef | null> {
    for (const k of ['model', 'hdri', 'texture'] as AssetKind[]) {
      try {
        const cat = await this.catalog(k);
        const a = cat.get(id);
        if (a) return this.toRef(id, a);
      } catch { /* try next */ }
    }
    return null;
  }

  async getLicense(): Promise<LicenseInfo> {
    return siteWideLicense('CC0');
  }

  async getDownloadOptions(id: string): Promise<DownloadOption[]> {
    const files = await this.http.getJson<Record<string, any>>(`${API}/files/${encodeURIComponent(id)}`);
    // /files returns a nested tree (e.g. hdri → resolution → format → {url,size,md5},
    // blend → {url,size,md5}, gltf → ...). Flatten to leaves with official URLs.
    const options: DownloadOption[] = [];
    const walk = (node: any, path: string[]): void => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.url === 'string' && typeof node.size === 'number') {
        const leaf = path[path.length - 1];
        const format = ['hdr', 'exr', 'zip', 'jpg', 'ktx2', 'blend', 'gltf', 'fbx', 'usdc'].includes(leaf)
          ? (leaf === 'usdc' ? 'usdz' : leaf) : 'zip';
        options.push(this.option(id, path.join(' · '), format, node));
        return;
      }
      for (const [k, child] of Object.entries(node)) walk(child, [...path, k]);
    };
    walk(files, []);
    return options;
  }

  private option(id: string, label: string, format: string, meta: { url: string; size?: number; md5?: string }): DownloadOption {
    return {
      id: `ph:${id}:${label}`,
      label,
      format,
      sizeBytes: meta.size,
      url: meta.url,
      md5: meta.md5,
      licenseId: 'CC0-1.0',
    };
  }

  async getMetadata(id: string): Promise<Record<string, unknown>> {
    return this.http.getJson(`${API}/files/${encodeURIComponent(id)}`);
  }

  async download(option: DownloadOption, ctx: import('../types').ProviderRuntimeCtx): Promise<import('../types').DownloadResult> {
    const res = await this.http.download({
      url: option.url,
      destPath: ctx.destPath,
      onProgress: ctx.onProgress,
      signal: ctx.signal,
      timeoutMs: 120_000,
    });
    const sha = await sha256File(ctx.destPath);
    let md5: string | undefined;
    if (option.md5) {
      md5 = await md5File(ctx.destPath);
      if (md5 !== option.md5) {
        return { ok: false, path: ctx.destPath, bytes: res.bytes, sha256: sha, md5, errorCode: 'HASH_MISMATCH', error: 'md5 mismatch — file corrupted, will retry' };
      }
    }
    return { ok: true, path: ctx.destPath, bytes: res.bytes, sha256: sha, md5 };
  }

  async getPreviewUrls(id: string): Promise<PreviewImage[]> {
    const a = await this.getAsset(id);
    return a?.previewUrl ? [{ url: a.previewUrl }, { url: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=512` }] : [];
  }

  buildSearchUrl(query: SearchQuery): string {
    const params = new URLSearchParams();
    if (query.text) params.set('q', query.text);
    if (query.filters?.kind === 'hdri') return `https://polyhaven.com/hdris${params.size ? '?' + params : ''}`;
    if (query.filters?.kind === 'texture') return `https://polyhaven.com/textures${params.size ? '?' + params : ''}`;
    return `https://polyhaven.com/models${params.size ? '?' + params : ''}`;
  }
}

/** Shared post-filtering for providers that filter locally. */
export function applyFilters(list: AssetRef[], f?: SearchFilters): AssetRef[] {
  if (!f) return list;
  let out = list;
  if (f.freeOnly) out = out.filter((r) => r.free);
  if (f.cc0Only) out = out.filter((r) => r.license.id === 'CC0-1.0');
  if (f.commercialOnly) out = out.filter((r) => r.license.commercialUse === 'allowed');
  if (f.noAttributionOnly) out = out.filter((r) => !r.license.attributionRequired);
  if (f.licenses?.length) out = out.filter((r) => f.licenses!.includes(r.license.id));
  if (f.kind) out = out.filter((r) => r.kind === f.kind);
  if (f.category) out = out.filter((r) => r.categoryHint === f.category);
  if (f.formats?.length) out = out.filter((r) => r.formats.some((x) => f.formats!.includes(x)));
  if (f.minPolyCount !== undefined) out = out.filter((r) => (r.polyCount ?? 0) >= f.minPolyCount!);
  if (f.maxPolyCount !== undefined) out = out.filter((r) => (r.polyCount ?? Infinity) <= f.maxPolyCount!);
  if (f.minTextureResolution !== undefined) out = out.filter((r) => (r.textureResolution ?? 0) >= f.minTextureResolution!);
  if (f.pbrOnly) out = out.filter((r) => !!r.pbr);
  if (riggerFilter(f)) out = out.filter((r) => !!r.rigged);
  if (f.animatedOnly) out = out.filter((r) => !!r.animated);
  if (f.maxFileSize !== undefined) out = out.filter((r) => (r.fileSize ?? 0) <= f.maxFileSize!);
  if (f.topics?.length) {
    out = out.filter((r) => {
      const hay = `${r.name} ${(r.tags ?? []).join(' ')} ${r.description ?? ''}`.toLowerCase();
      return f.topics!.some((t) => hay.includes(t.toLowerCase()));
    });
  }
  return out;
}
function riggerFilter(f: SearchFilters): boolean { return !!f.riggedOnly; }

export function applySort(list: AssetRef[], sort: SortKey): AssetRef[] {
  const out = [...list];
  switch (sort) {
    case 'popularity': out.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0)); break;
    case 'quality': out.sort((a, b) => ((b.likes ?? b.downloads ?? 0) / 100 + (b.polyCount ? 1 : 0)) - ((a.likes ?? a.downloads ?? 0) / 100 + (a.polyCount ? 1 : 0))); break;
    case 'polygons': out.sort((a, b) => (a.polyCount ?? Infinity) - (b.polyCount ?? Infinity)); break;
    case 'textureResolution': out.sort((a, b) => (b.textureResolution ?? 0) - (a.textureResolution ?? 0)); break;
    case 'fileSize': out.sort((a, b) => (a.fileSize ?? Infinity) - (b.fileSize ?? Infinity)); break;
    case 'newest': out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')); break;
    default: break; // relevance = provider order
  }
  return out;
}
