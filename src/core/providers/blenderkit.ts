/**
 * BlenderKit connector — official API v1 (https://www.blenderkit.com/api/v1).
 *
 * Verified: documented REST API that powers the official Blender add-on.
 *  - `GET /api/v1/search/?query=&asset_type=&page=` is public (no key).
 *  - Search results include per-asset `license` ("cc0" or "royalty_free"),
 *    author info, and per-file `downloadUrl`s.
 *  - Actual file downloads require the user's own API key (free BlenderKit
 *    account, shown on their profile page). We send it in the documented
 *    `Api-Key` header (with a `Token` fallback), never scrape, never touch
 *    private/premium assets beyond opening their official pages.
 */

import type {
  AssetKind, AssetRef, DownloadOption, LicenseInfo, PreviewImage, ProviderInfo,
  SearchPage, SearchQuery,
} from '../types';
import { BaseProvider, apiLicense } from './base';
import { sha256File } from '../util/hash';

const API = 'https://www.blenderkit.com/api/v1';

interface BkSearchResponse { results?: BkAsset[]; count?: number; next?: string | null; previous?: string | null }
interface BkAsset {
  id: number; uuid: string; assetBaseId: string;
  name: string; description?: string;
  assetType?: string;
  category?: string; tags?: { name: string }[];
  license?: string; isFree?: string | boolean;
  author?: { firstName?: string; lastName?: string; fullName?: string; aboutMe?: string };
  thumbnail?: string; thumbnailLarge?: string; thumbnailMiddle?: string;
  files?: { fileType?: string; downloadUrl?: string; resolution?: string; fileThumbnail?: string }[];
  downloadCount?: number; likeCount?: number; viewCount?: number;
  faceCount?: number; faceCountInteger?: number;
  animated?: boolean; rigged?: number | boolean; pbr?: boolean;
  created?: string; updated?: string;
  isPrivate?: boolean;
}

const ASSET_TYPE_TO_KIND: Record<string, AssetKind> = {
  model: 'model', material: 'material', scene: 'scene', hdr: 'hdri', brush: 'brush',
};

export class BlenderKitProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'blenderkit',
    displayName: 'BlenderKit',
    homeUrl: 'https://www.blenderkit.com',
    docsUrl: 'https://www.blenderkit.com/api/v1/docs/',
    legalNote: 'Official API used by their Blender add-on. Search is public; downloads need your free BlenderKit API key (Profile page). Per-asset license: CC0 or BlenderKit royalty-free (conditions).',
    tier: 'full',
    capabilities: {
      search: true, download: true, perAssetLicense: true,
      browserSearch: true, urlImport: false, needsApiKey: false,
      apiKeyUrl: 'https://www.blenderkit.com/prefs/',
      apiDocsUrl: 'https://www.blenderkit.com/api/v1/docs/', robotsScope: 'api',
    },
  };

  private headers(apiKey?: string): Record<string, string> {
    return apiKey ? { 'Api-Key': apiKey } : {};
  }

  private toRef(a: BkAsset): AssetRef {
    const license = apiLicense(a.license ?? null);
    const kind = ASSET_TYPE_TO_KIND[a.assetType ?? 'model'] ?? 'model';
    const isFree = a.isFree === 'true' || a.isFree === true || a.license === 'cc0';
    const author = a.author?.fullName ?? [a.author?.firstName, a.author?.lastName].filter(Boolean).join(' ');
    return {
      id: a.uuid || String(a.id),
      providerId: 'blenderkit',
      name: a.name,
      creator: author || undefined,
      description: a.description?.slice(0, 500),
      kind,
      previewUrl: a.thumbnailMiddle ?? a.thumbnailLarge ?? a.thumbnail,
      assetUrl: `https://www.blenderkit.com/asset-kit-detail/${a.assetBaseId}/`,
      license,
      free: isFree,
      price: isFree ? undefined : 'BlenderKit plan',
      polyCount: a.faceCountInteger ?? a.faceCount,
      formats: a.files?.some((f) => f.fileType === 'blend') ? ['blend'] : [],
      fileSize: undefined,
      tags: (a.tags ?? []).map((t) => t.name).slice(0, 20),
      createdAt: a.created,
      downloads: a.downloadCount,
      views: a.viewCount,
      likes: a.likeCount,
      animated: a.animated,
      rigged: !!a.rigged,
      pbr: kind === 'material' ? true : a.pbr,
      raw: { assetBaseId: a.assetBaseId, id: a.id, files: a.files },
    };
  }

  async search(query: SearchQuery): Promise<SearchPage> {
    const params = new URLSearchParams({
      query: query.text ?? '',
      asset_type: query.filters?.kind && ASSET_TYPE_TO_KIND[query.filters.kind] ? query.filters.kind === 'hdri' ? 'hdr' : query.filters.kind : 'model',
    });
    params.set('page_size', String(Math.min(query.perPage ?? 24, 24)));
    if (query.page && query.page > 1) params.set('page', String(query.page));
    switch (query.sort) {
      case 'newest': params.set('ordering', '-created'); break;
      case 'popularity': params.set('ordering', '-downloadCount'); break;
      case 'quality': params.set('ordering', '-likeCount'); break;
      default: break;
    }
    const f = query.filters;
    if (f?.freeOnly) params.set('is_free', 'true');
    const data = await this.http.getJson<BkSearchResponse>(`${API}/search/?${params}`);
    let results = (data.results ?? []).filter((a) => !a.isPrivate).map((a) => this.toRef(a));
    if (f?.cc0Only) results = results.filter((r) => r.license.id === 'CC0-1.0');
    if (f?.commercialOnly) results = results.filter((r) => r.license.commercialUse === 'allowed');
    if (f?.noAttributionOnly) results = results.filter((r) => !r.license.attributionRequired);
    if (f?.licenses?.length) results = results.filter((r) => f.licenses!.includes(r.license.id));
    if (f?.riggedOnly) results = results.filter((r) => !!r.rigged);
    return {
      providerId: 'blenderkit',
      results,
      page: query.page ?? 1,
      hasMore: !!data.next,
    };
  }

  async getAsset(id: string): Promise<AssetRef | null> {
    // Search by uuid is supported by the public API.
    const data = await this.http.getJson<BkSearchResponse>(`${API}/search/?uuid=${encodeURIComponent(id)}`);
    const a = data.results?.[0];
    return a ? this.toRef(a) : null;
  }

  async getLicense(id: string): Promise<LicenseInfo> {
    const a = await this.getAsset(id);
    return a?.license ?? apiLicense(null);
  }

  async getDownloadOptions(id: string, apiKey?: string): Promise<DownloadOption[]> {
    const a = await this.getAsset(id);
    const files = (a?.raw?.files as BkAsset['files']) ?? [];
    if (!files.length) return [];
    return files.filter((f) => f.downloadUrl).map((f) => ({
      id: `bk:${id}:${f.fileType ?? 'file'}`,
      label: f.resolution ? `${f.fileType ?? 'file'} ${f.resolution}` : (f.fileType ?? 'blend'),
      format: (f.fileType ?? 'blend').toLowerCase(),
      url: f.downloadUrl!,
      requiresAuth: true, // file fetch needs the user's key
      licenseId: a?.license.id ?? 'unknown',
    }));
  }

  async getMetadata(id: string): Promise<Record<string, unknown>> {
    return this.http.getJson(`${API}/search/?uuid=${encodeURIComponent(id)}`);
  }

  async download(option: DownloadOption, ctx: import('../types').ProviderRuntimeCtx): Promise<import('../types').DownloadResult> {
    if (!ctx.apiKey) {
      return {
        ok: false, bytes: 0, errorCode: 'AUTH_REQUIRED',
        error: 'BlenderKit downloads require your free API key (https://www.blenderkit.com/prefs/ → Profile). Add it in Settings, or open the official page and download there.',
      };
    }
    // Official documented auth header; fall back to Token scheme once.
    let res;
    try {
      res = await this.http.download({
        url: option.url, destPath: ctx.destPath, onProgress: ctx.onProgress, signal: ctx.signal,
        headers: { 'Api-Key': ctx.apiKey }, timeoutMs: 180_000,
      });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes('401') || msg.includes('Access denied')) {
        res = await this.http.download({
          url: option.url, destPath: ctx.destPath, onProgress: ctx.onProgress, signal: ctx.signal,
          headers: { Authorization: `Token ${ctx.apiKey}` }, timeoutMs: 180_000,
        });
      } else throw e;
    }
    const sha = await sha256File(ctx.destPath);
    return { ok: true, path: ctx.destPath, bytes: res.bytes, sha256: sha };
  }

  async getPreviewUrls(id: string): Promise<PreviewImage[]> {
    const a = await this.getAsset(id);
    return a?.previewUrl ? [{ url: a.previewUrl }] : [];
  }

  buildSearchUrl(query: SearchQuery): string {
    return `https://www.blenderkit.com/asset-search?query=${encodeURIComponent(query.text ?? '')}`;
  }
}
