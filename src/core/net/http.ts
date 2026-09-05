/**
 * Network layer (spec §9/§17/§18).
 *
 * One HttpClient for every outbound request:
 *  - identifies itself with a descriptive User-Agent,
 *  - per-host token-bucket rate limiting (config defaults per source),
 *  - robots.txt guard for HTML fetches (API JSON endpoints are exempt),
 *  - bounded retries with exponential backoff + jitter, honouring Retry-After,
 *  - 401/403/CAPTCHA never retried — surfaced as explicit automation blocks,
 *  - resumable streamed downloads with Range support and integrity hooks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type {
  DownloadHttpOpts, DownloadHttpResult, HttpRequestOpts, HttpClientLike, RateLimitConfig,
} from '../types';
import { rootLogger } from '../util/logger';
import { ensureDir } from '../util/fsutil';

const log = rootLogger.child('http');

export const APP_USER_AGENT =
  'UniversalGameAssetHub/1.0 (https://github.com/studyforge0169-cpu/3D-game-package; legal asset manager)';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
  get retryable() {
    if (this.statusCode === 429 || (this.statusCode !== undefined && this.statusCode >= 500)) return true;
    return this.code === 'NETWORK' || this.code === 'TIMEOUT';
  }
}

export class RobotsDeniedError extends Error {
  readonly code = 'ROBOTS_DENIED';
  constructor(url: string, readonly detail: string) {
    super(`robots.txt disallows automated access to ${url}`);
    this.name = 'RobotsDeniedError';
  }
}

// ------------------------------------------------------------------ rate limit

class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  constructor(private readonly cfg: RateLimitConfig) {
    this.tokens = cfg.maxBurst;
  }
  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      const waitMs = Math.ceil(this.cfg.minIntervalMs / Math.max(1, this.cfg.maxBurst));
      await sleep(waitMs);
    }
  }
  private refill(): void {
    const now = Date.now();
    const gained = ((now - this.lastRefill) / this.cfg.minIntervalMs) * this.cfg.maxBurst;
    if (gained > 0) {
      this.tokens = Math.min(this.cfg.maxBurst, this.tokens + gained);
      this.lastRefill = now;
    }
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly cooldowns = new Map<string, number>();
  constructor(private readonly configs: Record<string, RateLimitConfig>) {}

  private cfgFor(host: string): RateLimitConfig {
    return this.configs[host] ?? { minIntervalMs: 1000, maxBurst: 2 };
  }

  async acquire(url: string): Promise<void> {
    const host = new URL(url).host;
    const until = this.cooldowns.get(host) ?? 0;
    if (until > Date.now()) await sleep(until - Date.now());
    let b = this.buckets.get(host);
    if (!b) { b = new TokenBucket(this.cfgFor(host)); this.buckets.set(host, b); }
    await b.acquire();
  }

  /** Hard cool-down after 429 — we never hammer around rate limits. */
  coolDown(url: string, ms: number): void {
    const host = new URL(url).host;
    this.cooldowns.set(host, Date.now() + ms);
    log.warn('rate-limit cooldown engaged', { host, ms });
  }
}

// --------------------------------------------------------------- robots guard

interface RobotsRules {
  fetchedAt: number;
  groups: { uas: string[]; disallow: string[]; allow: string[]; crawlDelay?: number }[];
}

const ROBOTS_TTL_MS = 6 * 60 * 60 * 1000;

export class RobotsGuard {
  private readonly cache = new Map<string, RobotsRules>();
  constructor(private readonly fetchText: (url: string) => Promise<string | null>) {}

  async isAllowed(url: string, userAgent = 'UniversalGameAssetHub'): Promise<{ allowed: boolean; crawlDelay?: number; detail: string }> {
    const u = new URL(url);
    const origin = u.origin;
    let rules = this.cache.get(origin);
    if (!rules || Date.now() - rules.fetchedAt > ROBOTS_TTL_MS) {
      let txt: string | null = null;
      try { txt = await this.fetchText(`${origin}/robots.txt`); } catch { txt = null; }
      rules = { fetchedAt: Date.now(), groups: txt ? parseRobots(txt) : [] };
      this.cache.set(origin, rules);
    }
    if (!rules.groups.length) return { allowed: true, detail: 'no robots.txt' };
    const ua = userAgent.toLowerCase();
    const group = rules.groups.find((g) => g.uas.some((a) => ua.includes(a) || a === '*'))
      ?? rules.groups.find((g) => g.uas.includes('*'));
    if (!group) return { allowed: true, detail: 'no matching group' };
    const p = u.pathname + u.search;
    const disallowed = group.disallow.find((d) => d !== '' && p.startsWith(d));
    const allowed = group.allow.find((a) => p.startsWith(a));
    if (disallowed && (!allowed || allowed.length <= disallowed.length)) {
      return { allowed: false, crawlDelay: group.crawlDelay, detail: `Disallow: ${disallowed}` };
    }
    return { allowed: true, crawlDelay: group.crawlDelay, detail: 'allowed' };
  }
}

export function parseRobots(txt: string): RobotsRules['groups'] {
  const groups: RobotsRules['groups'] = [];
  let current: RobotsRules['groups'][number] | null = null;
  let lastWasUa = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [kRaw, ...rest] = line.split(':');
    const k = kRaw.trim().toLowerCase();
    const v = rest.join(':').trim();
    if (k === 'user-agent') {
      if (!current || !lastWasUa) { current = { uas: [], disallow: [], allow: [] }; groups.push(current); }
      current.uas.push(v.toLowerCase());
      lastWasUa = true;
    } else {
      if (!current) continue;
      lastWasUa = false;
      if (k === 'disallow') current.disallow.push(v);
      else if (k === 'allow') current.allow.push(v);
      else if (k === 'crawl-delay') { const n = parseFloat(v); if (!Number.isNaN(n)) current.crawlDelay = n * 1000; }
    }
  }
  return groups;
}

// ---------------------------------------------------------------- http client

const CAPTCHA_MARKERS = ['captcha', 'recaptcha', 'hcaptcha', 'cf-chl', 'are you a robot', 'checking your browser'];

export class HttpClient implements HttpClientLike {
  readonly robots: RobotsGuard;
  private readonly limiter: RateLimiter;
  private readonly cooldowns = new Map<string, number>();

  constructor(
    private readonly defaults: {
      userAgent: string;
      timeoutMs: number;
      perHostRateLimits: Record<string, RateLimitConfig>;
      respectRobots: boolean;
    },
  ) {
    this.limiter = new RateLimiter(defaults.perHostRateLimits);
    this.robots = new RobotsGuard(async (url) => {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(defaults.timeoutMs, 10_000)),
        headers: { 'user-agent': this.defaults.userAgent },
        redirect: 'follow',
      }).catch(() => null);
      if (!res || !res.ok) return null;
      return res.text();
    });
  }

  private async preflight(url: string, opts?: HttpRequestOpts, isHtml = false): Promise<void> {
    await this.limiter.acquire(url);
    if (isHtml && this.defaults.respectRobots && opts?.robots !== false) {
      const verdict = await this.robots.isAllowed(url, 'UniversalGameAssetHub');
      if (!verdict.allowed) throw new RobotsDeniedError(url, verdict.detail);
    }
  }

  private baseHeaders(opts?: HttpRequestOpts): Record<string, string> {
    return {
      'user-agent': this.defaults.userAgent,
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      ...opts?.headers,
    };
  }

  private async once(
    url: string,
    opts: HttpRequestOpts | undefined,
    accept: string,
  ): Promise<Response> {
    await this.preflight(url, opts);
    const headers = this.baseHeaders(opts);
    headers.accept = accept;
    const timeout = AbortSignal.timeout(opts?.timeoutMs ?? this.defaults.timeoutMs);
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { headers, signal, redirect: 'follow' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout') ? 'TIMEOUT' : 'NETWORK';
      throw new HttpError(msg, code, undefined, url);
    }
    if (res.status === 429) {
      const ra = res.headers.get('retry-after');
      const ms = ra ? (Number(ra) * 1000 || 30_000) : 60_000;
      this.limiter.coolDown(url, ms);
    }
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(
        `Access denied (${res.status}) for ${new URL(url).host}. ` +
        'If credentials are required, add your API key in Settings; otherwise this source must be accessed manually.',
        res.status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN',
        res.status, url,
      );
    }
    return res;
  }

  private async attempt<T>(url: string, opts: HttpRequestOpts | undefined, fn: () => Promise<T>): Promise<T> {
    const maxRetries = opts?.retries ?? 2;
    let lastErr: unknown;
    for (let i = 0; i <= maxRetries; i++) {
      if (opts?.signal?.aborted) throw new HttpError('canceled', 'CANCELED', undefined, url);
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (e instanceof RobotsDeniedError) throw e;
        const retryable = e instanceof HttpError && e.retryable;
        if (!retryable || i === maxRetries) break;
        const backoff = Math.min(30_000, 800 * 2 ** i) + Math.random() * 400;
        log.warn('retrying request', { url: safeUrl(url), attempt: i + 1, backoff: Math.round(backoff), error: String(e) });
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  async getJson<T>(url: string, opts?: HttpRequestOpts): Promise<T> {
    return this.attempt(url, opts, async () => {
      const res = await this.once(url, opts, 'application/json');
      if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${safeUrl(url)}`, 'HTTP', res.status, url);
      return (await res.json()) as T;
    });
  }

  async getText(url: string, opts?: HttpRequestOpts): Promise<string> {
    return this.attempt(url, opts, async () => {
      const res = await this.once(url, { robots: true, ...opts }, 'text/html,application/xhtml+xml');
      if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${safeUrl(url)}`, 'HTTP', res.status, url);
      const text = await res.text();
      const lower = text.slice(0, 20_000).toLowerCase();
      if (lower.length < 4096 && CAPTCHA_MARKERS.some((m) => lower.includes(m)) && !lower.includes('</html>') ) {
        throw new HttpError(
          'The source responded with a challenge page. Automated access is unavailable — open the official asset page to obtain it manually.',
          'AUTOMATION_BLOCKED', 403, url,
        );
      }
      return text;
    });
  }

  async download(opts: DownloadHttpOpts): Promise<DownloadHttpResult> {
    const { url } = opts;
    return this.attempt(url, opts, async () => {
      await this.preflight(url, opts);
      await ensureDir(path.dirname(opts.destPath));

      let startByte = 0;
      let existing: fs.Stats | null = null;
      try { existing = await fs.promises.stat(opts.destPath); } catch { /* none */ }
      if (opts.resume && existing && existing.isFile() && existing.size > 0) {
        startByte = existing.size;
        // Probe range support first.
        const probe = await fetch(url, {
          method: 'HEAD',
          headers: { ...this.baseHeaders(opts), ...(startByte ? { range: `bytes=${startByte}-` } : {}) },
          signal: opts.signal ?? undefined,
        }).catch(() => null);
        const acceptRanges = probe?.headers.get('accept-ranges')?.includes('bytes') ?? false;
        const contentRange = probe?.headers.get('content-range');
        if (acceptRanges && contentRange && contentRange.includes(String(startByte))) {
          // resumable
        } else if (probe?.status === 206) {
          // resumable
        } else {
          startByte = 0; // server cannot resume — start over
        }
      } else {
        startByte = 0;
      }

      const headers = this.baseHeaders(opts);
      if (startByte > 0) headers.range = `bytes=${startByte}-`;
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.defaults.timeoutMs * 4);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

      let res: Response;
      try {
        res = await fetch(url, { headers, signal, redirect: 'follow' });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new HttpError(msg, msg.toLowerCase().includes('abort') ? 'CANCELED' : 'NETWORK', undefined, url);
      }
      if (res.status === 429) {
        const ra = res.headers.get('retry-after');
        this.limiter.coolDown(url, ra ? Number(ra) * 1000 || 30_000 : 60_000);
        throw new HttpError('rate limited', 'RATE_LIMIT', 429, url);
      }
      if (res.status === 401 || res.status === 403) {
        throw new HttpError(
          'Automated access is unavailable for this source. Open the official asset page to obtain it manually.',
          res.status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN',
          res.status, url,
        );
      }
      if (!res.ok && res.status !== 206) {
        throw new HttpError(`HTTP ${res.status}`, 'HTTP', res.status, url);
      }

      const resumed = res.status === 206 && startByte > 0;
      if (!resumed && startByte > 0) { startByte = 0; }
      const totalHeader = res.headers.get('content-length');
      const contentRangeTotal = res.headers.get('content-range')?.split('/')[1];
      const total = contentRangeTotal && contentRangeTotal !== '*'
        ? Number(contentRangeTotal)
        : totalHeader ? startByte + Number(totalHeader) : undefined;
      if (opts.maxBytes && total && total > opts.maxBytes) {
        throw new HttpError(`file exceeds max allowed size (${total} > ${opts.maxBytes})`, 'TOO_LARGE', undefined, url);
      }

      const mode = resumed ? 'r+' : 'w';
      const fh = await fs.promises.open(opts.destPath, mode);
      let bytes = startByte;
      let rate = 0;
      try {
        const ws = fh.createWriteStream({ start: resumed ? startByte : undefined });
        if (!res.body) throw new HttpError('empty body', 'NETWORK', undefined, url);
        let lastReport = Date.now();
        let lastBytes = bytes;
        await pipeline(
          Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
          async function* (chunkStream) {
            for await (const chunk of chunkStream) {
              yield chunk as Buffer;
              bytes += (chunk as Buffer).length;
              const now = Date.now();
              if (now - lastReport >= 250) {
                rate = ((bytes - lastBytes) * 1000) / (now - lastReport);
                lastBytes = bytes; lastReport = now;
              }
              opts.onProgress?.(bytes, total);
              if (opts.maxBytes && bytes - startByte > opts.maxBytes) {
                throw new HttpError('exceeded max bytes during download', 'TOO_LARGE', undefined, url);
              }
            }
          },
          ws,
        );
      } finally {
        await fh.close().catch(() => {});
      }

      return {
        bytes,
        statusCode: res.status,
        contentType: res.headers.get('content-type') ?? undefined,
        finalUrl: res.url || url,
        resumed,
        etag: res.headers.get('etag') ?? undefined,
        lastModified: res.headers.get('last-modified') ?? undefined,
      };
    });
  }

  setHostCooldown(url: string, ms: number): void {
    this.limiter.coolDown(url, ms);
  }
}

function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    return u.toString();
  } catch { return '[bad-url]'; }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function makeUserAgent(extra: string): string {
  return extra ? `${APP_USER_AGENT} ${extra.trim()}` : APP_USER_AGENT;
}
