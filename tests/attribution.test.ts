import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateAttribution, entryFor } from '../src/core/attribution';
import type { LibraryAsset } from '../src/core/types';

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugah-attr-')); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function asset(over: Partial<LibraryAsset>): LibraryAsset {
  return {
    id: 'x', name: 'Castle', creator: 'Jane Doe', providerId: 'polyhaven',
    sourceUrl: 'https://polyhaven.com/a/castle', licenseId: 'CC-BY-4.0',
    licenseCheckedAt: new Date().toISOString(), downloadedAt: new Date().toISOString(),
    format: 'glb', fileSize: 1, category: 'Buildings', kind: 'model',
    localPath: '/x', originalDir: '/x/o', processingStatus: 'original',
    engineCompatibilityJson: '{}', currentVersion: 1, favorite: false, tagsJson: '[]',
    ...over,
  };
}

describe('attribution generator (spec §12)', () => {
  it('renders required attribution with the documented fields', () => {
    const doc = generateAttribution([
      asset({ name: 'Example Castle', creator: 'Example Creator', providerId: 'kenney', sourceUrl: 'https://example.com/castle', licenseId: 'CC-BY-4.0' }),
    ]);
    expect(doc.txt).toContain('Asset: Example Castle');
    expect(doc.txt).toContain('Creator: Example Creator');
    expect(doc.txt).toContain('License: CC BY 4.0');
    expect(doc.txt).toContain('Original URL: https://example.com/castle');
    expect(doc.txt).toMatch(/License URL: .+/);
    expect(doc.txt).toMatch(/Required Attribution: .+/);
    expect(doc.md).toContain('# Attributions');
    expect(doc.md).toContain('Example Castle');
  });

  it('splits CC0 courtesy section from required-attribution section', () => {
    const doc = generateAttribution([
      asset({ name: 'Free Thing', licenseId: 'CC0-1.0' }),
      asset({ name: 'Credited Thing', licenseId: 'CC-BY-4.0' }),
    ]);
    expect(doc.txt).toContain('No attribution required (CC0');
    expect(doc.txt).toContain('Free Thing');
    expect(doc.entries.filter((e) => e.requiresAttribution)).toHaveLength(1);
  });

  it('screams about unknown licenses so they cannot silently ship', () => {
    const doc = generateAttribution([asset({ licenseId: 'unknown' })]);
    expect(doc.txt).toContain('LICENSE UNKNOWN');
    expect(doc.md).toContain('License unknown');
  });

  it('source names are human-friendly', () => {
    expect(entryFor(asset({ providerId: 'opengameart' })).source).toBe('OpenGameArt.org');
    expect(entryFor(asset({ providerId: 'turbosquid' })).source).toBe('TurboSquid');
  });
});
