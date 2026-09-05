/**
 * ClientAPI — one typed surface, two transports:
 *  - Electron: window.hubBridge (contextBridge IPC)
 *  - Web/server mode: REST + SSE against the local hub server
 * The renderer never touches the network directly (except preview images
 * loaded via <img>, which come from the sources' own CDNs).
 */

import type {
  AssetCategory, AssetRef, AttributionDoc, Collection, ConvertOptions,
  ConvertResult, DownloadOption, DownloadProgressEvent, DownloadTask, EngineId,
  ExportResult, GameProject, LibraryAsset, LicenseInfo, SearchPage, SearchQuery,
} from '../core/types';
import type { AppConfig } from '../core/util/config';

export interface ProviderInfoDto {
  id: string;
  displayName: string;
  homeUrl: string;
  legalNote: string;
  siteLicense?: string;
  tier: 'full' | 'hybrid' | 'manual';
  capabilities: Record<string, unknown>;
  docsUrl?: string;
  configured?: boolean;
}

export interface ConverterToolsDto {
  blender: { available: boolean; path?: string };
  assimp: { available: boolean; path?: string };
}

export interface ClientApi {
  mode: 'electron' | 'http';
  // search
  search(q: SearchQuery): Promise<SearchPage[]>;
  providerInfos(): Promise<ProviderInfoDto[]>;
  getAssetDetail(providerId: string, assetId: string): Promise<{ asset: AssetRef | null; license: LicenseInfo; options: DownloadOption[] }>;
  // downloads
  enqueueDownload(providerId: string, assetId: string, optionId?: string): Promise<DownloadTask>;
  downloads(): Promise<DownloadTask[]>;
  pauseDownloads(taskId?: string): Promise<void>;
  resumeDownloads(taskId?: string): Promise<void>;
  cancelDownload(taskId: string): Promise<void>;
  retryDownload(taskId: string): Promise<void>;
  removeDownload(taskId: string): Promise<void>;
  clearFinishedDownloads(): Promise<void>;
  onProgress(cb: (ev: DownloadProgressEvent) => void): () => void;
  // library
  librarySearch(opts: Record<string, unknown>): Promise<LibraryAsset[]>;
  asset(id: string): Promise<LibraryAsset | null>;
  updateAsset(id: string, patch: Partial<LibraryAsset>): Promise<void>;
  moveAssetCategory(id: string, cat: AssetCategory): Promise<void>;
  deleteAsset(id: string): Promise<void>;
  verifyAsset(id: string): Promise<{ ok: boolean; reason?: string }>;
  recentlyDownloaded(): Promise<LibraryAsset[]>;
  recentlyUsed(): Promise<LibraryAsset[]>;
  scanDuplicates(): Promise<void>;
  duplicateGroups(): Promise<{ groupId: string; kind: string; detail?: string; assets: { asset: LibraryAsset; score: number }[] }[]>;
  importLocalFile(opts: Record<string, unknown>): Promise<{ asset: LibraryAsset; duplicates: { duplicate: boolean; matches: unknown[] } }>;
  // collections
  createCollection(name: string, description?: string): Promise<Collection>;
  listCollections(): Promise<Collection[]>;
  deleteCollection(id: string): Promise<void>;
  addToCollection(collectionId: string, assetId: string): Promise<void>;
  removeFromCollection(collectionId: string, assetId: string): Promise<void>;
  collectionAssets(collectionId: string): Promise<LibraryAsset[]>;
  // converters
  convertAsset(assetId: string, options: ConvertOptions): Promise<ConvertResult>;
  converterTools(): Promise<ConverterToolsDto>;
  // export
  exportAssets(req: Record<string, unknown>): Promise<ExportResult>;
  resolveExportConflicts(req: Record<string, unknown>, decision: string): Promise<void>;
  onExportConflicts(cb: (ev: { conflicts: { intendedPath: string; existingSize: number; newSize: number }[] }) => void): () => void;
  listProjects(): Promise<GameProject[]>;
  saveProject(p: Record<string, unknown>): Promise<GameProject>;
  deleteProject(id: string): Promise<void>;
  // attribution
  attributionFor(ids: string[]): Promise<AttributionDoc>;
  attributionForCollection(id: string): Promise<AttributionDoc>;
  writeAttributionFiles(ids: string[], dir: string): Promise<string[]>;
  // settings
  getConfig(): Promise<AppConfig>;
  updateConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  setApiKey(provider: string, key: string): Promise<void>;
  hasApiKey(provider: string): Promise<boolean>;
  secretBackend(): Promise<string>;
  backupDatabase(): Promise<string>;
  // files & shell
  openExternal(url: string): Promise<void>;
  pickFile(extensions?: string[]): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  readAssetFile(assetId: string): Promise<ArrayBuffer | null>;
  readPreview(assetId: string): Promise<string | null>;
}

interface HubBridge {
  invoke(method: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (ev: unknown) => void): () => void;
}

declare global {
  interface Window { hubBridge?: HubBridge }
}

class ElectronApi implements ClientApi {
  readonly mode = 'electron' as const;
  constructor(private readonly bridge: HubBridge) {}
  private call<T>(m: string, ...a: unknown[]): Promise<T> { return this.bridge.invoke(m, ...a) as Promise<T>; }
  search(q: SearchQuery) { return this.call<SearchPage[]>('search', q); }
  providerInfos() { return this.call<ProviderInfoDto[]>('providerInfos'); }
  getAssetDetail(p: string, id: string) { return this.call<{ asset: AssetRef | null; license: LicenseInfo; options: DownloadOption[] }>('getAssetDetail', p, id); }
  enqueueDownload(p: string, id: string, o?: string) { return this.call<DownloadTask>('enqueueDownload', p, id, o); }
  downloads() { return this.call<DownloadTask[]>('downloads'); }
  pauseDownloads(t?: string) { return this.call<void>('pauseDownloads', t); }
  resumeDownloads(t?: string) { return this.call<void>('resumeDownloads', t); }
  cancelDownload(t: string) { return this.call<void>('cancelDownload', t); }
  retryDownload(t: string) { return this.call<void>('retryDownload', t); }
  removeDownload(t: string) { return this.call<void>('removeDownload', t); }
  clearFinishedDownloads() { return this.call<void>('clearFinishedDownloads'); }
  onProgress(cb: (ev: DownloadProgressEvent) => void) { return this.bridge.on('download-progress', (e) => cb(e as DownloadProgressEvent)); }
  librarySearch(o: Record<string, unknown>) { return this.call<LibraryAsset[]>('librarySearch', o); }
  asset(id: string) { return this.call<LibraryAsset | null>('asset', id); }
  updateAsset(id: string, p: Partial<LibraryAsset>) { return this.call<void>('updateAsset', id, p); }
  moveAssetCategory(id: string, c: AssetCategory) { return this.call<void>('moveAssetCategory', id, c); }
  deleteAsset(id: string) { return this.call<void>('deleteAsset', id); }
  verifyAsset(id: string) { return this.call<{ ok: boolean; reason?: string }>('verifyAsset', id); }
  recentlyDownloaded() { return this.call<LibraryAsset[]>('recentlyDownloaded'); }
  recentlyUsed() { return this.call<LibraryAsset[]>('recentlyUsed'); }
  scanDuplicates() { return this.call<void>('scanDuplicates'); }
  duplicateGroups() { return this.call<ClientApi['duplicateGroups'] extends Promise<infer T> ? T : never>('duplicateGroups'); }
  importLocalFile(o: Record<string, unknown>) { return this.call<{ asset: LibraryAsset; duplicates: { duplicate: boolean; matches: unknown[] } }>('importLocalFile', o); }
  createCollection(n: string, d?: string) { return this.call<Collection>('createCollection', n, d); }
  listCollections() { return this.call<Collection[]>('listCollections'); }
  deleteCollection(id: string) { return this.call<void>('deleteCollection', id); }
  addToCollection(c: string, a: string) { return this.call<void>('addToCollection', c, a); }
  removeFromCollection(c: string, a: string) { return this.call<void>('removeFromCollection', c, a); }
  collectionAssets(c: string) { return this.call<LibraryAsset[]>('collectionAssets', c); }
  convertAsset(id: string, o: ConvertOptions) { return this.call<ConvertResult>('convertAsset', id, o); }
  converterTools() { return this.call<ConverterToolsDto>('converterTools'); }
  exportAssets(r: Record<string, unknown>) { return this.call<ExportResult>('exportAssets', r); }
  resolveExportConflicts(r: Record<string, unknown>, d: string) { return this.call<void>('resolveExportConflicts', r, d); }
  onExportConflicts(cb: (ev: { conflicts: { intendedPath: string; existingSize: number; newSize: number }[] }) => void) {
    return this.bridge.on('export-conflicts', (e) => cb(e as never));
  }
  listProjects() { return this.call<GameProject[]>('listProjects'); }
  saveProject(p: Record<string, unknown>) { return this.call<GameProject>('saveProject', p); }
  deleteProject(id: string) { return this.call<void>('deleteProject', id); }
  attributionFor(ids: string[]) { return this.call<AttributionDoc>('attributionFor', ids); }
  attributionForCollection(id: string) { return this.call<AttributionDoc>('attributionForCollection', id); }
  writeAttributionFiles(ids: string[], dir: string) { return this.call<string[]>('writeAttributionFiles', ids, dir); }
  getConfig() { return this.call<AppConfig>('getConfig'); }
  updateConfig(p: Partial<AppConfig>) { return this.call<AppConfig>('updateConfig', p); }
  setApiKey(p: string, k: string) { return this.call<void>('setApiKey', p, k); }
  hasApiKey(p: string) { return this.call<boolean>('hasApiKey', p); }
  secretBackend() { return this.call<string>('secretBackend'); }
  backupDatabase() { return this.call<string>('backupDatabase'); }
  openExternal(u: string) { return this.call<void>('openExternal', u); }
  pickFile(e?: string[]) { return this.call<string | null>('pickFile', e); }
  pickDirectory() { return this.call<string | null>('pickDirectory'); }
  readAssetFile(id: string) { return this.call<ArrayBuffer | null>('readAssetFile', id); }
  readPreview(id: string) { return this.call<string | null>('readPreview', id); }
}

class HttpApi implements ClientApi {
  readonly mode = 'http' as const;
  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    const res = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(body || `request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }
  search(q: SearchQuery) { return this.call<SearchPage[]>('search', q); }
  providerInfos() { return this.call<ProviderInfoDto[]>('providerInfos'); }
  getAssetDetail(p: string, id: string) { return this.call<{ asset: AssetRef | null; license: LicenseInfo; options: DownloadOption[] }>('getAssetDetail', p, id); }
  enqueueDownload(p: string, id: string, o?: string) { return this.call<DownloadTask>('enqueueDownload', p, id, o); }
  downloads() { return this.call<DownloadTask[]>('downloads'); }
  pauseDownloads(t?: string) { return this.call<void>('pauseDownloads', t); }
  resumeDownloads(t?: string) { return this.call<void>('resumeDownloads', t); }
  cancelDownload(t: string) { return this.call<void>('cancelDownload', t); }
  retryDownload(t: string) { return this.call<void>('retryDownload', t); }
  removeDownload(t: string) { return this.call<void>('removeDownload', t); }
  clearFinishedDownloads() { return this.call<void>('clearFinishedDownloads'); }
  onProgress(cb: (ev: DownloadProgressEvent) => void) { return this.subscribeSse('download-progress', cb); }
  librarySearch(o: Record<string, unknown>) { return this.call<LibraryAsset[]>('librarySearch', o); }
  asset(id: string) { return this.call<LibraryAsset | null>('asset', id); }
  updateAsset(id: string, p: Partial<LibraryAsset>) { return this.call<void>('updateAsset', id, p); }
  moveAssetCategory(id: string, c: AssetCategory) { return this.call<void>('moveAssetCategory', id, c); }
  deleteAsset(id: string) { return this.call<void>('deleteAsset', id); }
  verifyAsset(id: string) { return this.call<{ ok: boolean; reason?: string }>('verifyAsset', id); }
  recentlyDownloaded() { return this.call<LibraryAsset[]>('recentlyDownloaded'); }
  recentlyUsed() { return this.call<LibraryAsset[]>('recentlyUsed'); }
  scanDuplicates() { return this.call<void>('scanDuplicates'); }
  duplicateGroups() { return this.call<ClientApi["duplicateGroups"] extends Promise<infer T> ? T : never>('duplicateGroups'); }
  importLocalFile(o: Record<string, unknown>) { return this.call<{ asset: LibraryAsset; duplicates: { duplicate: boolean; matches: unknown[] } }>('importLocalFile', o); }
  createCollection(n: string, d?: string) { return this.call<Collection>('createCollection', n, d); }
  listCollections() { return this.call<Collection[]>('listCollections'); }
  deleteCollection(id: string) { return this.call<void>('deleteCollection', id); }
  addToCollection(c: string, a: string) { return this.call<void>('addToCollection', c, a); }
  removeFromCollection(c: string, a: string) { return this.call<void>('removeFromCollection', c, a); }
  collectionAssets(c: string) { return this.call<LibraryAsset[]>('collectionAssets', c); }
  convertAsset(id: string, o: ConvertOptions) { return this.call<ConvertResult>('convertAsset', id, o); }
  converterTools() { return this.call<ConverterToolsDto>('converterTools'); }
  exportAssets(r: Record<string, unknown>) { return this.call<ExportResult>('exportAssets', r); }
  resolveExportConflicts(r: Record<string, unknown>, d: string) { return this.call<void>('resolveExportConflicts', r, d); }
  onExportConflicts(cb: (ev: { conflicts: { intendedPath: string; existingSize: number; newSize: number }[] }) => void) {
    return this.subscribeSse('export-conflicts', cb as never);
  }
  listProjects() { return this.call<GameProject[]>('listProjects'); }
  saveProject(p: Record<string, unknown>) { return this.call<GameProject>('saveProject', p); }
  deleteProject(id: string) { return this.call<void>('deleteProject', id); }
  attributionFor(ids: string[]) { return this.call<AttributionDoc>('attributionFor', ids); }
  attributionForCollection(id: string) { return this.call<AttributionDoc>('attributionForCollection', id); }
  writeAttributionFiles(ids: string[], dir: string) { return this.call<string[]>('writeAttributionFiles', ids, dir); }
  getConfig() { return this.call<AppConfig>('getConfig'); }
  updateConfig(p: Partial<AppConfig>) { return this.call<AppConfig>('updateConfig', p); }
  setApiKey(p: string, k: string) { return this.call<void>('setApiKey', p, k); }
  hasApiKey(p: string) { return this.call<boolean>('hasApiKey', p); }
  secretBackend() { return this.call<string>('secretBackend'); }
  backupDatabase() { return this.call<string>('backupDatabase'); }
  openExternal(u: string) { return this.call<void>('openExternal', u); }
  async pickFile(): Promise<string | null> { return this.call<string | null>('pickFile'); }
  async pickDirectory(): Promise<string | null> { return this.call<string | null>('pickDirectory'); }
  async readAssetFile(id: string): Promise<ArrayBuffer | null> {
    const res = await fetch(`/api/assets/${id}/file`);
    if (!res.ok) return null;
    return res.arrayBuffer();
  }
  async readPreview(id: string): Promise<string | null> {
    const res = await fetch(`/api/assets/${id}/preview`);
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  private subscribeSse<T>(event: string, cb: (ev: T) => void): () => void {
    const es = new EventSource('/api/events');
    es.addEventListener(event, (e) => { try { cb(JSON.parse((e as MessageEvent).data)); } catch { /* ignore */ } });
    es.onerror = () => { /* auto-reconnect by browser */ };
    return () => es.close();
  }
}

export function createApi(): ClientApi {
  if (window.hubBridge) return new ElectronApi(window.hubBridge);
  return new HttpApi();
}

export const api = createApi();
