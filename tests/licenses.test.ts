import { describe, expect, it } from 'vitest';
import {
  badgeFor, formatAttribution, listLicenses, normalizeLicense, resolveDefinition, unknownLicenseInfo,
} from '../src/core/licenses/registry';

describe('license intelligence', () => {
  it('normalizes every exact identifier our sources serve', () => {
    const cases: [string, string, boolean, string][] = [
      // [raw, expectedId, attributionRequired, expectedCommercial]
      ['CC0', 'CC0-1.0', false, 'allowed'],
      ['cc0-1.0', 'CC0-1.0', false, 'allowed'],
      ['cc-by-4.0', 'CC-BY-4.0', true, 'allowed'],
      ['CC-BY 4.0', 'CC-BY-4.0', true, 'allowed'],
      ['cc-by-sa-3.0', 'CC-BY-SA-3.0', true, 'conditions'],
      ['cc-by-nc-4.0', 'CC-BY-NC-4.0', true, 'forbidden'],
      ['royalty_free', 'BLENDERKIT-RF', false, 'conditions'],
      ['sketchfab-royaltyfree', 'SKETCHFAB-STANDARD', false, 'conditions'],
      ['GPLv2', 'GPL-2.0', true, 'conditions'],
      ['mit', 'MIT', true, 'allowed'],
    ];
    for (const [raw, id, attr, commercial] of cases) {
      const li = normalizeLicense({ raw, sourceConfirmed: true });
      expect(li.id, raw).toBe(id);
      expect(li.attributionRequired, raw).toBe(attr);
      expect(li.commercialUse, raw).toBe(commercial);
      expect(li.unknown).toBe(false);
      expect(li.licenseCheckedAt).toBeTruthy();
    }
  });

  it('extracts licenses from CC license URLs (OpenGameArt pages)', () => {
    expect(resolveDefinition(null, 'https://creativecommons.org/licenses/by-sa/3.0/').id).toBe('CC-BY-SA-3.0');
    expect(resolveDefinition(null, 'https://creativecommons.org/publicdomain/zero/1.0/').id).toBe('CC0-1.0');
    expect(resolveDefinition(null, 'https://www.gnu.org/licenses/gpl-2.0.html').id).toBe('GPL-2.0');
  });

  it('free text like "CC-BY-SA 3.0" resolves', () => {
    expect(resolveDefinition('CC-BY-SA 3.0').id).toBe('CC-BY-SA-3.0');
    expect(resolveDefinition('Creative Commons BY 4.0').id).toBe('CC-BY-4.0');
  });

  it('unknown stays unknown and is flagged (downloads must be blocked)', () => {
    const li = normalizeLicense({ raw: 'some bespoke thing', sourceConfirmed: true });
    expect(li.unknown).toBe(true);
    expect(li.id).toBe('unknown');
    expect(unknownLicenseInfo().unknown).toBe(true);
    expect(unknownLicenseInfo().commercialUse).toBe('unknown');
  });

  it('badges follow the spec tones', () => {
    expect(badgeFor({ id: 'CC0-1.0', commercialUse: 'allowed', attributionRequired: false, unknown: false }).tone).toBe('green');
    expect(badgeFor({ id: 'CC-BY-4.0', commercialUse: 'allowed', attributionRequired: true, unknown: false }).tone).toBe('blue');
    expect(badgeFor({ id: 'CC-BY-SA-4.0', commercialUse: 'conditions', attributionRequired: true, unknown: false }).tone).toBe('yellow');
    expect(badgeFor({ id: 'CC-BY-NC-4.0', commercialUse: 'forbidden', attributionRequired: true, unknown: false }).tone).toBe('red');
    expect(badgeFor({ id: 'unknown', commercialUse: 'unknown', attributionRequired: false, unknown: true }).tone).toBe('black');
    expect(badgeFor({ id: 'unknown', commercialUse: 'unknown', attributionRequired: false, unknown: true }).label).toContain('⚫');
  });

  it('formats required attribution strings', () => {
    const def = resolveDefinition('cc-by-4.0');
    const text = formatAttribution(def, { name: 'AK Rifle', creator: 'Gunsmith', url: 'https://example.com/a/1' });
    expect(text).toContain('AK Rifle');
    expect(text).toContain('Gunsmith');
    expect(text).toContain('https://example.com/a/1');
    expect(text).toContain('CC BY 4.0');
  });

  it('registry covers the licenses our sources actually use', () => {
    const ids = listLicenses().map((l) => l.id);
    for (const needed of ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'GPL-3.0', 'SKETCHFAB-STANDARD', 'BLENDERKIT-RF', 'ADOBE-MIXAMO']) {
      expect(ids, needed).toContain(needed);
    }
  });
});
