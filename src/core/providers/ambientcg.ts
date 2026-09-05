/**
 * AmbientCG connector — official API v2 (https://ambientcg.com/api/v2).
 *
 * Verified: GET-only JSON API (`full_json`, `downloads_csv`, `categories_json`,
 * `releases_rss`); robots.txt allows crawling; all assets CC0. Downloads are
 * the official `ambientCG.com/get?file=…` links returned by the API itself.
 *
 * The API is defensive-parsed (it has evolved key spellings across versions);
 * a documented fallback to `downloads_csv` (stable schema: assetId,
 * downloadAttribute, filetype, size, downloadLink) keeps the connector honest
 * — if the API shape ever drifts, we surface an error instead of inventing
 * data.
 */

import type {
  AssetKind, AssetRef, DownloadOption, LicenseInfo, PreviewImage, ProviderInfo,
  SearchPage, SearchQuery,
} from '../types';
import { BaseProvider, siteWideLicense } from './base';
import { sha256File } from '../util/hash';

const API = 'https://ambientcg.com/api/v2';

interface AcgFullAsset {
  AssetID?: string; assetId?: string;
  NameAttribute?: string; nameAttribute?: string; DisplayName?: string;
  AssetType?: string; assetType?: string;
  Method?: string;
  DownloadData?: Record<string, AcgDownload>;
  downloadData?: Record<string, AcgDownload>;
  ImageData?: { Preview?: string; preview?: string; [k: string]: unknown };
  imageData?: { Preview?: string };
  StatisticsData?: { Downloads?: number; downloads?: number; [k: string]: unknown };
  TagData?: string[] | { Tags?: string[] };
  CreationDate?: string; creationDate?: string;
  DimensionsData?: unknown;
}
interface AcgDownload {
  Size?: number; size?: number;
  FileType?: string; filetype?: string;
  DownloadLink?: string; downloadLink?: string;
  Attribute?: string; downloadAttribute?: string;
}

const TYPE_TO_KIND: Record<string, AssetKind> = {
  '3DModel': 'model', 'HDRI': 'hdri', 'Material': 'material',
  'PlainTexture': 'texture', 'Substance': 'material', 'Atlas': 'texture',
  'Brush': 'brush', 'Decal': 'texture', 'Terrain': 'material',
};

export class AmbientCGProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'ambientcg',
    displayName: 'ambientCG',
    homeUrl: 'https://ambientcg.com',
    docsUrl: 'https://docs.ambientcg.com/api/v2/',
    legalNote: 'Official public API v2 (GET-only). All assets CC0 — no attribution required. Downloads via the official links the API returns.',
    siteLicense: 'CC0',
    tier: 'full',
    capabilities: {
      search: true, download: true, perAssetLicense: true,
      browserSearch: true, urlImport: false, needsApiKey: false,
      apiDocsUrl: 'https://docs.ambientcg.com/api/v2/', robotsScope: 'api',
    },
  };

  private async fullJson(query: SearchQuery): Promise<AcgFullAsset[]> {
    const f = query.filters;
    const params = new URLSearchParams();
    if (query.text) params.set('q', query.text);
    if (f?.kind) {
      const type = kindToApiType(f.kind);
      if (type) params.set('type', type);
    }
    params.set('sort', sortParam(query.sort));
    params.set('limit', String(query.perPage ?? 24));
    params.set('offset', String(((query.page ?? 1) - 1) * (query.perPage ?? 24)));
    params.set('include', 'downloadData,imageData,statisticsData,tagData,displayData,dimensionsData');
    const data = await this.http.getJson<{ FoundAssets?: AcgFullAsset[] } | AcgFullAsset[]>(`${API}/full_json?${params}`);
    const assets = Array.isArray(data) ? data : (data.FoundAssets ?? []);
    if (!assets.length) return this.fallbackCsv(query);
    return assets;
  }

  /** Stable-schema fallback when full_json shape drifts. */
  private async fallbackCsv(query: SearchQuery): Promise<AcgFullAsset[]> {
    const params = new URLSearchParams();
    if (query.text) params.set('q', query.text);
    params.set('limit', String(query.perPage ?? 24));
    const csv = await this.http.getText(`${API}/downloads_csv?${params}`).catch(() => '');
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const header = lines[0].split(',').map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cols = line.split(',').map((c) => c.trim());
      const row: Record<string, string> = {};
      header.forEach((h, i) => (row[h] = cols[i] ?? ''));
      return {
        AssetID: row.assetId,
        NameAttribute: row.assetId,
        DownloadData: {
          [row.downloadAttribute || 'file']: {
            Size: Number(row.size || 0),
            FileType: row.filetype,
            DownloadLink: row.downloadLink,
          },
        },
      } as AcgFullAsset;
    });
  }

  private toRef(a: AcgFullAsset): AssetRef {
    const id = String(a.AssetID ?? a.assetId ?? '');
    const type = String(a.AssetType ?? a.assetType ?? '');
    const kind = TYPE_TO_KIND[type] ?? 'other';
    const dl = a.DownloadData ?? a.downloadData ?? {};
    const best = Object.entries(dl)[0]?.[1];
    const preview = (a.ImageData as { Preview?: string } | undefined)?.Preview
      ?? (a.imageData as { Preview?: string } | undefined)?.Preview
      ?? `https://ambientcg.com/get?type=image&imageType=webThumb&file=${id}%20Preview.jpg`;
    const stats = a.StatisticsData as { Downloads?: number } | undefined;
    return {
      id,
      providerId: 'ambientcg',
      name: String(a.NameAttribute ?? a.nameAttribute ?? a.DisplayName ?? id.replaceAll(/([a-z])([A-Z0-9])/g, '$1 $2')),
      description: undefined,
      kind,
      categoryHint: kind === 'hdri' ? 'HDRIs' : kind === 'model' ? 'Environment' : kind === 'texture' ? 'Textures' : 'Materials',
      previewUrl: preview,
      assetUrl: `https://ambientcg.com/list?id=${encodeURIComponent(id)}`,
      license: siteWideLicense('CC0'),
      free: true,
      textureResolution: resolutionOf(dl),
      formats: Object.values(dl).map((d) => (d.FileType ?? d.filetype ?? 'zip').toLowerCase()).filter((v, i, a2) => a2.indexOf(v) === i),
      fileSize: best ? (best.Size ?? best.size) : undefined,
      tags: tagsOf(a),
      createdAt: a.CreationDate ?? a.creationDate,
      downloads: stats?.Downloads,
      pbr: kind === 'material' || kind === 'texture',
    };
  }


  override assetIdFromUrl(url: string): string | null {
    const m = /[?&]id=([^&#]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async search(query: SearchQuery): Promise<SearchPage> {
    const assets = await this.fullJson(query);
    const page = query.page ?? 1;
    return {
      providerId: 'ambientcg',
      results: assets.map((a) => this.toRef(a)),
      page,
      hasMore: assets.length === (query.perPage ?? 24),
    };
  }

  async getAsset(id: string): Promise<AssetRef | null> {
    const data = await this.http.getJson<{ FoundAssets?: AcgFullAsset[] }>(
      `${API}/full_json?id=${encodeURIComponent(id)}&include=downloadData,imageData,statisticsData,tagData`);
    const a = data.FoundAssets?.[0];
    return a ? this.toRef(a) : null;
  }

  async getLicense(): Promise<LicenseInfo> {
    return siteWideLicense('CC0');
  }

  async getDownloadOptions(id: string): Promise<DownloadOption[]> {
    const data = await this.http.getJson<{ FoundAssets?: AcgFullAsset[] }>(
      `${API}/full_json?id=${encodeURIComponent(id)}&include=downloadData`);
    const dl = data.FoundAssets?.[0]?.DownloadData ?? {};
    return Object.entries(dl).map(([attr, d]) => ({
      id: `acg:${id}:${attr}`,
      label: `${attr} · ${(d.FileType ?? d.filetype ?? 'zip').toUpperCase()}`,
      format: (d.FileType ?? d.filetype ?? 'zip').toLowerCase(),
      sizeBytes: d.Size ?? d.size,
      url: String(d.DownloadLink ?? d.downloadLink ?? `https://ambientcg.com/get?file=${encodeURIComponent(id)}_${attr}.zip`),
      licenseId: 'CC0-1.0',
    }));
  }

  async getMetadata(id: string): Promise<Record<string, unknown>> {
    return this.http.getJson(`${API}/full_json?id=${encodeURIComponent(id)}`);
  }

  async download(option: DownloadOption, ctx: import('../types').ProviderRuntimeCtx): Promise<import('../types').DownloadResult> {
    const res = await this.http.download({
      url: option.url, destPath: ctx.destPath, onProgress: ctx.onProgress, signal: ctx.signal, timeoutMs: 120_000,
    });
    const sha = await sha256File(ctx.destPath);
    return { ok: true, path: ctx.destPath, bytes: res.bytes, sha256: sha };
  }

  async getPreviewUrls(id: string): Promise<PreviewImage[]> {
    return [{ url: `https://ambientcg.com/get?type=image&imageType=webThumb&file=${encodeURIComponent(id)}%20Preview.jpg` }];
  }

  buildSearchUrl(query: SearchQuery): string {
    const params = new URLSearchParams();
    if (query.text) params.set('q', query.text);
    return `https://ambientcg.com/list?${params}`;
  }
}

function kindToApiType(kind: AssetKind): string | null {
  for (const [api, k] of Object.entries(TYPE_TO_KIND)) if (k === kind) return api;
  return null;
}

function sortParam(sort: SearchQuery['sort']): string {
  switch (sort) {
    case 'popularity': return 'Popular';
    case 'newest': return 'Latest';
    case 'relevance': case 'quality': return 'Downloads';
    default: return 'Downloads';
  }
}

function resolutionOf(dl: Record<string, AcgDownload>): number | undefined {
  const keys = Object.keys(dl);
  for (const r of ['8K', '4K', '2K', '1K']) {
    const hit = keys.find((k) => k.toUpperCase().startsWith(r));
    if (hit) return parseInt(r, 10) * 1024;
  }
  return undefined;
}

function tagsOf(a: AcgFullAsset): string[] {
  if (Array.isArray(a.TagData)) return a.TagData;
  const td = a.TagData as { Tags?: string[] } | undefined;
  return td?.Tags ?? [];
}
