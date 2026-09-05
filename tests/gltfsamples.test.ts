/**
 * Khronos glTF Samples provider tests — fully offline via recorded GitHub API
 * fixtures (Contents API base64 wrappers, dir listings, Git Blobs API).
 * Covers the per-asset license gate: CC0 ✓, mixed CC-BY + CC-BY-NC ⇒
 * non-redistributable, "None" ⇒ unknown.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FixtureHttpClient } from './helpers/fixtureHttp';
import { GlTFSamplesProvider, gitBlobSha1 } from '../src/core/providers/gltfsamples';
import { createProviders, isRealProvider } from '../src/core/providers/registry';
import { sha256Buffer } from '../src/core/util/hash';

const http = new FixtureHttpClient();

describe('gltfsamples: provider registration', () => {
  it('is a first-class real provider', () => {
    const providers = createProviders(http, { includeMock: true });
    expect(providers.has('gltfsamples')).toBe(true);
    expect(isRealProvider('gltfsamples')).toBe(true);
    const p = providers.get('gltfsamples')!;
    expect(p.info.capabilities.download).toBe(true);
    expect(p.info.capabilities.perAssetLicense).toBe(true);
  });
});

describe('gltfsamples: per-asset license gate (real legal metadata shapes)', () => {
  it('CC0 model resolves redistributable', async () => {
    const p = new GlTFSamplesProvider(http);
    const lic = await p.getLicense('Avocado');
    expect(lic.id).toBe('CC0-1.0');
    expect(lic.unknown).toBe(false);
    expect(lic.redistribution).toBe('allowed');
    expect(lic.commercialUse).toBe('allowed');
    expect(lic.attributionRequired).toBe(false);
  });

  it('mixed CC-BY + CC-BY-NC components ⇒ most restrictive wins (NOT redistributable)', async () => {
    const p = new GlTFSamplesProvider(http);
    const lic = await p.getLicense('DamagedHelmet');
    expect(lic.id).toBe('CC-BY-NC-4.0');
    expect(lic.redistribution).not.toBe('allowed'); // mirror gate must skip this
    expect(lic.unknown).toBe(false);
  });

  it('"None" license ⇒ unknown, never guessed', async () => {
    const p = new GlTFSamplesProvider(http);
    const lic = await p.getLicense('Duck');
    expect(lic.unknown).toBe(true);
  });

  it('search returns page licenses (CC0 visible in results)', async () => {
    const p = new GlTFSamplesProvider(http);
    const page = await p.search({ text: 'avocado', page: 1, perPage: 10 });
    expect(page.total).toBe(1);
    expect(page.results[0].license.id).toBe('CC0-1.0');
    expect(page.results[0].formats).toContain('glb');
    expect(page.results[0].assetUrl).toContain('github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Avocado');
  });
});

describe('gltfsamples: download options + verified blob downloads', () => {
  it('offers a single-file GLB and a multi-file glTF package with includes', async () => {
    const p = new GlTFSamplesProvider(http);
    const options = await p.getDownloadOptions('Avocado');
    const glb = options.find((o) => o.format === 'glb')!;
    expect(glb.sizeBytes).toBeGreaterThan(0);
    expect(glb.sha1Git).toMatch(/^[0-9a-f]{40}$/);
    expect(glb.licenseId).toBe('CC0-1.0');

    const gltf = options.find((o) => o.format === 'gltf')!;
    expect(gltf.includes!.map((i) => i.path).sort()).toEqual(['Avocado.bin', 'Avocado_baseColor.png'].sort());
    for (const inc of gltf.includes!) expect(inc.sha1Git).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses options for unverified licenses', async () => {
    const p = new GlTFSamplesProvider(http);
    await expect(p.getDownloadOptions('Duck')).rejects.toThrow(/license.*could not be verified/i);
  });

  it('downloads a blob, verifies the git sha1, returns sha256', async () => {
    const p = new GlTFSamplesProvider(http);
    const options = await p.getDownloadOptions('Avocado');
    const glb = options.find((o) => o.format === 'glb')!;
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-blob-')), 'Avocado.glb');
    const res = await p.download(glb, { destDir: path.dirname(tmp), destPath: tmp });
    expect(res.ok).toBe(true);
    const buf = fs.readFileSync(tmp);
    expect(gitBlobSha1(buf)).toBe(glb.sha1Git); // GitHub-native integrity
    expect(res.sha256).toBe(sha256Buffer(buf));
  });

  it('detects corruption via git blob sha1 (HASH_MISMATCH)', async () => {
    const p = new GlTFSamplesProvider(http);
    const options = await p.getDownloadOptions('Avocado');
    const glb = options.find((o) => o.format === 'glb')!;
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-bad-')), 'x.glb');
    const res = await p.download({ ...glb, sha1Git: '0'.repeat(40) }, { destDir: path.dirname(tmp), destPath: tmp });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('HASH_MISMATCH');
  });

  it('gitBlobSha1 matches the documented git blob hash format', () => {
    // sha1("blob 5\0hello") via git hash-object — cross-checked with `git hash-object`
    expect(gitBlobSha1(Buffer.from('hello'))).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  });
});
