/**
 * Khronos glTF Sample Assets connector — official GitHub repository via the
 * official GitHub REST API (https://api.github.com).
 *
 * Verified live: the repo publishes Models/model-index.json (150 models) and a
 * per-model metadata.json whose `legal` array declares SPDX licenses per
 * component. Licenses are resolved per asset and the MOST RESTRICTIVE
 * component governs the whole asset (e.g. DamagedHelmet = CC-BY-4.0 rebuild
 * over a CC-BY-NC-4.0 earlier version ⇒ redistribution not permitted ⇒ the
 * license gate skips it). Files are fetched via the Git Blobs API (base64,
 * ≤100 MB) and verified against the git blob SHA-1 reported by the API.
 *
 * Rate limits: GitHub allows 60 req/h unauthenticated per IP — enough for
 * browsing; set a key (`asset-hub key set gltfsamples <token>`) for bulk
 * mirroring (5000 req/h). No key is ever logged or written to metadata.
 */

import type {
  AssetKind, AssetRef, DownloadOption, LicenseInfo, PreviewImage, ProviderInfo,
  SearchPage, SearchQuery,
} from '../types';
import { BaseProvider, textScore } from './base';
import { normalizeLicense, unknownLicenseInfo } from '../licenses/registry';
import { sha256Buffer } from '../util/hash';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';

const API = 'https://api.github.com/repos/KhronosGroup/glTF-Sample-Assets';
const REPO = 'https://github.com/KhronosGroup/glTF-Sample-Assets';
const INDEX_TTL = 60 * 60 * 1000;

interface GhFile {
  name: string; path: string; sha: string; size: number; type: string;
  content?: string; encoding?: string;
}
interface IndexEntry {
  label: string; name: string; screenshot?: string;
  tags?: string[]; variants?: Record<string, string>;
}
interface LegalEntry {
  license?: string; licenseUrl?: string; artist?: string; year?: string;
  owner?: string; what?: string; text?: string; spdx?: string;
}
interface ModelMeta { name?: string; legal?: LegalEntry[]; tags?: string[] }

/** git blob hash: sha1("blob <bytes>\0" + bytes) — GitHub's file checksum. */
export function gitBlobSha1(buf: Buffer): string {
  const h = createHash('sha1');
  h.update(`blob ${buf.length}\u0000`);
  h.update(buf);
  return h.digest('hex');
}

export class GlTFSamplesProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'gltfsamples',
    displayName: 'Khronos glTF Samples',
    homeUrl: REPO,
    docsUrl: `${REPO}/blob/main/README.md`,
    legalNote: 'Official Khronos sample-asset repo on GitHub. Every model declares its own license in metadata.json; NC/ND/undetermined components make the asset non-redistributable (gate skips it). Unauthenticated API: 60 req/h — set a key for bulk mirroring.',
    tier: 'full',
    capabilities: {
      search: true, download: true, perAssetLicense: true,
      browserSearch: true, urlImport: true, needsApiKey: false,
      apiDocsUrl: 'https://docs.github.com/en/rest', robotsScope: 'api',
    },
  };

  private indexCache: { at: number; entries: IndexEntry[] } | null = null;
  private metaCache = new Map<string, ModelMeta>();
  private licCache = new Map<string, { license: LicenseInfo; artist?: string }>();

  // ---------------------------------------------------------------- GitHub I/O

  private async gh<T>(url: string, key?: string): Promise<T> {
    return this.http.getJson<T>(url, {
      headers: key ? { authorization: `Bearer ${key}` } : undefined,
    });
  }

  /** Contents-API file fetch, decoded from base64. */
  private async file<T>(url: string, key?: string): Promise<T> {
    const doc = await this.gh<GhFile>(url, key);
    if (typeof doc.content !== 'string') throw new Error(`unexpected GitHub response for ${url}`);
    if (doc.encoding && doc.encoding !== 'base64') throw new Error(`unsupported encoding ${doc.encoding}`);
    return JSON.parse(Buffer.from(doc.content, 'base64').toString('utf8')) as T;
  }

  private async index(key?: string): Promise<IndexEntry[]> {
    if (this.indexCache && Date.now() - this.indexCache.at < INDEX_TTL) return this.indexCache.entries;
    const entries = await this.file<IndexEntry[]>(`${API}/contents/Models/model-index.json`, key);
    this.indexCache = { at: Date.now(), entries };
    return entries;
  }

  private async meta(name: string, key?: string): Promise<ModelMeta> {
    const hit = this.metaCache.get(name);
    if (hit) return hit;
    const m = await this.file<ModelMeta>(`${API}/contents/Models/${encodeURIComponent(name)}/metadata.json`, key);
    this.metaCache.set(name, m);
    return m;
  }

  /**
   * Per-asset license from the model's own legal declarations. The most
   * restrictive component governs: any NC/ND/"None" component ⇒ the asset is
   * not redistributable (or unknown), never guessed otherwise.
   */
  private async license(name: string, key?: string): Promise<{ license: LicenseInfo; artist?: string }> {
    const hit = this.licCache.get(name);
    if (hit) return hit;
    const m = await this.meta(name, key);
    let out: { license: LicenseInfo; artist?: string } = { license: unknownLicenseInfo('license not declared for this model') };
    if (m.legal?.length) {
      const severity = (l: LicenseInfo): number => (l.unknown ? 3 : l.redistribution === 'forbidden' ? 2 : l.redistribution === 'conditions' ? 1 : 0);
      let worst: LicenseInfo | null = null;
      let artist: string | undefined;
      for (const [i, e] of m.legal.entries()) {
        if (i === 0 && e.artist) artist = e.artist;
        const raw = (e.spdx ?? e.license ?? e.text ?? '').trim();
        if (!raw || /^none$/i.test(raw)) {
          worst = unknownLicenseInfo(`component "${e.what ?? 'part of the model'}" has no license ("None")`);
          continue;
        }
        const info = normalizeLicense({ raw, licenseUrl: e.licenseUrl, sourceConfirmed: true });
        if (!worst || severity(info) > severity(worst)) worst = info;
      }
      out = { license: worst ?? out.license, artist };
    }
    this.licCache.set(name, out);
    return out;
  }

  // -------------------------------------------------------------------- refs

  private toRef(entry: IndexEntry, lic: { license: LicenseInfo; artist?: string }): AssetRef {
    const variants = Object.keys(entry.variants ?? {});
    return {
      id: entry.name,
      providerId: 'gltfsamples',
      name: entry.label ?? entry.name,
      creator: lic.artist,
      kind: 'model' as AssetKind,
      assetUrl: `${REPO}/tree/main/Models/${entry.name}`,
      previewUrl: entry.screenshot
        ? `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/${entry.name}/${entry.screenshot}`
        : undefined,
      license: lic.license,
      free: true,
      formats: variants.includes('glTF-Binary') ? ['glb', 'gltf'] : variants.length ? ['gltf'] : ['gltf'],
      tags: entry.tags ?? [],
      pbr: true,
    };
  }

  override assetIdFromUrl(url: string): string | null {
    const m = /glTF-Sample-Assets\/(?:tree\/main\/)?Models\/([^/?#]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async search(query: SearchQuery, key?: string): Promise<SearchPage> {
    const all = await this.index(key).catch(() => [] as IndexEntry[]);
    let filtered = all;
    if (query.text) {
      filtered = filtered
        .map((e) => ({ e, s: textScore([e.label, e.name, ...(e.tags ?? [])], query.text) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.e);
    }
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 48;
    const slice = filtered.slice((page - 1) * perPage, page * perPage);
    // Resolve licenses only for the returned page (rate-limit friendly).
    const results: AssetRef[] = [];
    for (const e of slice) {
      const lic = await this.license(e.name, key).catch(() => ({
        license: unknownLicenseInfo('license lookup failed (GitHub rate limit? set a key: asset-hub key set gltfsamples <token>)'),
      }));
      results.push(this.toRef(e, lic));
    }
    return { providerId: 'gltfsamples', results, total: filtered.length, page, hasMore: page * perPage < filtered.length };
  }

  async getAsset(id: string, key?: string): Promise<AssetRef | null> {
    const all = await this.index(key).catch(() => [] as IndexEntry[]);
    const e = all.find((x) => x.name === id);
    if (!e) return null;
    return this.toRef(e, await this.license(id, key));
  }

  async getLicense(id: string, key?: string): Promise<LicenseInfo> {
    return (await this.getAsset(id, key))?.license ?? unknownLicenseInfo('model not found');
  }

  async getDownloadOptions(id: string, key?: string): Promise<DownloadOption[]> {
    const lic = await this.license(id, key);
    if (lic.license.unknown) throw new Error(`license for ${id} could not be verified — download refused`);
    const options: DownloadOption[] = [];
    const blobUrl = (sha: string): string => `${API}/git/blobs/${sha}`;

    // glTF-Binary: single self-contained .glb
    const bin = await this.gh<GhFile[]>(`${API}/contents/Models/${encodeURIComponent(id)}/glTF-Binary`, key).catch(() => []);
    const glb = bin.find((f) => f.type === 'file' && f.name.toLowerCase().endsWith('.glb'));
    if (glb) {
      options.push({
        id: `gh:${id}:glb`, label: 'GLB (glTF-Binary)', format: 'glb',
        sizeBytes: glb.size, url: blobUrl(glb.sha), sha1Git: glb.sha, licenseId: lic.license.id,
      });
    }

    // glTF: multi-file (.gltf + .bin + textures) via includes
    const dir = await this.gh<GhFile[]>(`${API}/contents/Models/${encodeURIComponent(id)}/glTF`, key).catch(() => []);
    const files = dir.filter((f) => f.type === 'file');
    const main = files.find((f) => f.name.toLowerCase().endsWith('.gltf'));
    if (main) {
      options.push({
        id: `gh:${id}:gltf`, label: 'glTF (separate files)', format: 'gltf',
        sizeBytes: main.size, url: blobUrl(main.sha), sha1Git: main.sha, licenseId: lic.license.id,
        includes: files.filter((f) => f !== main).map((f) => ({
          path: f.name, url: blobUrl(f.sha), sizeBytes: f.size, sha1Git: f.sha,
        })),
      });
    }
    return options;
  }

  async getMetadata(id: string, key?: string): Promise<Record<string, unknown>> {
    return { ...(await this.meta(id, key)) };
  }

  async download(option: DownloadOption, ctx: import('../types').ProviderRuntimeCtx): Promise<import('../types').DownloadResult> {
    const doc = await this.gh<{ content?: string; encoding?: string }>(option.url, ctx.apiKey);
    if (typeof doc.content !== 'string') return { ok: false, path: ctx.destPath, bytes: 0, errorCode: 'DOWNLOAD_FAILED', error: 'unexpected GitHub blob response' };
    const buf = Buffer.from(doc.content, doc.encoding === 'base64' ? 'base64' : 'utf8');
    if (option.sha1Git) {
      const actual = gitBlobSha1(buf);
      if (actual !== option.sha1Git) {
        return { ok: false, path: ctx.destPath, bytes: buf.length, errorCode: 'HASH_MISMATCH', error: `git blob sha1 mismatch: got ${actual}, API reported ${option.sha1Git}` };
      }
    }
    await fsp.writeFile(ctx.destPath, buf);
    ctx.onProgress?.(buf.length, buf.length);
    return { ok: true, path: ctx.destPath, bytes: buf.length, sha256: sha256Buffer(buf) };
  }

  async getPreviewUrls(id: string, key?: string): Promise<PreviewImage[]> {
    const a = await this.getAsset(id, key);
    return a?.previewUrl ? [{ url: a.previewUrl }] : [];
  }

  buildSearchUrl(query: SearchQuery): string {
    return `https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models${query.text ? `?search=${encodeURIComponent(query.text)}` : ''}`;
  }
}
