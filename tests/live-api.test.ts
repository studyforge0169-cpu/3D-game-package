/**
 * Live API verification — OPT-IN only.
 *
 * These tests hit the real public APIs (Poly Haven, AmbientCG, Sketchfab) and
 * are therefore excluded from the default offline suite. Run with:
 *
 *   npm run test:live     (sets UGAH_RUN_LIVE_TESTS=1)
 *
 * Rules honored here: only official documented endpoints, only anonymous /
 * public data, only search+metadata (no downloads), low request volume,
 * per-test timeouts. If a provider is temporarily down the test fails —
 * that is the point: it verifies our integration contract with reality.
 */
import { describe, it, expect } from 'vitest';
import { PolyHavenProvider } from '../src/core/providers/polyhaven';
import { AmbientCGProvider } from '../src/core/providers/ambientcg';
import { SketchfabProvider } from '../src/core/providers/sketchfab';

const RUN = process.env.UGAH_RUN_LIVE_TESTS === '1';

describe.skipIf(!RUN)('live API verification', () => {
  it(
    'polyhaven: search returns real assets with licenses + official download URLs',
    async () => {
      const p = new PolyHavenProvider(makeHttp());
      const page = await p.search({ text: 'forest', limit: 5 });
      expect(page.results.length).toBeGreaterThan(0);
      for (const a of page.results) {
        expect(a.id).toBeTruthy();
        expect(a.name).toBeTruthy();
        expect(a.license.id).toMatch(/^CC-/); // Poly Haven is site-wide CC0/CC-BY
        expect(a.sourceUrl).toContain('polyhaven.com');
      }
      const full = await p.getAsset(page.results[0].id);
      expect(full.license.id).toMatch(/^CC-/);
      expect(full.license.url ?? '').toContain('creativecommons.org');
      const dl = await p.getDownloadOptions(full.id);
      expect(dl.length).toBeGreaterThan(0);
      expect(dl[0].url).toContain('polyhaven.com');
    },
    { timeout: 30_000 },
  );

  it(
    'ambientcg: search returns real assets with per-asset licenses',
    async () => {
      const p = new AmbientCGProvider(makeHttp());
      const page = await p.search({ text: 'brick', limit: 5 });
      expect(page.results.length).toBeGreaterThan(0);
      for (const a of page.results) {
        expect(a.license.id).toBeTruthy();
      }
      const full = await p.getAsset(page.results[0].id);
      expect(full.license.url ?? '').toContain('creativecommons.org');
      const dl = await p.getDownloadOptions(full.id);
      expect(dl.some((d) => d.format === 'zip')).toBe(true);
    },
    { timeout: 30_000 },
  );

  it(
    'sketchfab: anonymous search works; downloads honestly require a token',
    async () => {
      const p = new SketchfabProvider(makeHttp());
      const page = await p.search({ text: 'medieval castle', limit: 5 });
      expect(page.results.length).toBeGreaterThan(0);
      expect(page.results[0].license?.id ?? 'unknown').toBeTruthy();
      // No token configured → downloads must refuse, never fake a URL.
      await expect(p.getDownloadOptions(page.results[0].id)).rejects.toThrow(
        /token|api key|configure/i,
      );
    },
    { timeout: 30_000 },
  );
});

/** Minimal HttpClientLike over global fetch with a sane timeout + UA. */
import type { HttpClientLike } from '../src/core/types';
function makeHttp(): HttpClientLike {
  const base = 'UniversalGameAssetHub-live-test/1.0 (+https://github.com)';
  return {
    async getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T> {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15_000);
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': base, accept: 'application/json', ...headers },
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return (await res.json()) as T;
      } finally {
        clearTimeout(t);
      }
    },
  } as HttpClientLike;
}
