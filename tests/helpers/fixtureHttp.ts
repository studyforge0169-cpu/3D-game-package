/** Test helpers: fixture-backed HttpClient + a real local HTTP file server. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import type {
  DownloadHttpOpts, DownloadHttpResult, HttpRequestOpts, HttpClientLike,
} from '../../src/core/types';

export const FIXTURES = path.join(__dirname, '..', 'fixtures');

export function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/**
 * Serves recorded fixture payloads for provider URLs, so provider code paths
 * run exactly as in production without network access.
 */
export class FixtureHttpClient implements HttpClientLike {
  readonly requests: { url: string; headers?: Record<string, string> }[] = [];

  private mapUrl(url: string): { body: string | Buffer; headers?: Record<string, string> } | null {
    const u = url.toLowerCase();
    if (u.includes('api.polyhaven.com/assets')) {
      return { body: loadFixture('polyhaven_assets.json') };
    }
    if (u.includes('api.polyhaven.com/files/')) {
      return { body: loadFixture('polyhaven_files.json') };
    }
    if (u.includes('ambientcg.com/api/v2/full_json')) {
      return { body: loadFixture('ambientcg_full_json.json') };
    }
    if (u.includes('ambientcg.com/api/v2/downloads_csv')) {
      return { body: loadFixture('ambientcg_downloads_csv.txt'), headers: { 'content-type': 'text/csv' } };
    }
    if (u.includes('api.sketchfab.com/v3/search')) {
      return { body: loadFixture('sketchfab_search.json') };
    }
    if (u.includes('api.sketchfab.com/v3/models/')) {
      const doc = JSON.parse(loadFixture('sketchfab_search.json'));
      return { body: JSON.stringify(doc.results[0]) };
    }
    if (u.includes('api.poly.pizza/v1')) {
      if (!this.lastKey) throw new Error('401 missing API key (poly.pizza requires X-API-Key)');
      return { body: loadFixture('polypizza_search.json') };
    }
    if (u.includes('blenderkit.com/api/v1/search')) {
      return { body: loadFixture('blenderkit_search.json') };
    }
    if (u.includes('opengameart.org/content/')) {
      return { body: loadFixture('oga_content.html'), headers: { 'content-type': 'text/html' } };
    }
    if (u.includes('opengameart.org/robots.txt')) {
      return { body: 'User-agent: *\nCrawl-delay: 10\nDisallow: /search/\n' };
    }
    return null;
  }

  lastKey?: string;

  async getJson<T>(url: string, opts?: HttpRequestOpts): Promise<T> {
    this.requests.push({ url, headers: opts?.headers });
    if (url.includes('api.poly.pizza')) this.lastKey = opts?.headers?.['X-API-Key'];
    const hit = this.mapUrl(url);
    if (!hit) throw new Error(`no fixture for ${url}`);
    return JSON.parse(String(hit.body)) as T;
  }

  async getText(url: string, opts?: HttpRequestOpts): Promise<string> {
    this.requests.push({ url, headers: opts?.headers });
    const hit = this.mapUrl(url);
    if (!hit) throw new Error(`no fixture for ${url}`);
    return String(hit.body);
  }

  async download(opts: DownloadHttpOpts): Promise<DownloadHttpResult> {
    this.requests.push({ url: opts.url });
    // Downloads in tests are served by a LocalFileServer URL; if not, write a stub.
    if (!opts.url.startsWith('http://127.0.0.1')) {
      fs.writeFileSync(opts.destPath, Buffer.from(`stub:${opts.url}`));
      opts.onProgress?.(9, 9);
      return { bytes: 9, statusCode: 200, finalUrl: opts.url, contentType: 'application/octet-stream' };
    }
    throw new Error('use LocalFileServer for downloads in tests');
  }
}

// ------------------------------------------------------------ local server

export interface LocalFileServer {
  url: string;
  setFile(pathname: string, buf: Buffer, opts?: { etag?: string; supportRanges?: boolean }): void;
  hitCount(pathname: string): number;
  close(): Promise<void>;
}

/** A real HTTP server on 127.0.0.1 for download-manager tests (Range, resume). */
export async function startLocalFileServer(): Promise<LocalFileServer> {
  const files = new Map<string, { buf: Buffer; etag?: string; ranges?: boolean }>();
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    const f = files.get(pathname);
    if (!f) { res.writeHead(404); res.end('not found'); return; }
    const range = req.headers.range;
    if (range && f.ranges !== false) {
      const m = /bytes=(\d+)-(\d*)/.exec(String(range));
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : f.buf.length - 1;
        if (start >= f.buf.length) { res.writeHead(416); res.end(); return; }
        const slice = f.buf.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${end}/${f.buf.length}`,
          'accept-ranges': 'bytes',
        });
        res.end(slice);
        return;
      }
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(f.buf.length),
      'accept-ranges': 'bytes',
      ...(f.etag ? { etag: f.etag } : {}),
    });
    res.end(f.buf);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as import('node:net').AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    setFile(pathname, buf, opts) { files.set(pathname, { buf, ...opts }); },
    hitCount(pathname) { return hits.get(pathname) ?? 0; },
    close() { return new Promise((r) => server.close(() => r())); },
  };
}
