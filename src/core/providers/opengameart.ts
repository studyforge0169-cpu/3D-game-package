/**
 * OpenGameArt connector — HYBRID (spec §13 fallback path).
 *
 * Verified against https://opengameart.org/robots.txt:
 *   User-agent: *  Crawl-delay: 10
 *   Disallow: /search/  and  /?q=search/
 * → UGAH NEVER requests search pages. Search opens in the user's browser.
 *
 * Importing a single asset is allowed: content pages (/content/…) are not
 * disallowed. `importFromUrl(url)` fetches ONE page the user pasted, after a
 * robots.txt check and honoring Crawl-delay (rate limiter default 12 s), then
 * extracts title/author/preview and the per-asset license from the page's
 * Creative Commons/GPL license links. The file itself is downloaded by the
 * user in their own browser session; UGAH's Local Import wizard registers it.
 */

import type {
  AssetRef, DownloadOption, LicenseInfo, PreviewImage, ProviderInfo,
  SearchPage, SearchQuery,
} from '../types';
import { BaseProvider, manualSearchPage, MANUAL_FALLBACK_MESSAGE } from './base';
import { apiLicense } from './base';

const HOME = 'https://opengameart.org';

export class OpenGameArtProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'opengameart',
    displayName: 'OpenGameArt.org',
    homeUrl: HOME,
    legalNote: 'No public search API; robots.txt disallows crawling /search/ (Crawl-delay 10s). Search opens in your browser. Single-asset import reads one robots-permitted /content/ page you paste, honoring crawl-delay.',
    tier: 'hybrid',
    capabilities: {
      search: false, download: false, perAssetLicense: true,
      browserSearch: true, urlImport: true, needsApiKey: false,
      robotsScope: 'html',
    },
  };


  override assetIdFromUrl(url: string): string | null {
    return url.includes('opengameart.org') ? `oga:${url}` : null;
  }

  async search(query: SearchQuery): Promise<SearchPage> {
    return manualSearchPage(this.info, query, this.buildSearchUrl(query));
  }

  buildSearchUrl(query: SearchQuery): string {
    const params = new URLSearchParams();
    if (query.text) params.set('keys', query.text);
    if (query.filters?.kind === 'audio') params.set('field_art_type_tid[0]', '9'); // OGA audio term-ish
    return `${HOME}/art-search-advanced?${params}`;
  }

  /** Paste a /content/<name> URL → structured asset info incl. real license. */
  async importFromUrl(url: string): Promise<AssetRef> {
    const u = new URL(url);
    if (u.host !== 'opengameart.org' && u.host !== 'www.opengameart.org') {
      throw new Error('Not an OpenGameArt URL');
    }
    if (!u.pathname.startsWith('/content/')) {
      throw new Error('Please paste an asset page URL (https://opengameart.org/content/…). Search pages are excluded by the site’s robots.txt.');
    }
    // HttpClient applies robots guard + crawl-delay rate limiting for HTML.
    const html = await this.http.getText(url, { robots: true, timeoutMs: 20_000 });
    return this.parseContentPage(url, html);
  }

  parseContentPage(url: string, html: string): AssetRef {
    const pick = (re: RegExp): string | undefined => html.match(re)?.[1]?.trim();
    const title = pick(/<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/)
      ?? pick(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)
      ?? decodeEntities(pick(/<title>(.*?)<\/title>/) ?? 'OpenGameArt asset');
    const description = decodeEntities(pick(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/) ?? undefined);
    const image = pick(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
    const author = pick(/<a[^>]+href="https?:\/\/opengameart\.org\/users\/([^"\/]+)"/) ?? 'unknown';
    // License: OGA pages link the exact CC/GPL deed, e.g.
    // creativecommons.org/licenses/by/3.0/ or gnu.org/licenses/gpl-2.0.html
    const licenseUrl =
      pick(/https?:\/\/creativecommons\.org\/licenses\/[a-z\-]+\/[\d.]+/i)
      ?? pick(/https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0/i)
      ?? pick(/https?:\/\/(?:www\.)?gnu\.org\/licenses\/gpl-[\d.]+(?:\.[a-z]+)?/i);
    const license = apiLicense(licenseUrl ? null : undefined, licenseUrl ?? undefined);
    if (!licenseUrl && license.unknown) {
      // fall back: page text often says e.g. "CC-BY-SA 3.0"
      const textual = pick(/\b(CC[- ]?(?:BY(?:[- ]?(?:SA|NC|ND))?)[ -]?\d\.\d)\b/i);
      if (textual) return this.ref(url, title || 'OpenGameArt asset', author || 'unknown', description, image, apiLicense(textual));
    }
    return this.ref(url, title || 'OpenGameArt asset', author || 'unknown', description, image, license);
  }

  private ref(url: string, title: string, author: string, description: string | undefined, image: string | undefined, license: LicenseInfo): AssetRef {
    return {
      id: `oga:${url}`,
      providerId: 'opengameart',
      name: title,
      creator: author,
      description,
      kind: 'model',
      previewUrl: image,
      assetUrl: url,
      license,
      free: true,
      formats: [],
      tags: [],
    };
  }

  // -- AssetProvider interface (manual semantics) --------------------------

  async getAsset(id: string): Promise<AssetRef | null> {
    if (!id.startsWith('oga:')) return null;
    try { return await this.importFromUrl(id.slice(4)); } catch { return null; }
  }
  async getLicense(id: string): Promise<LicenseInfo> {
    const a = await this.getAsset(id);
    return a?.license ?? apiLicense(null);
  }
  async getDownloadOptions(): Promise<DownloadOption[]> {
    return [];
  }
  async getMetadata(id: string): Promise<Record<string, unknown>> {
    const a = await this.getAsset(id);
    return a ? (a as unknown as Record<string, unknown>) : {};
  }
  async download(): Promise<import('../types').DownloadResult> {
    return { ok: false, bytes: 0, errorCode: 'MANUAL', error: MANUAL_FALLBACK_MESSAGE };
  }
  async getPreviewUrls(id: string): Promise<PreviewImage[]> {
    const a = await this.getAsset(id).catch(() => null);
    return a?.previewUrl ? [{ url: a.previewUrl }] : [];
  }
}

function decodeEntities(s: string | undefined): string | undefined {
  if (!s) return s;
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}
