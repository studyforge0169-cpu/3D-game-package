/**
 * Poly Pizza connector — official API (https://api.poly.pizza, key required).
 *
 * Verified: free API key from poly.pizza/settings/api; documented docs page at
 * poly.pizza/api. Search returns per-model license (CC0 or CC-BY with creator
 * attribution required) and an official per-model `Download` GLB URL.
 * Hosts thousands of CC0/CC-BY low-poly models incl. Quaternius & Kenney
 * catalogs — which makes it the legal discovery surface for those brands too.
 */

import type {
  AssetRef, DownloadOption, LicenseInfo, PreviewImage, ProviderInfo,
  SearchPage, SearchQuery,
} from '../types';
import { BaseProvider, apiLicense } from './base';
import { sha256File } from '../util/hash';

const API = 'https://api.poly.pizza/v1.1';

interface PpSearchResponse {
  count?: number;
  results?: PpModel[];
  [k: string]: unknown;
}

interface PpModel {
  ID: string; id?: string;
  Title: string; title?: string;
  Creator?: { ID: string; Username: string; PURL?: string };
  Licence?: string; license?: string;
  Download?: string; download?: string;
  Thumbnail?: string; thumbnail?: string;
  TriCount?: number; tricount?: number;
  Animated?: boolean;
  Category?: { Name?: string }[] | string;
  Set?: string;
}

export class PolyPizzaProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'polypizza',
    displayName: 'Poly Pizza',
    homeUrl: 'https://poly.pizza',
    docsUrl: 'https://poly.pizza/api',
    legalNote: 'Official API with a free key (poly.pizza/settings/api). Per-model license CC0 or CC-BY (attribution required). Downloads are the official GLB links the API returns.',
    tier: 'full',
    capabilities: {
      search: true, download: true, perAssetLicense: true,
      browserSearch: true, urlImport: false, needsApiKey: true,
      apiKeyUrl: 'https://poly.pizza/settings/api',
      apiDocsUrl: 'https://poly.pizza/api', robotsScope: 'api',
    },
  };

  private headers(apiKey?: string): Record<string, string> {
    if (!apiKey) throw missingKey('Poly Pizza', 'https://poly.pizza/settings/api');
    return { 'X-API-Key': apiKey };
  }

  private toRef(m: PpModel): AssetRef {
    const id = String(m.ID ?? m.id ?? '');
    const licence = m.Licence ?? m.license ?? null;
    const license = apiLicense(licence);
    return {
      id,
      providerId: 'polypizza',
      name: String(m.Title ?? m.title ?? id),
      creator: m.Creator?.Username,
      kind: 'model',
      categoryHint: 'Props',
      previewUrl: m.Thumbnail ?? m.thumbnail,
      assetUrl: `https://poly.pizza/m/${id}`,
      license,
      free: true,
      polyCount: m.TriCount ?? m.tricount,
      formats: ['glb'],
      tags: typeof m.Category === 'string' ? [m.Category] : (m.Category ?? []).map((c) => c.Name ?? '').filter(Boolean),
      animated: !!m.Animated,
      raw: { set: m.Set ?? undefined },
    };
  }


  override assetIdFromUrl(url: string): string | null {
    const m = /poly\.pizza\/m\/([^/?#]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async search(query: SearchQuery, apiKey?: string): Promise<SearchPage> {
    const params = new URLSearchParams({
      q: query.text ?? '',
      limit: String(Math.min(query.perPage ?? 24, 40)),
    });
    if (query.page && query.page > 1) params.set('offset', String((query.page - 1) * (query.perPage ?? 24)));
    const data = await this.http.getJson<PpSearchResponse | PpModel[]>(`${API}/search?${params}`, { headers: this.headers(apiKey) });
    const models = Array.isArray(data) ? data : (data.results ?? []);
    let results = models.map((m) => this.toRef(m));
    const f = query.filters;
    if (f?.cc0Only) results = results.filter((r) => r.license.id === 'CC0-1.0');
    if (f?.commercialOnly) results = results.filter((r) => r.license.commercialUse === 'allowed');
    if (f?.noAttributionOnly) results = results.filter((r) => !r.license.attributionRequired);
    if (f?.licenses?.length) results = results.filter((r) => f.licenses!.includes(r.license.id));
    if (f?.animatedOnly) results = results.filter((r) => !!r.animated);
    return { providerId: 'polypizza', results, page: query.page ?? 1, hasMore: models.length >= (query.perPage ?? 24) };
  }

  async getAsset(id: string, apiKey?: string): Promise<AssetRef | null> {
    const data = await this.http.getJson<PpSearchResponse>(`${API}/model/${encodeURIComponent(id)}`, { headers: this.headers(apiKey) }).catch(() => null);
    const m = data?.results?.[0] ?? (data as unknown as PpModel | null);
    return m ? this.toRef(m) : null;
  }

  async getLicense(id: string, apiKey?: string): Promise<LicenseInfo> {
    const a = await this.getAsset(id, apiKey);
    return a?.license ?? apiLicense(null);
  }

  async getDownloadOptions(id: string, apiKey?: string): Promise<DownloadOption[]> {
    const a = await this.getAsset(id, apiKey);
    const dl = a?.raw?.download as string | undefined;
    if (!dl) {
      // Re-query via search by id is not possible; use asset page fallback.
      return [{
        id: `pp:${id}:page`,
        label: 'Open official model page',
        format: 'glb',
        url: `https://poly.pizza/m/${id}`,
        requiresAuth: false,
        licenseId: a?.license.id ?? 'unknown',
      }];
    }
    return [{
      id: `pp:${id}:glb`,
      label: 'GLB (official link)',
      format: 'glb',
      url: String(dl),
      licenseId: a?.license.id ?? 'unknown',
    }];
  }

  async getMetadata(id: string, apiKey?: string): Promise<Record<string, unknown>> {
    return this.http.getJson(`${API}/model/${encodeURIComponent(id)}`, { headers: this.headers(apiKey) });
  }

  async download(option: DownloadOption, ctx: import('../types').ProviderRuntimeCtx): Promise<import('../types').DownloadResult> {
    if (!option.url.startsWith('http') || option.url.includes('poly.pizza/m/')) {
      return { ok: false, bytes: 0, errorCode: 'MANUAL', error: 'Open the official model page to obtain the file manually.' };
    }
    const res = await this.http.download({
      url: option.url,
      destPath: ctx.destPath,
      onProgress: ctx.onProgress,
      signal: ctx.signal,
      headers: ctx.apiKey ? { 'X-API-Key': ctx.apiKey } : {},
      timeoutMs: 120_000,
    });
    const sha = await sha256File(ctx.destPath);
    return { ok: true, path: ctx.destPath, bytes: res.bytes, sha256: sha };
  }

  async getPreviewUrls(id: string, apiKey?: string): Promise<PreviewImage[]> {
    const a = await this.getAsset(id, apiKey).catch(() => null);
    return a?.previewUrl ? [{ url: a.previewUrl }] : [];
  }

  buildSearchUrl(query: SearchQuery): string {
    return `https://poly.pizza/search?q=${encodeURIComponent(query.text ?? '')}`;
  }
}

export function missingKey(source: string, url: string): Error {
  const e = new Error(`${source} requires your own API key. Get a free one at ${url} and add it in Settings → API Keys.`);
  (e as Error & { code?: string }).code = 'API_KEY_REQUIRED';
  return e;
}
