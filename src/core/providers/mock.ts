/**
 * Mock provider (spec §21): a deterministic fixture catalog that exercises the
 * FULL provider contract (search/license/download with real bytes, previews,
 * duplicate seed, CC0/CC-BY/NC variety). Used by automated tests and by the
 * offline demo mode (UGAH_FIXTURES=1) — never shown as a real source.
 */

import type {
  AssetRef, DownloadOption, LicenseInfo, PreviewImage, ProviderInfo,
  SearchPage, SearchQuery,
} from '../types';
import { BaseProvider } from './base';
import { normalizeLicense } from '../licenses/registry';
import { sha256Buffer } from '../util/hash';

interface MockEntry {
  id: string; name: string; creator: string; tags: string[];
  license: string; kind: AssetRef['kind']; polyCount?: number;
  textureResolution?: number; downloads: number; likes: number;
  createdAt: string; animated?: boolean; rigged?: boolean; pbr?: boolean;
  /** deterministic fake payload */
  bytes?: number;
}

export const MOCK_CATALOG: MockEntry[] = [
  { id: 'mock-castle-01', name: 'Medieval Castle', creator: 'Fixture Studio', tags: ['castle', 'medieval', 'building', 'stone'], license: 'CC0', kind: 'model', polyCount: 18500, downloads: 4200, likes: 350, createdAt: '2024-02-10T00:00:00Z', pbr: true },
  { id: 'mock-rifle-01', name: 'AK-style Rifle', creator: 'Fixture Studio', tags: ['rifle', 'weapon', 'gun', 'military'], license: 'CC-BY-4.0', kind: 'model', polyCount: 8400, downloads: 3100, likes: 220, createdAt: '2024-03-01T00:00:00Z', pbr: true },
  { id: 'mock-car-01', name: 'Modern Car Sedan', creator: 'Fixture Studio', tags: ['car', 'vehicle', 'modern', 'sedan'], license: 'CC0', kind: 'model', polyCount: 32000, downloads: 8100, likes: 540, createdAt: '2024-04-19T00:00:00Z', pbr: true },
  { id: 'mock-forest-01', name: 'Forest Pack', creator: 'Fixture Studio', tags: ['forest', 'tree', 'nature', 'environment'], license: 'CC0', kind: 'model', polyCount: 96000, downloads: 15400, likes: 990, createdAt: '2023-11-05T00:00:00Z', pbr: true },
  { id: 'mock-zombie-01', name: 'Zombie Character', creator: 'Fixture Studio', tags: ['zombie', 'character', 'undead', 'human'], license: 'CC-BY-4.0', kind: 'model', polyCount: 22100, downloads: 6700, likes: 810, createdAt: '2024-01-22T00:00:00Z', animated: true, rigged: true },
  { id: 'mock-spacestation-01', name: 'Space Station Modular', creator: 'Fixture Studio', tags: ['space', 'station', 'scifi', 'building'], license: 'CC0', kind: 'model', polyCount: 54000, downloads: 5000, likes: 610, createdAt: '2024-05-30T00:00:00Z' },
  { id: 'mock-human-01', name: 'Base Human Character Rigged', creator: 'Fixture Studio', tags: ['human', 'character', 'rigged'], license: 'CC-BY-4.0', kind: 'model', polyCount: 18900, downloads: 9900, likes: 1200, createdAt: '2023-09-14T00:00:00Z', animated: true, rigged: true },
  { id: 'mock-tree-01', name: 'Low Poly Tree', creator: 'Fixture Studio', tags: ['tree', 'vegetation', 'lowpoly'], license: 'CC0', kind: 'model', polyCount: 320, downloads: 22000, likes: 2400, createdAt: '2023-06-01T00:00:00Z' },
  { id: 'mock-rock-01', name: 'Rock Set', creator: 'Fixture Studio', tags: ['rock', 'stone', 'nature'], license: 'CC0', kind: 'model', polyCount: 1500, downloads: 7800, likes: 410, createdAt: '2023-07-15T00:00:00Z', pbr: true },
  { id: 'mock-chair-01', name: 'Wooden Chair', creator: 'Fixture Studio', tags: ['chair', 'furniture', 'prop', 'wood'], license: 'CC0', kind: 'model', polyCount: 2100, downloads: 3400, likes: 150, createdAt: '2024-06-02T00:00:00Z', pbr: true },
  { id: 'mock-sword-01', name: 'Fantasy Sword', creator: 'Fixture Studio', tags: ['sword', 'weapon', 'fantasy'], license: 'CC-BY-4.0', kind: 'model', polyCount: 980, downloads: 8700, likes: 720, createdAt: '2024-02-29T00:00:00Z', pbr: true },
  { id: 'mock-grass-01', name: 'Grass Texture 4K PBR', creator: 'Fixture Studio', tags: ['grass', 'texture', 'pbr', 'ground'], license: 'CC0', kind: 'texture', textureResolution: 4096, downloads: 12800, likes: 880, createdAt: '2023-08-20T00:00:00Z', pbr: true },
  { id: 'mock-brick-01', name: 'Brick Wall Material', creator: 'Fixture Studio', tags: ['brick', 'material', 'pbr', 'wall'], license: 'CC0', kind: 'material', textureResolution: 4096, downloads: 9100, likes: 640, createdAt: '2023-10-11T00:00:00Z', pbr: true },
  { id: 'mock-sunset-01', name: 'Sunset HDRI 8K', creator: 'Fixture Studio', tags: ['sunset', 'hdri', 'sky', 'lighting'], license: 'CC0', kind: 'hdri', textureResolution: 8192, downloads: 6600, likes: 900, createdAt: '2024-01-05T00:00:00Z' },
  { id: 'mock-nc-01', name: 'NC-Limited Mech', creator: 'Fixture Studio', tags: ['mech', 'robot', 'scifi'], license: 'CC-BY-NC-4.0', kind: 'model', polyCount: 44000, downloads: 1200, likes: 300, createdAt: '2024-07-07T00:00:00Z' },
  { id: 'mock-unknown-01', name: 'Mystery Crate (license unknown)', creator: 'Fixture Studio', tags: ['crate', 'box', 'prop'], license: '', kind: 'model', polyCount: 120, downloads: 100, likes: 5, createdAt: '2024-08-08T00:00:00Z' },
  // duplicate seed: same name/tags as mock-rock-01 under a second id
  { id: 'mock-rock-01b', name: 'Rock Set (mirror)', creator: 'Fixture Studio', tags: ['rock', 'stone', 'nature'], license: 'CC0', kind: 'model', polyCount: 1500, downloads: 12, likes: 1, createdAt: '2024-08-09T00:00:00Z', pbr: true },
];

export class MockProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'mock',
    displayName: 'Mock (tests/offline demo)',
    homeUrl: 'about:mock',
    legalNote: 'Local fixture catalog for automated tests and offline demo mode. Not a real website.',
    tier: 'full',
    capabilities: {
      search: true, download: true, perAssetLicense: true,
      browserSearch: false, urlImport: false, needsApiKey: false, robotsScope: 'api',
    },
  };

  private toRef(e: MockEntry): AssetRef {
    const license = e.license
      ? normalizeLicense({ raw: e.license, sourceConfirmed: true })
      : normalizeLicense({ raw: undefined, sourceConfirmed: false });
    return {
      id: e.id,
      providerId: 'mock',
      name: e.name,
      creator: e.creator,
      kind: e.kind,
      categoryHint: undefined,
      previewUrl: undefined,
      assetUrl: `mock://${e.id}`,
      license,
      free: true,
      polyCount: e.polyCount,
      textureResolution: e.textureResolution,
      formats: ['glb'],
      fileSize: e.bytes ?? 2048,
      tags: e.tags,
      createdAt: e.createdAt,
      downloads: e.downloads,
      likes: e.likes,
      animated: e.animated,
      rigged: e.rigged,
      pbr: e.pbr,
    };
  }

  async search(query: SearchQuery): Promise<SearchPage> {
    const text = (query.text ?? '').toLowerCase();
    let results = MOCK_CATALOG.map((e) => this.toRef(e));
    if (text) {
      results = results
        .map((r) => ({ r, s: score(r, text) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.r);
    }
    const f = query.filters;
    if (f?.cc0Only) results = results.filter((r) => r.license.id === 'CC0-1.0');
    if (f?.commercialOnly) results = results.filter((r) => r.license.commercialUse === 'allowed');
    if (f?.noAttributionOnly) results = results.filter((r) => !r.license.attributionRequired);
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 48;
    return {
      providerId: 'mock',
      results: results.slice((page - 1) * perPage, page * perPage),
      total: results.length, page,
      hasMore: page * perPage < results.length,
    };
  }

  async getAsset(id: string): Promise<AssetRef | null> {
    const e = MOCK_CATALOG.find((m) => m.id === id);
    return e ? this.toRef(e) : null;
  }

  async getLicense(id: string): Promise<LicenseInfo> {
    return (await this.getAsset(id))?.license ?? normalizeLicense({ raw: undefined, sourceConfirmed: false });
  }

  async getDownloadOptions(id: string): Promise<DownloadOption[]> {
    const e = MOCK_CATALOG.find((m) => m.id === id);
    if (!e) return [];
    return [{ id: `mock:${id}:glb`, label: 'GLB (fixture)', format: 'glb', url: `mock://download/${id}.glb`, licenseId: this.licenseOf(e.license) }];
  }

  async getMetadata(id: string): Promise<Record<string, unknown>> {
    const e = MOCK_CATALOG.find((m) => m.id === id);
    return e ? { ...e } : {};
  }

  async download(option: DownloadOption, ctx: import('../types').ProviderRuntimeCtx): Promise<import('../types').DownloadResult> {
    // Simulated transfer time so pause/cancel semantics are testable.
    for (let t = 0; t < 20 && !ctx.signal?.aborted; t++) await new Promise((r) => setTimeout(r, 10));
    if (ctx.signal?.aborted) return { ok: false, bytes: 0, errorCode: 'CANCELED', error: 'canceled' };
    // Produce a deterministic, real file on disk (a tiny valid GLB).
    const buf = makeMockGlb(option.id);
    await import('node:fs/promises').then((fs) => fs.writeFile(ctx.destPath, buf));
    ctx.onProgress?.(buf.length, buf.length);
    return { ok: true, path: ctx.destPath, bytes: buf.length, sha256: sha256Buffer(buf) };
  }

  async getPreviewUrls(id: string): Promise<PreviewImage[]> {
    return [{ url: `mock://preview/${id}` }];
  }

  buildSearchUrl(): string { return 'about:mock'; }

  private licenseOf(raw: string): string {
    return normalizeLicense({ raw: raw || undefined, sourceConfirmed: !!raw }).id;
  }
}

function score(r: AssetRef, text: string): number {
  const name = r.name.toLowerCase();
  if (name.includes(text)) return name.startsWith(text) ? 10 : 5;
  const tags = r.tags.join(' ').toLowerCase();
  if (tags.includes(text)) return 3;
  if (r.creator?.toLowerCase().includes(text)) return 2;
  return 0;
}

/** Minimal valid GLB containing one real triangle mesh (for conversion tests). */
export function makeMockGlb(label: string): Buffer {
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0.5, 1, 0.25,
  ]);
  const bin = Buffer.from(positions.buffer, 0, positions.byteLength);
  const json = {
    asset: { version: '2.0', generator: 'UGAH-mock' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: label }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{
      bufferView: 0, componentType: 5126, count: 3, type: 'VEC3',
      min: [0, 0, 0], max: [1, 1, 0.25],
    }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length, target: 34962 }],
    buffers: [{ byteLength: bin.length }],
    extras: { label },
  };
  const jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + bin.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, bin]);
}
