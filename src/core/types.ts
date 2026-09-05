/**
 * Universal Game Asset Hub — core domain types.
 * This module is dependency-free and imported by main, server and renderer
 * (type-only) so the whole app speaks one vocabulary.
 */

// ---------------------------------------------------------------- asset kinds

export type AssetKind =
  | 'model'
  | 'texture'
  | 'material'
  | 'hdri'
  | 'audio'
  | 'animation'
  | 'vfx'
  | 'brush'
  | 'scene'
  | 'other';

/** Library folder taxonomy (spec §5). */
export const ASSET_CATEGORIES = [
  'Characters', 'Creatures', 'Weapons', 'Vehicles', 'Buildings', 'Environment',
  'Props', 'Vegetation', 'Materials', 'Textures', 'HDRIs', 'Animations', 'VFX', 'Other',
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

// ------------------------------------------------------------------- licenses

export type PermissionLevel = 'allowed' | 'conditions' | 'forbidden' | 'unknown';

/** Normalized license facts for a single asset (spec §4). */
export interface LicenseInfo {
  /** Canonical registry id, e.g. "CC0-1.0", "CC-BY-4.0", "unknown". */
  id: string;
  name: string;
  url?: string;
  commercialUse: PermissionLevel;
  attributionRequired: boolean;
  shareAlike: boolean;
  redistribution: PermissionLevel;
  modification: PermissionLevel;
  /** True when we could not establish a license — downloads are blocked. */
  unknown: boolean;
  /** Original license string/flags exactly as served by the source. */
  raw?: string;
  /** Was this confirmed from an official API/page (vs. assumed/site-wide)? */
  sourceConfirmed: boolean;
  licenseCheckedAt: string; // ISO date
}

export type LicenseBadgeTone = 'green' | 'yellow' | 'blue' | 'red' | 'black';

export interface LicenseBadge {
  tone: LicenseBadgeTone;
  label: string;
  tooltip: string;
}

// --------------------------------------------------------------------- search

export type SortKey =
  | 'relevance' | 'quality' | 'popularity' | 'polygons'
  | 'textureResolution' | 'fileSize' | 'newest';

export interface SearchFilters {
  freeOnly?: boolean;
  cc0Only?: boolean;
  commercialOnly?: boolean;
  noAttributionOnly?: boolean;
  licenses?: string[];
  formats?: string[];
  kind?: AssetKind;
  category?: AssetCategory;
  /** Topic keywords: weapon, character, vehicle, building, vegetation… */
  topics?: string[];
  maxPolyCount?: number;
  minPolyCount?: number;
  minTextureResolution?: number;
  pbrOnly?: boolean;
  riggedOnly?: boolean;
  animatedOnly?: boolean;
  maxFileSize?: number;
}

export interface SearchQuery {
  text: string;
  providers?: string[];
  page?: number;
  perPage?: number;
  filters?: SearchFilters;
  sort?: SortKey;
}

/** Lightweight asset reference — a search hit or catalog row. */
export interface AssetRef {
  /** Provider-scoped stable id. */
  id: string;
  providerId: string;
  name: string;
  creator?: string;
  description?: string;
  kind: AssetKind;
  categoryHint?: AssetCategory;
  previewUrl?: string;
  assetUrl: string;
  license: LicenseInfo;
  free: boolean;
  price?: string;
  polyCount?: number;
  textureResolution?: number;
  formats: string[];
  fileSize?: number;
  tags: string[];
  createdAt?: string;
  downloads?: number;
  views?: number;
  likes?: number;
  animated?: boolean;
  rigged?: boolean;
  pbr?: boolean;
  /** Provider-native metadata kept for detail calls. */
  raw?: Record<string, unknown>;
}

export interface SearchPage {
  providerId: string;
  results: AssetRef[];
  total?: number;
  page: number;
  hasMore?: boolean;
  error?: string;
  /** Set when provider refuses automation: UI shows open-in-browser flow. */
  manualOnly?: boolean;
  searchUrl?: string;
}

// ------------------------------------------------------------------ providers

export type ProviderTier = 'full' | 'hybrid' | 'manual';

export interface ProviderCapabilities {
  /** In-app API search. */
  search: boolean;
  /** Automated download through official endpoints. */
  download: boolean;
  /** Per-asset license from official API/page. */
  perAssetLicense: boolean;
  /** Deep-link to site search when API search is unavailable. */
  browserSearch: boolean;
  /** Single-asset import from an official content page. */
  urlImport: boolean;
  needsApiKey: boolean;
  apiKeyUrl?: string;
  apiDocsUrl?: string;
  robotsScope?: 'api' | 'html';
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  homeUrl: string;
  /** Short legal note shown in Sources page. */
  legalNote: string;
  /** Blanket site license when one exists ("CC0"), else per-asset. */
  siteLicense?: string;
  tier: ProviderTier;
  capabilities: ProviderCapabilities;
  docsUrl?: string;
}

export interface DownloadOption {
  id: string;
  label: string;
  format: string;
  sizeBytes?: number;
  url: string;
  md5?: string;
  requiresAuth?: boolean;
  licenseId: string;
  /**
   * Additional files this option needs to be complete (relative paths like
   * `model.bin`, `textures/diff.jpg`). Verified live against Poly Haven's
   * /files API: its glTF/FBX/blend/mtlx variants are multi-file packages whose
   * payload (.bin + textures) lives in an `include` tree — a single-file
   * download would be an unusable 3 KB .gltf.
   */
  includes?: DownloadInclude[];
}

export interface DownloadInclude {
  path: string;
  url: string;
  sizeBytes?: number;
  md5?: string;
}

export interface PreviewImage {
  url: string;
  width?: number;
  height?: number;
}

export type DownloadMode = 'auto' | 'browser';

/** Per-host rate limiting configuration. */
export interface RateLimitConfig {
  /** Minimum interval between requests to the same host (ms). */
  minIntervalMs: number;
  maxBurst: number;
}

export interface ProviderRuntimeCtx {
  /** Where to place downloads (asset folder Original/). */
  destDir: string;
  /** Absolute destination file path for the download. */
  destPath: string;
  /** Progress callback (bytes, totalBytes). */
  onProgress?: (bytes: number, total?: number) => void;
  /** Cancellation signal. */
  signal?: AbortSignal;
  /** Caller-supplied credential (already fetched from secure storage). */
  apiKey?: string;
  /** Optional HTTP client; providers hold their own rate-limited client. */
  http?: HttpClientLike;
}

export interface HttpClientLike {
  getJson<T>(url: string, opts?: HttpRequestOpts): Promise<T>;
  getText(url: string, opts?: HttpRequestOpts): Promise<string>;
  download(opts: DownloadHttpOpts): Promise<DownloadHttpResult>;
}

export interface HttpRequestOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Set when the URL is an HTML page (robots guard applies). */
  robots?: boolean;
  retries?: number;
}

export interface DownloadHttpOpts extends HttpRequestOpts {
  url: string;
  destPath: string;
  onProgress?: (bytes: number, total?: number) => void;
  /** Resume from an existing partial file when the server supports ranges. */
  resume?: boolean;
  maxBytes?: number;
}

export interface DownloadHttpResult {
  bytes: number;
  statusCode: number;
  contentType?: string;
  finalUrl: string;
  resumed?: boolean;
  etag?: string;
  lastModified?: string;
}

export interface DownloadResult {
  ok: boolean;
  path?: string;
  bytes: number;
  sha256?: string;
  md5?: string;
  error?: string;
  /** Human/legal error code, e.g. LICENSE_UNKNOWN_BLOCK, ROBOTS_DENIED. */
  errorCode?: string;
}

/** The provider contract (spec §13). */
export interface AssetProvider {
  readonly info: ProviderInfo;
  isConfigured(apiKey?: string): boolean;
  search(query: SearchQuery, apiKey?: string): Promise<SearchPage>;
  getAsset(id: string, apiKey?: string): Promise<AssetRef | null>;
  getLicense(id: string, apiKey?: string): Promise<LicenseInfo>;
  getDownloadOptions(id: string, apiKey?: string): Promise<DownloadOption[]>;
  getMetadata(id: string, apiKey?: string): Promise<Record<string, unknown>>;
  download(option: DownloadOption, ctx: ProviderRuntimeCtx): Promise<DownloadResult>;
  getPreviewUrls(id: string, apiKey?: string): Promise<PreviewImage[]>;
  /** URL for manual providers / fallback. */
  buildSearchUrl(query: SearchQuery): string;
  /**
   * Inverse of the asset page URL this provider generates: recover the
   * provider-scoped asset id from a stored source_url. Used by the CLI
   * `update` command to re-check licenses. null when not recoverable.
   */
  assetIdFromUrl?(url: string): string | null;
}

// ------------------------------------------------------------------ downloads

export type TaskState =
  | 'queued' | 'running' | 'paused' | 'completed'
  | 'failed' | 'canceled' | 'corrupt' | 'skipped_duplicate' | 'blocked_license';

export interface DownloadTask {
  id: string;
  providerId: string;
  assetRef: AssetRef;
  optionId: string;
  url: string;
  destPath: string;
  category: AssetCategory;
  state: TaskState;
  bytes: number;
  totalBytes?: number;
  option?: DownloadOption;
  error?: string;
  errorCode?: string;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  priority: number;
}

export interface DownloadProgressEvent {
  taskId: string;
  bytes: number;
  totalBytes?: number;
  speedBps?: number;
  state: TaskState;
}

// ------------------------------------------------------------- library records

/** Full DB record for a locally-managed asset (spec §11). */
export interface LibraryAsset {
  id: string;
  name: string;
  creator?: string;
  providerId: string;
  sourceUrl: string;
  downloadUrl?: string;
  licenseId: string;
  licenseRaw?: string;
  licenseUrl?: string;
  licenseCheckedAt: string;
  attributionText?: string;
  downloadedAt: string;
  lastUsedAt?: string;
  sha256?: string;
  md5?: string;
  format: string;
  fileSize: number;
  polyCount?: number;
  textureResolution?: number;
  category: AssetCategory;
  categoryOverride?: AssetCategory | null;
  kind: AssetKind;
  tagsJson: string;
  localPath: string;
  originalDir: string;
  processedDir?: string;
  gameReadyDir?: string;
  previewPath?: string;
  processingStatus: 'original' | 'processed' | 'game_ready' | 'failed';
  engineCompatibilityJson: string;
  currentVersion: number;
  favorite: boolean;
  animated?: boolean;
  rigged?: boolean;
  pbr?: boolean;
  geometryFingerprint?: string;
  phash?: string;
}

export interface Collection {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  coverAssetId?: string;
}

// ------------------------------------------------------------------ conversion

export interface MeshStats {
  vertices: number;
  faces: number;
  meshes: number;
  materials: number;
  hasNormals: boolean;
  hasUvs: boolean;
  hasSkeleton: boolean;
  animations: number;
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  textureFiles: { name: string; width?: number; height?: number; format: string }[];
}

export type ConvertFormat = 'glb' | 'gltf' | 'obj' | 'fbx';

export interface ConvertOptions {
  targetFormat: ConvertFormat;
  axisMode?: 'y-up' | 'z-up';
  textureResize?: { maxSize: number };
  textureCompress?: { format: 'png' | 'jpeg'; quality?: number };
  embedTextures?: boolean;
  pruneUnusedMaterials?: boolean;
  weldVertices?: boolean;
  recomputeNormals?: boolean;
  generateLods?: { levels: { ratio: number; suffix: string }[] };
  generateCollision?: 'none' | 'bbox' | 'decimated';
  decimateRatio?: number;
}

export interface ConvertResult {
  ok: boolean;
  outputs: { path: string; kind: 'model' | 'lod' | 'collision' | 'texture'; bytes: number }[];
  stats?: MeshStats;
  warnings: string[];
  error?: string;
}

// --------------------------------------------------------------------- export

export type EngineId = 'unreal' | 'unity' | 'godot' | 'blender';

export interface ExportPreset {
  id: EngineId;
  name: string;
  rootDirName: string;
  preferredFormats: string[];
  notes: string;
}

export interface ExportRequest {
  engine: EngineId;
  projectName: string;
  exportRoot: string;
  assetIds: string[];
  /** What to copy for each asset: original / gameReady / processed. */
  source: 'original' | 'gameReady' | 'processed';
  collisionPolicy: 'ask' | 'skip' | 'rename' | 'overwrite';
}

export interface ExportConflict {
  intendedPath: string;
  existingSize: number;
  newSize: number;
}

export interface ExportResult {
  ok: boolean;
  exported: { assetId: string; files: string[] }[];
  skipped: string[];
  conflicts: ExportConflict[];
  attributionFiles: string[];
  error?: string;
}

export interface GameProject {
  id: string;
  name: string;
  engine: EngineId;
  rootPath: string;
  createdAt: string;
  lastExportAt?: string;
}

// ---------------------------------------------------------------- attribution

export interface AttributionEntry {
  assetName: string;
  creator?: string;
  source: string;
  licenseId: string;
  licenseName: string;
  licenseUrl?: string;
  originalUrl: string;
  attributionText: string;
  requiresAttribution: boolean;
}

export interface AttributionDoc {
  txt: string;
  md: string;
  entries: AttributionEntry[];
  generatedAt: string;
}
