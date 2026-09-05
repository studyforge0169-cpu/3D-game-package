/**
 * CLI output helpers — plain-text formatting with stable, script-friendly
 * layouts (and --json variants produced by the commands themselves).
 */

import type { AssetRef, LicenseInfo, DownloadOption, ProviderInfo, SearchPage, LibraryAsset, DownloadTask } from '../core/types';
import type { LicenseDefinition } from '../core/licenses/registry';

export interface CliIo {
  out(line?: string): void;
  err(line?: string): void;
}

export function fmtBytes(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtInt(n?: number): string {
  return n === undefined || n === null ? '—' : n.toLocaleString('en-US');
}

/** Aligned text table; headers optional. */
export function table(rows: string[][], headers?: string[]): string[] {
  const all = headers ? [headers, ...rows] : rows;
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  const lines = all.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
  if (headers) {
    const sep = widths.map((w) => '─'.repeat(Math.min(w, 40))).join('──');
    lines.splice(1, 0, sep);
  }
  return lines;
}

export function commercialWord(l: LicenseInfo): string {
  if (l.unknown) return 'UNKNOWN';
  if (l.commercialUse === 'allowed') return 'YES';
  if (l.commercialUse === 'conditions') return 'CONDITIONS';
  if (l.commercialUse === 'forbidden') return 'NO';
  return 'UNKNOWN';
}

export function licenseLabel(l: LicenseInfo): string {
  return l.unknown ? 'LICENSE UNKNOWN' : `${l.id}${l.raw && l.raw !== l.id ? ` ("${l.raw}")` : ''}`;
}

/** Compact single-line license summary used by `info`. */
export function licenseSummary(l: LicenseInfo): string[] {
  return [
    `License:          ${licenseLabel(l)}`,
    `License name:     ${l.name}`,
    ...(l.url ? [`License URL:      ${l.url}`] : []),
    `Commercial use:   ${commercialWord(l)}`,
    `Attribution:      ${l.attributionRequired ? 'REQUIRED' : 'not required'}`,
    `Share-alike:      ${l.shareAlike ? 'YES' : 'no'}`,
    `Source confirmed: ${l.sourceConfirmed ? 'yes (official data)' : 'no'}`,
    `Checked at:       ${l.licenseCheckedAt}`,
  ];
}

/** Spec-format search result block. */
export function assetBlock(n: number, a: AssetRef): string[] {
  const lines = [
    `${n}. ${a.name}`,
    `   Source: ${a.providerId}`,
    ...(a.creator ? [`   Creator: ${a.creator}`] : []),
    `   License: ${licenseLabel(a.license)}  (commercial use: ${commercialWord(a.license)})`,
    `   Format: ${a.formats.length ? a.formats.join(' / ') : '—'}`,
  ];
  const bits: string[] = [];
  if (a.polyCount !== undefined) bits.push(`poly ${fmtInt(a.polyCount)}`);
  if (a.textureResolution !== undefined) bits.push(`textures ${fmtInt(a.textureResolution)}px`);
  if (a.fileSize !== undefined) bits.push(fmtBytes(a.fileSize));
  if (bits.length) lines.push(`   Detail: ${bits.join(' · ')}`);
  lines.push(
    `   Download: ${a.license.unknown ? 'BLOCKED — license could not be verified' : a.free ? 'free' : a.price ?? 'paid / check source'}`,
    `   URL: ${a.assetUrl}`,
  );
  return lines;
}

// ---------------------------------------------------------------- AI contract
//
// Stable machine-readable shapes (schemas/*.schema.json). All public fields
// are snake_case and identical across providers; agents should parse these
// instead of human-readable output. `--json` on every major command emits
// objects built from these mappers.

export interface AiLicense {
  id: string;
  name: string;
  url: string | null;
  commercial_use: boolean | null;      // null = unknown
  attribution_required: boolean | null;
  share_alike: boolean | null;
  unknown: boolean;
  verified: boolean;                    // confirmed from official data
  verified_at: string | null;
  raw: string | null;
}

export function aiLicense(l: LicenseInfo): AiLicense {
  const u = l.unknown;
  return {
    id: l.id,
    name: l.name,
    url: l.url ?? null,
    commercial_use: u ? null : l.commercialUse === 'allowed',
    attribution_required: u ? null : l.attributionRequired,
    share_alike: u ? null : l.shareAlike,
    unknown: u,
    verified: l.sourceConfirmed,
    verified_at: l.licenseCheckedAt ?? null,
    raw: l.raw ?? null,
  };
}

export function aiLicenseFromDefinition(d: LicenseDefinition): AiLicense {
  return {
    id: d.id,
    name: d.name,
    url: d.url,
    commercial_use: d.commercialUse === 'allowed',
    attribution_required: d.attributionRequired,
    share_alike: d.shareAlike,
    unknown: d.id === 'unknown',
    verified: true,
    verified_at: null,
    raw: null,
  };
}

export interface AiSearchResult {
  id: string;                           // "provider:asset-id" — the download handle
  provider: string;
  name: string;
  creator: string | null;
  source: string;                       // provider display name
  source_url: string;                   // official asset page
  kind: string;
  license: AiLicense;
  license_id: string;
  commercial_use: boolean | null;
  download_available: boolean;
  download_blocked_reason: string | null;
  formats: string[];
  polygon_count: number | null;
  texture_resolution: number | null;
  file_size_bytes: number | null;
  preview_url: string | null;
  tags: string[];
  free: boolean;
  price: string | null;
  created_at: string | null;
  popularity: { downloads: number | null; likes: number | null };
  rigged: boolean;
  animated: boolean;
  pbr: boolean;
}

export function aiSearchResult(a: AssetRef): AiSearchResult {
  const blocked = a.license.unknown;
  return {
    id: `${a.providerId}:${a.id}`,
    provider: a.providerId,
    name: a.name,
    creator: a.creator ?? null,
    source: a.providerId,
    source_url: a.assetUrl,
    kind: a.kind,
    license: aiLicense(a.license),
    license_id: a.license.id,
    commercial_use: a.license.unknown ? null : a.license.commercialUse === 'allowed',
    download_available: !blocked,
    download_blocked_reason: blocked
      ? 'License could not be verified from official data; automated download is blocked.'
      : null,
    formats: a.formats ?? [],
    polygon_count: a.polyCount ?? null,
    texture_resolution: a.textureResolution ?? null,
    file_size_bytes: a.fileSize ?? null,
    preview_url: a.previewUrl ?? null,
    tags: a.tags ?? [],
    free: a.free,
    price: a.price ?? null,
    created_at: a.createdAt ?? null,
    popularity: { downloads: a.downloads ?? null, likes: a.likes ?? null },
    rigged: a.rigged === true,
    animated: a.animated === true,
    pbr: a.pbr === true,
  };
}

export function aiDownloadOption(o: DownloadOption): Record<string, unknown> {
  return {
    id: o.id,
    label: o.label,
    format: o.format,
    size_bytes: o.sizeBytes ?? null,
    requires_auth: o.requiresAuth === true,
    license_id: o.licenseId,
  };
}

export interface AiProvider {
  id: string;
  name: string;
  home_url: string;
  docs_url: string | null;
  tier: string;
  automation: 'supported' | 'partial' | 'manual';
  search: boolean;
  metadata: boolean;
  download: boolean;
  license_verification: boolean;
  per_asset_license: boolean;
  needs_api_key: boolean;
  api_key_configured: boolean | null;
  site_license: string | null;
  legal_note: string;
}

export function aiProvider(
  p: ProviderInfo & { configured?: boolean },
): AiProvider {
  const c = p.capabilities;
  const automation: AiProvider['automation'] =
    p.tier === 'full' ? 'supported' : p.tier === 'hybrid' ? 'partial' : 'manual';
  return {
    id: p.id,
    name: p.displayName,
    home_url: p.homeUrl,
    docs_url: p.docsUrl ?? null,
    tier: p.tier,
    automation,
    search: c.search === true,
    metadata: c.search === true || c.urlImport === true,
    download: c.download === true,
    license_verification: c.perAssetLicense === true || !!p.siteLicense,
    per_asset_license: c.perAssetLicense === true,
    needs_api_key: c.needsApiKey === true,
    api_key_configured: p.configured ?? null,
    site_license: p.siteLicense ?? null,
    legal_note: p.legalNote,
  };
}

export function aiLibraryAsset(a: LibraryAsset): Record<string, unknown> {
  return {
    library_id: a.id,
    ref: `${a.providerId}@library`,
    name: a.name,
    creator: a.creator ?? null,
    provider: a.providerId,
    source_url: a.sourceUrl,
    license_id: a.licenseId,
    license_url: a.licenseUrl ?? null,
    category: a.category,
    kind: a.kind,
    format: a.format,
    size_bytes: a.fileSize,
    sha256: a.sha256 ?? null,
    path: a.localPath,
    metadata_path: a.originalDir.replace(/[/\\]Original$/, '') + '/asset.json',
    downloaded_at: a.downloadedAt,
    tags: JSON.parse(a.tagsJson || '[]'),
  };
}

export function aiTask(t: DownloadTask): Record<string, unknown> {
  return {
    task_id: t.id,
    ref: `${t.providerId}:${t.assetRef.id}`,
    state: t.state,
    bytes: t.bytes,
    total_bytes: t.totalBytes ?? null,
    error: t.error ?? null,
  };
}

/** Provider errors from a multi-source search, in contract shape. */
export function aiProviderErrors(pages: SearchPage[]): { provider: string; code: string; message: string; search_url: string | null }[] {
  const out: { provider: string; code: string; message: string; search_url: string | null }[] = [];
  for (const p of pages) {
    if (!p.error) continue;
    let code = 'PROVIDER_UNAVAILABLE';
    if (/needs your API key|api key/i.test(p.error)) code = 'AUTH_REQUIRED';
    else if (/Automated access is unavailable/i.test(p.error)) code = 'DOWNLOAD_UNAVAILABLE';
    else if (/rate limit|429/i.test(p.error)) code = 'RATE_LIMITED';
    out.push({ provider: p.providerId, code, message: p.error, search_url: (p as { searchUrl?: string }).searchUrl ?? null });
  }
  return out;
}
