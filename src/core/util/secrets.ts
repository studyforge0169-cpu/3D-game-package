/**
 * Secure credential storage (spec §14).
 *
 * Desktop: Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux
 * libsecret/keyring) — injected by the main process.
 * Headless/server/tests: AES-256-GCM encrypted file whose key lives in a
 * mode-0600 file next to it. This is *not* an OS keychain, so the app warns
 * the user in the UI when this fallback is active.
 *
 * API keys are never written to the database, config file or logs.
 */

import { promises as fs } from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { ensureDir, pathExists } from './fsutil';
import { rootLogger } from './logger';

const log = rootLogger.child('secrets');

export interface SecretStore {
  readonly backend: 'safeStorage' | 'encryptedFile';
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Electron-safeStorage-backed store (desktop). */
export class SafeStorageSecretStore implements SecretStore {
  readonly backend = 'safeStorage' as const;
  private readonly entries = new Map<string, Buffer>();
  constructor(private readonly file: string, private readonly safe: SafeStorageLike) {}

  private async load(): Promise<void> {
    if (this.entries.size) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) this.entries.set(k, Buffer.from(v, 'base64'));
    } catch { /* fresh */ }
  }

  private async persist(): Promise<void> {
    await ensureDir(path.dirname(this.file));
    const raw: Record<string, string> = {};
    for (const [k, v] of this.entries) raw[k] = v.toString('base64');
    await fs.writeFile(this.file, JSON.stringify(raw), { mode: 0o600 });
  }

  async get(key: string): Promise<string | null> {
    await this.load();
    const enc = this.entries.get(key);
    if (!enc) return null;
    try { return this.safe.decryptString(enc); } catch { return null; }
  }
  async set(key: string, value: string): Promise<void> {
    await this.load();
    this.entries.set(key, this.safe.encryptString(value));
    await this.persist();
  }
  async delete(key: string): Promise<void> {
    await this.load();
    this.entries.delete(key);
    await this.persist();
  }
  async list(): Promise<string[]> {
    await this.load();
    return [...this.entries.keys()];
  }
}

/** AES-256-GCM file store (server/test fallback). */
export class EncryptedFileSecretStore implements SecretStore {
  readonly backend = 'encryptedFile' as const;
  private readonly keyFile: string;
  private readonly dataFile: string;

  constructor(dir: string) {
    this.keyFile = path.join(dir, '.ugah-secret-key');
    this.dataFile = path.join(dir, '.ugah-secrets.enc');
  }

  private async getKey(): Promise<Buffer> {
    if (await pathExists(this.keyFile)) {
      return Buffer.from(await fs.readFile(this.keyFile, 'utf8'), 'hex');
    }
    const key = crypto.randomBytes(32);
    await ensureDir(path.dirname(this.keyFile));
    await fs.writeFile(this.keyFile, key.toString('hex'), { mode: 0o600 });
    return key;
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      const blob = await fs.readFile(this.dataFile);
      const key = await this.getKey();
      const iv = blob.subarray(0, 12);
      const tag = blob.subarray(blob.length - 16);
      const ct = blob.subarray(12, blob.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
    } catch { return {}; }
  }

  private async writeAll(data: Record<string, string>): Promise<void> {
    const key = await this.getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    await fs.writeFile(this.dataFile, Buffer.concat([iv, ct, cipher.getAuthTag()]), { mode: 0o600 });
  }

  async get(key: string): Promise<string | null> {
    return (await this.readAll())[key] ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    const all = await this.readAll();
    all[key] = value;
    await this.writeAll(all);
  }
  async delete(key: string): Promise<void> {
    const all = await this.readAll();
    delete all[key];
    await this.writeAll(all);
  }
  async list(): Promise<string[]> {
    return Object.keys(await this.readAll());
  }
}

export function createSecretStore(dir: string, safeStorage?: SafeStorageLike): SecretStore {
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    log.info('secret store: OS secure storage (safeStorage)');
    return new SafeStorageSecretStore(path.join(dir, 'credentials.bin'), safeStorage);
  }
  if (safeStorage) log.warn('safeStorage present but encryption unavailable — using encrypted file fallback');
  else log.warn('no OS keychain available (server mode) — using encrypted file fallback');
  return new EncryptedFileSecretStore(dir);
}

/** Well-known credential keys used by providers. */
export const SECRET_KEYS = {
  sketchfabToken: 'sketchfab.apiToken',
  polyPizzaKey: 'polypizza.apiKey',
  blenderKitKey: 'blenderkit.apiKey',
} as const;
export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS];
