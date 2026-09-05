/**
 * Sketchfab connector — official Data API v3 (https://api.sketchfab.com/v3).
 *
 * Verified:
 *  - `GET /v3/search?type=models&q=&downloadable=true` is public (no key),
 *    paginated (count ≤ 24), and returns per-model license objects
 *    (`license: { slug, label, uri, fullName }`) and stats.
 *  - Downloads exist ONLY for models the uploader marked downloadable, and go
 *    through the official `GET /v3/models/{uid}/download` endpoint, which
 *    REQUIRES the user's own API token (Account → Settings → API). We never
 *    touch non-downloadable models, never replay sessions, never scrape.
 *  - Paid/store models are simply not downloadable via this endpoint; the UI
 *    opens the official page for them instead.
 */

import type {
  AssetRef, DownloadOption, LicenseInfo, PreviewImage, ProviderInfo,
  SearchPage, SearchQuery, SearchFilters,
} from '../types';
import { BaseProvider, apiLicense } from './base';
import { sha256File } from '../util/hash';

const API = 'https://api.sketchfab.com/v3';

interface SfSearchResponse {
  results?: SfModel[];
  next?: string | null;
  previous?: string | null;
  totalCount?: number;
  cursor?: string | null;
}

interface SfModel {
  uid: string;
  name: string;
  description?: string;
  viewerUrl: string;
  user: { username: string; displayName?: string; profileUrl?: string };
  license?: { slug?: string; label?: string; uri?: string; fullName?: string };
  isDownloadable?: boolean;
  isPrivate?: boolean;
  price?: string | null;
  archives?: { glb?: SfArchive; usdz?: SfArchive; [k: string]: SfArchive | undefined };
  faceCount?: number;
  vertexCount?: number;
  animationCount?: number;
  rigged?: boolean;
  viewerAndGameReady?: number;
  tags?: { name: string }[];
  categories?: { name: string; slug: string }[];
  thumbnails?: { images?: { url: string; width: number; height: number }[] };
  createdAt?: string;
  likeCount?: number;
  viewCount?: number;
  downloadCount?: number;
  staffpicked?: boolean;
}

interface SfArchive { osArchiveFormat?: string; size?: number }

interface SfDownloadResponse {
  glb?: { url: string; size?: number; expires?: number };
  gltf?: { url: string; size?: number };
  usdz?: { url: string; size?: number };
  original?: { url: string; size?: number; format?: string };
  [k: string]: unknown;
}

export class SketchfabProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'sketchfab',
    displayName: 'Sketchfab',
    homeUrl: 'https://sketchfab.com',
    docsUrl: 'https://docs.sketchfab.com/data-api/v3/',
    legalNote: 'Official Data API v3. Search is public; downloads only for models marked downloadable, via the official download endpoint with YOUR API token. Per-model licenses (CC0/CC-BY/…/Sketchfab Standard) shown per asset.',
    tier: 'full',
    capabilities: {
      search: true, download: true, perAssetLicense: true,
      browserSearch: true, urlImport: false, needsApiKey: false,
      apiKeyUrl: 'https://sketchfab.com/settings/password',
      apiDocsUrl: 'https://docs.sketchfab.com/data-api/v3/', robotsScope: 'api',
    },
  };

  private toRef(m: SfModel): AssetRef {
    const license = apiLicense(m.license?.slug ?? m.license?.fullName ?? null, m.license?.uri ?? null);
    return {
      id: m.uid,
      providerId: 'sketchfab',
      name: m.name,
      creator: m.user?.displayName || m.user?.username,
      description: m.description?.slice(0, 500),
      kind: 'model',
      categoryHint: categoryHint(m),
      previewUrl: m.thumbnails?.images?.slice(-1)?.[0]?.url,
      assetUrl: m.viewerUrl ?? `https://sketchfab.com/3d-models/${m.uid}`,
      license,
      free: m.isDownloadable !== false && !m.price,
      price: m.price ?? undefined,
      polyCount: m.faceCount,
      formats: m.archives?.glb ? ['glb'] : m.isDownloadable ? ['glb', 'original'] : [],
      tags: (m.tags ?? []).map((t) => t.name),
      createdAt: m.createdAt,
      downloads: m.downloadCount,
      views: m.viewCount,
      likes: m.likeCount,
      animated: (m.animationCount ?? 0) > 0,
      rigged: !!m.rigged,
      pbr: !!m.viewerAndGameReady,
    };
  }

  async search(query: SearchQuery, apiKey?: string): Promise<SearchPage> {
    const f: SearchFilters = query.filters ?? {};
    const params = new URLSearchParams({
      type: 'models',
      q: query.text ?? '',
      count: String(Math.min(query.perPage ?? 24, 24)),
    });
    if (query.page && query.page > 1) params.set('page', String(query.page));
    // Only request downloadable models when the user intends to download.
    if (f.freeOnly !== false) params.set('downloadable', 'true');
    switch (query.sort) {
      case 'newest': params.set('sort_by', '-createdAt'); break;
      case 'popularity': params.set('sort_by', '-viewCount'); break;
      case 'quality': params.set('sort_by', '-likeCount'); break;
      case 'relevance': default: break;
    }
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Token ${apiKey}`;
    const data = await this.http.getJson<SfSearchResponse>(`${API}/search?${params}`, { headers });
    let results = (data.results ?? []).filter((m) => !m.isPrivate).map((m) => this.toRef(m));
    // License/format/attribute filters applied locally (API params vary).
    if (f.cc0Only) results = results.filter((r) => r.license.id === 'CC0-1.0');
    if (f.commercialOnly) results = results.filter((r) => r.license.commercialUse === 'allowed');
    if (f.noAttributionOnly) results = results.filter((r) => !r.license.attributionRequired);
    if (f.licenses?.length) results = results.filter((r) => f.licenses!.includes(r.license.id));
    if (f.animatedOnly) results = results.filter((r) => !!r.animated);
    if (f.riggedOnly) results = results.filter((r) => !!r.rigged);
    if (f.maxPolyCount !== undefined) results = results.filter((r) => (r.polyCount ?? 0) <= f.maxPolyCount!);
    if (f.pbrOnly) results = results.filter((r) => !!r.pbr);
    return {
      providerId: 'sketchfab',
      results,
      total: data.totalCount,
      page: query.page ?? 1,
      hasMore: !!data.next || !!(data.results ?? []).length,
    };
  }

  async getAsset(id: string, apiKey?: string): Promise<AssetRef | null> {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Token ${apiKey}`;
    const m = await this.http.getJson<SfModel>(`${API}/models/${encodeURIComponent(id)}`, { headers });
    return this.toRef(m);
  }

  async getLicense(id: string, apiKey?: string): Promise<LicenseInfo> {
    const a = await this.getAsset(id, apiKey);
    return a?.license ?? apiLicense(null);
  }

  /** Official download endpoint — requires the user's own token. */
  async getDownloadOptions(id: string, apiKey?: string): Promise<DownloadOption[]> {
    if (!apiKey) {
      // Without a token we only offer the browser flow.
      const asset = await this.getAsset(id).catch(() => null);
      if (asset && asset.free) {
        return [{
          id: `sf:${id}:browser`,
          label: 'Open official download page (login required)',
          format: 'glb',
          url: `https://sketchfab.com/3d-models/${id}`,
          requiresAuth: true,
          licenseId: asset.license.id,
        }];
      }
      return [];
    }
    const dl = await this.http.getJson<SfDownloadResponse>(`${API}/models/${encodeURIComponent(id)}/download`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    const out: DownloadOption[] = [];
    if (dl.glb?.url) out.push(this.opt(id, 'GLB (game-ready)', 'glb', dl.glb.url, dl.glb.size));
    if (dl.gltf?.url) out.push(this.opt(id, 'glTF', 'gltf', dl.gltf.url, dl.gltf.size));
    if (dl.usdz?.url) out.push(this.opt(id, 'USDZ', 'usdz', dl.usdz.url, dl.usdz.size));
    if (dl.original?.url) out.push(this.opt(id, `Original${dl.original.format ? ' (' + dl.original.format + ')' : ''}`, 'original', dl.original.url, dl.original.size));
    return out;
  }

  private opt(id: string, label: string, format: string, url: string, size?: number): DownloadOption {
    return { id: `sf:${id}:${format}`, label, format, sizeBytes: size, url, requiresAuth: !!url.includes('sketchfab'), licenseId: '' };
  }

  async getMetadata(id: string, apiKey?: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Token ${apiKey}`;
    return this.http.getJson(`${API}/models/${encodeURIComponent(id)}`, { headers });
  }

  async download(option: DownloadOption, ctx: import('../types').ProviderRuntimeCtx): Promise<import('../types').DownloadResult> {
    if (option.requiresAuth && !ctx.apiKey) {
      return {
        ok: false, bytes: 0, errorCode: 'AUTH_REQUIRED',
        error: 'Downloading from Sketchfab requires your own API token (Settings → API keys). Add it in Settings, or open the official page and download manually.',
      };
    }
    // Resolve the fresh signed URL through the official endpoint.
    let url = option.url;
    if (option.url.startsWith('https://api.sketchfab.com/') || option.format !== 'glb') {
      const dl = await this.http.getJson<SfDownloadResponse>(
        `${API}/models/${encodeURIComponent(option.id.split(':')[1])}/download`,
        { headers: { Authorization: `Token ${ctx.apiKey}` } },
      );
      const key = option.format === 'gltf' ? 'gltf' : option.format === 'usdz' ? 'usdz' : option.format === 'original' ? 'original' : 'glb';
      const picked = (dl as Record<string, { url?: string }>)[key] ?? dl.glb;
      if (!picked?.url) return { ok: false, bytes: 0, errorCode: 'UNAVAILABLE', error: 'The source did not grant a download for this model with your token.' };
      url = picked.url;
    }
    const res = await this.http.download({ url, destPath: ctx.destPath, onProgress: ctx.onProgress, signal: ctx.signal, timeoutMs: 180_000 });
    const sha = await sha256File(ctx.destPath);
    return { ok: true, path: ctx.destPath, bytes: res.bytes, sha256: sha };
  }

  async getPreviewUrls(id: string): Promise<PreviewImage[]> {
    const a = await this.getAsset(id).catch(() => null);
    return a?.previewUrl ? [{ url: a.previewUrl }] : [];
  }

  buildSearchUrl(query: SearchQuery): string {
    const params = new URLSearchParams();
    if (query.text) params.set('q', query.text);
    params.set('features', 'downloadable');
    return `https://sketchfab.com/search?${params}`;
  }
}

function categoryHint(m: SfModel): AssetCategoryHint | undefined {
  const cats = (m.categories ?? []).map((c) => c.slug);
  const name = m.name.toLowerCase();
  if (cats.includes('animals-pets') || cats.includes('creatures')) return 'Creatures';
  if (cats.includes('characters')) return name.includes('weapon') || name.includes('sword') ? 'Weapons' : 'Characters';
  if (cats.includes('cars-vehicles')) return 'Vehicles';
  if (cats.includes('architecture')) return 'Buildings';
  if (cats.includes('nature-plants')) return 'Vegetation';
  if (name.includes('weapon') || name.includes('sword') || name.includes('rifle')) return 'Weapons';
  return undefined;
}
type AssetCategoryHint = 'Characters' | 'Creatures' | 'Weapons' | 'Vehicles' | 'Buildings' | 'Vegetation';
