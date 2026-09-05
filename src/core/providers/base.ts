/**
 * Provider base + shared helpers (spec §13).
 * Every source is its own connector; there is no generic scraper here.
 */

import type {
  AssetProvider, AssetRef, DownloadOption, HttpClientLike, LicenseInfo, PreviewImage,
  ProviderInfo, SearchPage, SearchQuery,
} from '../types';
import { normalizeLicense, resolveDefinition } from '../licenses/registry';

export abstract class BaseProvider implements AssetProvider {
  abstract readonly info: ProviderInfo;

  constructor(protected readonly http: HttpClientLike) {}

  isConfigured(apiKey?: string): boolean {
    return !this.info.capabilities.needsApiKey || !!apiKey;
  }

  abstract search(query: SearchQuery, apiKey?: string): Promise<SearchPage>;
  abstract getAsset(id: string, apiKey?: string): Promise<AssetRef | null>;
  abstract getLicense(id: string, apiKey?: string): Promise<LicenseInfo>;
  abstract getDownloadOptions(id: string, apiKey?: string): Promise<DownloadOption[]>;
  abstract getMetadata(id: string, apiKey?: string): Promise<Record<string, unknown>>;
  abstract download(option: DownloadOption, ctx: import('../types').ProviderRuntimeCtx): Promise<import('../types').DownloadResult>;
  abstract getPreviewUrls(id: string, apiKey?: string): Promise<PreviewImage[]>;
  abstract buildSearchUrl(query: SearchQuery): string;
}

/** Shared license helper for site-wide-CC0 providers (Poly Haven, AmbientCG…). */
export function siteWideLicense(raw: string): LicenseInfo {
  return normalizeLicense({ raw, sourceConfirmed: true });
}

/** License for providers where the API serves an exact per-asset license string. */
export function apiLicense(raw: string | null | undefined, licenseUrl?: string | null): LicenseInfo {
  return normalizeLicense({ raw: raw ?? undefined, licenseUrl: licenseUrl ?? undefined, sourceConfirmed: !!raw || !!licenseUrl });
}

export function licenseIdOf(raw: string | null | undefined): string {
  return resolveDefinition(raw ?? undefined).id;
}

/** Text-match scoring used to emulate relevance for providers without a q= param. */
export function textScore(haystack: string[], needle: string): number {
  const n = needle.toLowerCase().split(/\s+/).filter(Boolean);
  if (!n.length) return 0;
  let score = 0;
  const name = haystack[0]?.toLowerCase() ?? '';
  for (const term of n) {
    if (name === term) score += 10;
    else if (name.startsWith(term)) score += 6;
    else if (name.includes(term)) score += 3;
    for (const other of haystack.slice(1)) {
      if (other.toLowerCase().includes(term)) score += 1;
    }
  }
  return score;
}

export function manualSearchPage(provider: ProviderInfo, query: SearchQuery, searchUrl: string): SearchPage {
  return {
    providerId: provider.id,
    results: [],
    page: query.page ?? 1,
    manualOnly: true,
    searchUrl,
  };
}

export const MANUAL_FALLBACK_MESSAGE =
  'Automated access is unavailable for this source. Open the official asset page to obtain it manually.';
