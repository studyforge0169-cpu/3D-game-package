import { describe, expect, it } from 'vitest';
import { FixtureHttpClient } from './helpers/fixtureHttp';
import { PolyHavenProvider } from '../src/core/providers/polyhaven';
import { AmbientCGProvider } from '../src/core/providers/ambientcg';
import { SketchfabProvider } from '../src/core/providers/sketchfab';
import { PolyPizzaProvider } from '../src/core/providers/polypizza';
import { BlenderKitProvider } from '../src/core/providers/blenderkit';
import { OpenGameArtProvider } from '../src/core/providers/opengameart';
import { ManualProvider, MANUAL_SOURCES } from '../src/core/providers/manual';
import { MockProvider } from '../src/core/providers/mock';
import { createProviders, PROVIDER_IDS } from '../src/core/providers/registry';

describe('provider discovery', () => {
  it('registers exactly the 16 real sources (+mock when requested)', () => {
    const providers = createProviders(new FixtureHttpClient(), { includeMock: true });
    for (const id of PROVIDER_IDS) expect(providers.has(id), id).toBe(true);
    expect(providers.has('mock')).toBe(true);
    const plain = createProviders(new FixtureHttpClient());
    expect(plain.has('mock')).toBe(false);
    expect(plain.size).toBe(16);
  });

  it('every provider declares a tier consistent with its capabilities', () => {
    for (const p of createProviders(new FixtureHttpClient()).values()) {
      expect(p.info.legalNote.length, p.info.id).toBeGreaterThan(20);
      if (p.info.tier === 'manual') {
        expect(p.info.capabilities.search, p.info.id).toBe(false);
        expect(p.info.capabilities.download, p.info.id).toBe(false);
      }
      if (p.info.tier === 'full') {
        expect(p.info.capabilities.search, p.info.id).toBe(true);
      }
    }
  });
});

describe('Poly Haven provider (fixtures from official API docs)', () => {
  const http = new FixtureHttpClient();
  const p = new PolyHavenProvider(http);

  it('searches models/textures/hdris with local filtering (official add-on technique)', async () => {
    const page = await p.search({ text: 'football', filters: { kind: 'model' } });
    expect(page.results).toHaveLength(1);
    expect(page.results[0].name).toBe('Dirty Football');
    expect(page.results[0].license.id).toBe('CC0-1.0');
    expect(page.results[0].polyCount).toBe(37486);
    expect(page.results[0].free).toBe(true);
  });

  it('kind filter maps HDRI/textures correctly', async () => {
    const hdris = await p.search({ text: 'sunset', filters: { kind: 'hdri' } });
    expect(hdris.results[0].name).toBe('Joburg Central Sunset');
    const tex = await p.search({ text: 'concrete', filters: { kind: 'texture' } });
    expect(tex.results[0].textureResolution).toBe(8192);
  });

  it('returns official download options with md5 checksums', async () => {
    const options = await p.getDownloadOptions('sunset_jhbcentral');
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.md5 && o.md5.length === 32)).toBe(true);
    expect(options.every((o) => o.licenseId === 'CC0-1.0')).toBe(true);
  });

  it('builds the official site search URL', () => {
    expect(p.buildSearchUrl({ text: 'castle', filters: { kind: 'model' } })).toContain('polyhaven.com/models');
  });
});

describe('AmbientCG provider (fixtures from official API v2 docs)', () => {
  const p = new AmbientCGProvider(new FixtureHttpClient());

  it('parses full_json results with per-asset data', async () => {
    const page = await p.search({ text: 'paving' });
    expect(page.results.length).toBeGreaterThan(0);
    const first = page.results.find((r) => r.name.includes('Paving'))!;
    expect(first.license.id).toBe('CC0-1.0');
    expect(first.kind).toBe('material');
    expect(first.textureResolution).toBeGreaterThan(0);
  });

  it('exposes official download links returned by the API', async () => {
    const options = await p.getDownloadOptions('PavingStones070');
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0].url).toContain('PavingStones070');
  });
});

describe('Sketchfab provider (documented schema)', () => {
  const p = new SketchfabProvider(new FixtureHttpClient());

  it('maps per-asset licenses from the license object', async () => {
    const page = await p.search({ text: 'tree' });
    const cc0 = page.results.find((r) => r.name === 'Low Poly Tree')!;
    const by = page.results.find((r) => r.name === 'Zombie Rigged Animated')!;
    expect(cc0.license.id).toBe('CC0-1.0');
    expect(by.license.id).toBe('CC-BY-4.0');
    expect(by.animated).toBe(true);
    expect(by.rigged).toBe(true);
  });

  it('without a token only offers the official browser flow', async () => {
    const options = await p.getDownloadOptions('f8c3de3a-3f66-4a7e-9f2a-testtest1', undefined);
    expect(options).toHaveLength(1);
    expect(options[0].requiresAuth).toBe(true);
  });

  it('download without token fails with AUTH_REQUIRED, never scrapes', async () => {
    const res = await p.download(
      { id: 'sf:x:glb', label: 'GLB', format: 'glb', url: 'https://sketchfab.com/3d-models/x', licenseId: 'CC0-1.0', requiresAuth: true },
      { destDir: '/tmp', destPath: '/tmp/x' },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('AUTH_REQUIRED');
    expect(res.error).toContain('API token');
  });
});

describe('Poly Pizza provider (documented schema)', () => {
  it('requires the user key and passes it in the documented header', async () => {
    const http = new FixtureHttpClient();
    const p = new PolyPizzaProvider(http);
    await expect(p.search({ text: 'tree' })).rejects.toThrow(/API key/i);
    const page = await p.search({ text: 'tree' }, 'test-key-123');
    expect(http.lastKey).toBe('test-key-123');
    expect(page.results.length).toBe(2);
    const cc0 = page.results.find((r) => r.name === 'Low Poly Tree')!;
    const by = page.results.find((r) => r.name === 'Castle Kit')!;
    expect(cc0.license.id).toBe('CC0-1.0');
    expect(by.license.id).toBe('CC-BY-4.0');
    expect(by.creator).toBe('Kenney');
  });
});

describe('BlenderKit provider (public API v1)', () => {
  const p = new BlenderKitProvider(new FixtureHttpClient());

  it('search is public and maps cc0/royalty_free licenses', async () => {
    const page = await p.search({ text: 'pine' });
    const cc0 = page.results.find((r) => r.name === 'Pine Tree')!;
    const rf = page.results.find((r) => r.name === 'Pro Sofa Set')!;
    expect(cc0.license.id).toBe('CC0-1.0');
    expect(cc0.free).toBe(true);
    expect(rf.license.id).toBe('BLENDERKIT-RF');
    expect(rf.free).toBe(false);
  });

  it('download requires the user API key', async () => {
    const res = await p.download(
      { id: 'bk:1:blend', label: 'blend', format: 'blend', url: 'https://www.blenderkit.com/api/v1/downloads/1/', licenseId: 'CC0-1.0', requiresAuth: true },
      { destDir: '/tmp', destPath: '/tmp/x' },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('AUTH_REQUIRED');
  });
});

describe('OpenGameArt hybrid provider', () => {
  const http = new FixtureHttpClient();
  const p = new OpenGameArtProvider(http);

  it('never searches automatically — opens the browser URL instead', async () => {
    const page = await p.search({ text: 'grass' });
    expect(page.manualOnly).toBe(true);
    expect(page.results).toHaveLength(0);
    expect(page.searchUrl).toContain('opengameart.org/art-search-advanced');
  });

  it('imports a single content page and extracts the real license', async () => {
    const asset = await p.importFromUrl('https://opengameart.org/content/grass-tile-pack');
    expect(asset.name).toBe('Grass Tile Pack');
    expect(asset.license.id).toBe('CC-BY-SA-3.0');
    expect(asset.license.sourceConfirmed).toBe(true);
  });

  it('rejects non-content URLs (search pages are robots-disallowed)', async () => {
    await expect(p.importFromUrl('https://opengameart.org/art-search-advanced?keys=x')).rejects.toThrow(/content\//);
  });

  it('automated download is refused with the standard message', async () => {
    const res = await p.download({ id: 'x', label: 'x', format: 'zip', url: 'https://opengameart.org/x', licenseId: 'CC0-1.0' }, { destDir: '/tmp', destPath: '/tmp/x' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Automated access is unavailable');
  });
});

describe('manual providers', () => {
  it('all 10 manual sources refuse automation and deep-link to the site', async () => {
    expect(MANUAL_SOURCES).toHaveLength(10);
    for (const spec of MANUAL_SOURCES) {
      const p = new ManualProvider(spec, new FixtureHttpClient());
      const page = await p.search({ text: 'castle' });
      expect(page.manualOnly, spec.id).toBe(true);
      expect(page.searchUrl, spec.id).not.toContain('{q}');
      expect(page.searchUrl.startsWith('https://'), spec.id).toBe(true);
      const res = await p.download({ id: 'x', label: 'x', format: 'zip', url: 'https://x', licenseId: 'unknown' }, { destDir: '/tmp', destPath: '/tmp/x' });
      expect(res.ok, spec.id).toBe(false);
      expect(res.errorCode, spec.id).toBe('MANUAL');
    }
  });

  it('CC0 sources pre-fill the import license', async () => {
    const kenney = new ManualProvider(MANUAL_SOURCES.find((s) => s.id === 'kenney')!, new FixtureHttpClient());
    expect(kenney.siteLicenseInfo()?.id).toBe('CC0-1.0');
  });
});

describe('MockProvider', () => {
  it('exposes the fixture catalog incl. license variety and a duplicate seed', async () => {
    const p = new MockProvider(new FixtureHttpClient());
    const page = await p.search({ text: 'sword' });
    expect(page.results[0].name).toBe('Fantasy Sword');
    expect(page.results[0].license.id).toBe('CC-BY-4.0');
    const nc = await p.search({ text: 'mech' });
    expect(nc.results[0].license.commercialUse).toBe('forbidden');
    const unknown = await p.search({ text: 'mystery' });
    expect(unknown.results[0].license.unknown).toBe(true);
    const rocks = await p.search({ text: 'rock' });
    expect(rocks.results.length).toBe(2); // duplicate seed pair
  });
});
