/**
 * Manual-tier connectors (spec §2/§13/§17).
 *
 * These sources have no public API, and/or their terms prohibit automated
 * access (see docs/SOURCE_COMPATIBILITY_MATRIX.md for the per-site evidence).
 * UGAH therefore implements the sanctioned workflow:
 *
 *   Search (in their browser) → official page → user downloads manually
 *   → Local Import wizard registers the file with full license metadata.
 *
 * No scraping, no invented endpoints, no simulated results.
 */

import type {
  AssetRef, DownloadOption, LicenseInfo, PreviewImage, ProviderInfo,
  SearchPage, SearchQuery,
} from '../types';
import { BaseProvider, manualSearchPage, MANUAL_FALLBACK_MESSAGE } from './base';
import { normalizeLicense } from '../licenses/registry';

export interface ManualSourceSpec {
  id: string;
  displayName: string;
  homeUrl: string;
  searchUrlTemplate: string; // {q} replaced
  legalNote: string;
  /** Blanket site license when one exists (pre-fills the import wizard). */
  siteLicense?: string;
  licenseNote: string;
  apiNote?: string;
}

export class ManualProvider extends BaseProvider {
  readonly info: ProviderInfo;
  constructor(private readonly spec: ManualSourceSpec, http: import('../types').HttpClientLike) {
    super(http);
    this.info = {
      id: spec.id,
      displayName: spec.displayName,
      homeUrl: spec.homeUrl,
      legalNote: spec.legalNote,
      siteLicense: spec.siteLicense,
      tier: 'manual',
      capabilities: {
        search: false,
        download: false,
        perAssetLicense: !!spec.siteLicense,
        browserSearch: true,
        urlImport: false,
        needsApiKey: false,
        robotsScope: 'html',
      },
    };
  }

  /** Default license used by the Local Import wizard for this source. */
  siteLicenseInfo(): LicenseInfo | null {
    return this.spec.siteLicense
      ? normalizeLicense({ raw: this.spec.siteLicense, sourceConfirmed: true })
      : null;
  }

  override isConfigured(): boolean { return true; }

  async search(query: SearchQuery): Promise<SearchPage> {
    return manualSearchPage(this.info, query, this.buildSearchUrl(query));
  }

  buildSearchUrl(query: SearchQuery): string {
    return this.spec.searchUrlTemplate.replace('{q}', encodeURIComponent(query.text ?? ''));
  }

  async getAsset(): Promise<AssetRef | null> { return null; }
  async getLicense(): Promise<LicenseInfo> {
    return this.siteLicenseInfo() ?? normalizeLicense({ raw: undefined, sourceConfirmed: false });
  }
  async getDownloadOptions(): Promise<DownloadOption[]> { return []; }
  async getMetadata(): Promise<Record<string, unknown>> { return { note: this.spec.apiNote ?? 'No public API' }; }
  async download(): Promise<import('../types').DownloadResult> {
    return { ok: false, bytes: 0, errorCode: 'MANUAL', error: MANUAL_FALLBACK_MESSAGE };
  }
  async getPreviewUrls(): Promise<PreviewImage[]> { return []; }
}

// ---------------------------------------------------------------- spec table

export const MANUAL_SOURCES: ManualSourceSpec[] = [
  {
    id: 'kenney',
    displayName: 'Kenney',
    homeUrl: 'https://kenney.nl/assets',
    searchUrlTemplate: 'https://kenney.nl/assets?q={q}&sort=update',
    legalNote: 'No public API. All assets are CC0 (public domain) — no attribution required. Download packs from the official site; the Local Import wizard pre-fills CC0.',
    siteLicense: 'CC0',
    licenseNote: 'Everything CC0, including commercial use.',
  },
  {
    id: 'quaternius',
    displayName: 'Quaternius',
    homeUrl: 'https://quaternius.com/',
    searchUrlTemplate: 'https://quaternius.com/assets.html?q={q}',
    legalNote: 'No public API. All packs CC0. Tip: Quaternius models are also searchable in-app through the Poly Pizza provider (official API). Local Import pre-fills CC0.',
    siteLicense: 'CC0',
    licenseNote: 'All packs CC0.',
  },
  {
    id: 'kaykit',
    displayName: 'KayKit',
    homeUrl: 'https://kaylousberg.itch.io/',
    searchUrlTemplate: 'https://kaylousberg.itch.io/game-assets?q={q}',
    legalNote: 'Distributed via itch.io (no public search API). All KayKit packs CC0. Local Import pre-fills CC0.',
    siteLicense: 'CC0',
    licenseNote: 'KayKit packs are CC0.',
  },
  {
    id: 'cgbookcase',
    displayName: 'CG Bookcase',
    homeUrl: 'https://www.cgbookcase.com/',
    searchUrlTemplate: 'https://www.cgbookcase.com/textures?q={q}',
    legalNote: 'No public API; the site’s robots.txt carries Content-Signals without granting collection permission, so we do not crawl. All textures CC0; browse the official site and use Local Import.',
    siteLicense: 'CC0',
    licenseNote: 'Textures CC0.',
  },
  {
    id: 'itch',
    displayName: 'itch.io',
    homeUrl: 'https://itch.io/game-assets',
    searchUrlTemplate: 'https://itch.io/game-assets/tagged-3d/{q}',
    legalNote: 'No public search API (their API covers a developer’s own assets only). Licenses vary per asset — pick the license during Local Import.',
    licenseNote: 'Per-asset: choose during Local Import.',
  },
  {
    id: 'cgtrader',
    displayName: 'CGTrader',
    homeUrl: 'https://www.cgtrader.com/',
    searchUrlTemplate: 'https://www.cgtrader.com/free-3d-models/{q}',
    legalNote: 'Automated access is not offered publicly (partner API only, by approval). Many assets are PAID — always use the official page. Royalty-Free terms vary per asset.',
    licenseNote: 'Per-asset royalty-free; confirm on the asset page.',
    apiNote: 'Partner API (api.cgtrader.com) requires approval — not used.',
  },
  {
    id: 'turbosquid',
    displayName: 'TurboSquid',
    homeUrl: 'https://www.turbosquid.com/',
    searchUrlTemplate: 'https://www.turbosquid.com/Search/3D-Models/free/{q}',
    legalNote: 'Automated access is not offered publicly (partner API only, by approval). Royalty-Free license varies per asset.',
    licenseNote: 'Per-asset; check the license tab on the official page.',
    apiNote: 'Partner API (api.turbosquid.com) requires approval — not used.',
  },
  {
    id: 'free3d',
    displayName: 'Free3D',
    homeUrl: 'https://free3d.com/',
    searchUrlTemplate: 'https://free3d.com/models/{q}',
    legalNote: 'No API. Mixed free/paid; per-asset licenses — always use the official page.',
    licenseNote: 'Per-asset; confirm on the asset page.',
  },
  {
    id: 'mixamo',
    displayName: 'Mixamo (Adobe)',
    homeUrl: 'https://www.mixamo.com/',
    searchUrlTemplate: 'https://www.mixamo.com/#/?query={q}',
    legalNote: 'Requires your Adobe sign-in; automated access is prohibited by Adobe ToS. Download via your browser, then Local Import (Adobe/Mixamo terms apply).',
    siteLicense: 'ADOBE-MIXAMO',
    licenseNote: 'Adobe ToS — use within your Adobe account rights.',
  },
  {
    id: 'fab',
    displayName: 'Fab (Epic Games)',
    homeUrl: 'https://www.fab.com/',
    searchUrlTemplate: 'https://www.fab.com/listings?search_text={q}',
    legalNote: 'No public API; automated access restricted by Epic ToS. Mixed free/paid with per-asset licenses — always use the official page.',
    licenseNote: 'Per-asset; confirm on the official listing.',
  },
];
