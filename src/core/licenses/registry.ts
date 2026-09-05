/**
 * License intelligence (spec §4).
 *
 * A curated registry of every license the supported sources actually serve,
 * with the exact source-side identifiers each API/page uses. Anything not
 * recognized normalizes to `unknown` — and unknown licenses BLOCK downloads
 * (enforced by the download manager, not by UI goodwill).
 */

import type { LicenseBadge, LicenseInfo, PermissionLevel } from '../types';

export interface LicenseDefinition {
  id: string;
  name: string;
  url: string;
  commercialUse: PermissionLevel;
  attributionRequired: boolean;
  shareAlike: boolean;
  redistribution: PermissionLevel;
  modification: PermissionLevel;
  tone: 'green' | 'yellow' | 'blue' | 'red' | 'black';
  attributionTemplate: string; // {{name}} {{creator}} {{license}} {{url}}
  summary: string;
}

const CC_ATTR = (v: string) =>
  `"{{name}}" by {{creator}} — licensed under ${v} — {{url}}`;

export const LICENSE_REGISTRY: Record<string, LicenseDefinition> = {
  'CC0-1.0': {
    id: 'CC0-1.0', name: 'CC0 1.0 Universal (Public Domain Dedication)',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    commercialUse: 'allowed', attributionRequired: false, shareAlike: false,
    redistribution: 'allowed', modification: 'allowed', tone: 'green',
    attributionTemplate: '"{{name}}" by {{creator}} [{{url}}] — CC0, no attribution required',
    summary: 'Public domain dedication. Use, modify and redistribute freely, even commercially.',
  },
  'CC-PDDC': {
    id: 'CC-PDDC', name: 'Public Domain Certification / No Known Copyright',
    url: 'https://creativecommons.org/publicdomain/',
    commercialUse: 'allowed', attributionRequired: false, shareAlike: false,
    redistribution: 'allowed', modification: 'allowed', tone: 'green',
    attributionTemplate: '"{{name}}" by {{creator}} [{{url}}] — Public Domain',
    summary: 'Public domain. No restrictions.',
  },
  'CC-BY-4.0': byAttribution('CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'),
  'CC-BY-3.0': byAttribution('CC BY 3.0', 'https://creativecommons.org/licenses/by/3.0/'),
  'CC-BY-2.0': byAttribution('CC BY 2.0', 'https://creativecommons.org/licenses/by/2.0/'),
  'CC-BY-SA-4.0': shareAlike('CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'),
  'CC-BY-SA-3.0': shareAlike('CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0/'),
  'CC-BY-NC-4.0': nonCommercial('CC BY-NC 4.0', 'https://creativecommons.org/licenses/by-nc/4.0/'),
  'CC-BY-NC-3.0': nonCommercial('CC BY-NC 3.0', 'https://creativecommons.org/licenses/by-nc/3.0/'),
  'CC-BY-NC-SA-4.0': nonCommercial('CC BY-NC-SA 4.0', 'https://creativecommons.org/licenses/by-nc-sa/4.0/'),
  'CC-BY-NC-ND-4.0': {
    ...nonCommercial('CC BY-NC-ND 4.0', 'https://creativecommons.org/licenses/by-nc-nd/4.0/'),
    modification: 'forbidden',
  },
  'CC-BY-ND-4.0': {
    ...byAttribution('CC BY-ND 4.0', 'https://creativecommons.org/licenses/by-nd/4.0/'),
    modification: 'forbidden', tone: 'yellow',
  },
  'GPL-2.0': {
    id: 'GPL-2.0', name: 'GNU General Public License 2.0',
    url: 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
    commercialUse: 'conditions', attributionRequired: true, shareAlike: true,
    redistribution: 'conditions', modification: 'conditions', tone: 'yellow',
    attributionTemplate: '"{{name}}" by {{creator}} [{{url}}] — GPL-2.0',
    summary: 'Copyleft. Derivatives of the asset must ship under GPL-2.0-compatible terms with source.',
  },
  'GPL-3.0': {
    id: 'GPL-3.0', name: 'GNU General Public License 3.0',
    url: 'https://www.gnu.org/licenses/gpl-3.0.html',
    commercialUse: 'conditions', attributionRequired: true, shareAlike: true,
    redistribution: 'conditions', modification: 'conditions', tone: 'yellow',
    attributionTemplate: '"{{name}}" by {{creator}} [{{url}}] — GPL-3.0',
    summary: 'Copyleft. Derivatives of the asset must ship under GPL-3.0-compatible terms with source.',
  },
  'OFL-1.1': {
    id: 'OFL-1.1', name: 'SIL Open Font License 1.1',
    url: 'https://openfontlicense.org/',
    commercialUse: 'allowed', attributionRequired: true, shareAlike: false,
    redistribution: 'allowed', modification: 'allowed', tone: 'blue',
    attributionTemplate: '"{{name}}" — SIL OFL 1.1 — {{url}}',
    summary: 'Fonts/embedded art: commercial use allowed, reserved names apply.',
  },
  'MIT': {
    id: 'MIT', name: 'MIT License', url: 'https://opensource.org/licenses/MIT',
    commercialUse: 'allowed', attributionRequired: true, shareAlike: false,
    redistribution: 'allowed', modification: 'allowed', tone: 'blue',
    attributionTemplate: '"{{name}}" by {{creator}} — MIT — {{url}}',
    summary: 'Permissive; keep the copyright notice.',
  },
  'Apache-2.0': {
    id: 'Apache-2.0', name: 'Apache License 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0',
    commercialUse: 'allowed', attributionRequired: true, shareAlike: false,
    redistribution: 'allowed', modification: 'allowed', tone: 'blue',
    attributionTemplate: '"{{name}}" by {{creator}} — Apache-2.0 — {{url}}',
    summary: 'Permissive; keep the NOTICE.',
  },
  'SKETCHFAB-STANDARD': {
    id: 'SKETCHFAB-STANDARD', name: 'Sketchfab Standard (Royalty-Free)',
    url: 'https://help.sketchfab.com/hc/en-us/articles/212696685-Licenses-and-Attribution',
    commercialUse: 'conditions', attributionRequired: false, shareAlike: false,
    redistribution: 'conditions', modification: 'allowed', tone: 'yellow',
    attributionTemplate: '"{{name}}" by {{creator}} [{{url}}] — Sketchfab Standard',
    summary: 'Use in games/media allowed incl. commercially; do not redistribute or resell the asset itself.',
  },
  'SKETCHFAB-EDITOR': {
    id: 'SKETCHFAB-EDITOR', name: 'Sketchfab Editor Remix',
    url: 'https://help.sketchfab.com/hc/en-us/articles/212696685-Licenses-and-Attribution',
    commercialUse: 'conditions', attributionRequired: true, shareAlike: false,
    redistribution: 'forbidden', modification: 'allowed', tone: 'yellow',
    attributionTemplate: '"{{name}}" by {{creator}} [{{url}}] — Sketchfab Editor Remix',
    summary: 'Remix in creation tools allowed; distribution of the source asset is restricted.',
  },
  'BLENDERKIT-RF': {
    id: 'BLENDERKIT-RF', name: 'BlenderKit Royalty-Free License',
    url: 'https://www.blenderkit.com/pages/licensing/',
    commercialUse: 'conditions', attributionRequired: false, shareAlike: false,
    redistribution: 'conditions', modification: 'allowed', tone: 'yellow',
    attributionTemplate: '"{{name}}" by {{creator}} [{{url}}] — BlenderKit royalty-free license',
    summary: 'Use in renders/games allowed; reselling or sharing the raw asset is not.',
  },
  'ADOBE-MIXAMO': {
    id: 'ADOBE-MIXAMO', name: 'Adobe Mixamo Terms',
    url: 'https://www.adobe.com/legal/terms.html',
    commercialUse: 'conditions', attributionRequired: false, shareAlike: false,
    redistribution: 'forbidden', modification: 'allowed', tone: 'yellow',
    attributionTemplate: 'Animations/characters from Adobe Mixabo ({{url}}) — Adobe ToS apply',
    summary: 'Use in projects with your Adobe account; redistribution of raw assets is prohibited.',
  },
  'SOURCE-SPECIFIC': {
    id: 'SOURCE-SPECIFIC', name: 'Source-specific license (see license URL)',
    url: '',
    commercialUse: 'conditions', attributionRequired: true, shareAlike: false,
    redistribution: 'conditions', modification: 'conditions', tone: 'yellow',
    attributionTemplate: '"{{name}}" by {{creator}} [{{url}}] — {{license}}',
    summary: 'The marketplace grants rights per purchase/download; review the license link for this asset.',
  },
};

function byAttribution(name: string, url: string): LicenseDefinition {
  return {
    id: name.toUpperCase().replace(/ /g, '-'), name, url,
    commercialUse: 'allowed', attributionRequired: true, shareAlike: false,
    redistribution: 'allowed', modification: 'allowed', tone: 'blue',
    attributionTemplate: CC_ATTR(name), summary: `${name}: commercial use allowed with attribution.`,
  };
}
function shareAlike(name: string, url: string): LicenseDefinition {
  return {
    id: name.toUpperCase().replace(/ /g, '-'), name, url,
    commercialUse: 'conditions', attributionRequired: true, shareAlike: true,
    redistribution: 'conditions', modification: 'conditions', tone: 'yellow',
    attributionTemplate: CC_ATTR(name), summary: `${name}: ShareAlike — derivatives must use the same license.`,
  };
}
function nonCommercial(name: string, url: string): LicenseDefinition {
  return {
    id: name.toUpperCase().replace(/ /g, '-'), name, url,
    commercialUse: 'forbidden', attributionRequired: true, shareAlike: false,
    redistribution: 'forbidden', modification: 'allowed', tone: 'red',
    attributionTemplate: CC_ATTR(name), summary: `${name}: NON-COMMERCIAL only.`,
  };
}

export const UNKNOWN_LICENSE_ID = 'unknown';

export const UNKNOWN_LICENSE_DEFINITION: LicenseDefinition = {
  id: UNKNOWN_LICENSE_ID, name: 'License unknown', url: '',
  commercialUse: 'unknown', attributionRequired: false, shareAlike: false,
  redistribution: 'unknown', modification: 'unknown', tone: 'black',
  attributionTemplate: '"{{name}}" (license could not be established)',
  summary: 'License could not be established from the source. Automated download is blocked.',
};

// -------------------------------------------------------------- normalization

/** Exact strings/slangs served by our sources → registry ids. */
const SOURCE_ALIASES: Record<string, string> = {
  // generic
  'cc0': 'CC0-1.0', 'cc0-1.0': 'CC0-1.0', 'cc_0': 'CC0-1.0', 'public domain': 'CC-PDDC',
  'pddc': 'CC-PDDC', 'cc-pddc': 'CC-PDDC',
  'cc-by-4.0': 'CC-BY-4.0', 'cc-by-3.0': 'CC-BY-3.0', 'cc-by-2.0': 'CC-BY-2.0', 'cc-by': 'CC-BY-4.0',
  'cc by 4.0': 'CC-BY-4.0', 'cc by 3.0': 'CC-BY-3.0', 'cc attribution': 'CC-BY-4.0',
  'cc-by-sa-4.0': 'CC-BY-SA-4.0', 'cc-by-sa-3.0': 'CC-BY-SA-3.0', 'cc-by-sa': 'CC-BY-SA-4.0',
  'cc-by-nc-4.0': 'CC-BY-NC-4.0', 'cc-by-nc-3.0': 'CC-BY-NC-3.0', 'cc-by-nc': 'CC-BY-NC-4.0',
  'cc-by-nc-sa-4.0': 'CC-BY-NC-SA-4.0', 'cc-by-nc-sa': 'CC-BY-NC-SA-4.0',
  'cc-by-nc-nd-4.0': 'CC-BY-NC-ND-4.0', 'cc-by-nc-nd': 'CC-BY-NC-ND-4.0',
  'cc-by-nd-4.0': 'CC-BY-ND-4.0', 'cc-by-nd': 'CC-BY-ND-4.0',
  'gpl': 'GPL-3.0', 'gpl-2.0': 'GPL-2.0', 'gpl-3.0': 'GPL-3.0', 'gplv2': 'GPL-2.0', 'gplv3': 'GPL-3.0',
  'mit': 'MIT', 'apache-2.0': 'Apache-2.0', 'ofl': 'OFL-1.1', 'ofl-1.1': 'OFL-1.1',
  // poly.pizza
  'cc0 1.0': 'CC0-1.0', 'cc by 4.0 (attribution)': 'CC-BY-4.0',
  // sketchfab slugs
  'sketchfab-royaltyfree': 'SKETCHFAB-STANDARD', 'sketchfab-standard': 'SKETCHFAB-STANDARD',
  'sketchfab-editor-remix': 'SKETCHFAB-EDITOR', 'sketchfab-editor': 'SKETCHFAB-EDITOR',
  // blenderkit
  'royalty_free': 'BLENDERKIT-RF', 'royalty-free': 'BLENDERKIT-RF', 'blenderkit-rf': 'BLENDERKIT-RF',
  // adobe
  'mixamo': 'ADOBE-MIXAMO', 'adobe-tos': 'ADOBE-MIXAMO',
};

/** Regex fallbacks for parsed page text (e.g. OGA content pages). */
const URL_PATTERNS: { re: RegExp; make: (v: string) => string }[] = [
  { re: /creativecommons\.org\/publicdomain\/zero\/1\.0/i, make: () => 'CC0-1.0' },
  { re: /creativecommons\.org\/licenses\/by-nc-nd\/([\d.]+)/i, make: (v) => versioned('CC-BY-NC-ND', v) },
  { re: /creativecommons\.org\/licenses\/by-nc-sa\/([\d.]+)/i, make: (v) => versioned('CC-BY-NC-SA', v) },
  { re: /creativecommons\.org\/licenses\/by-nc\/([\d.]+)/i, make: (v) => versioned('CC-BY-NC', v) },
  { re: /creativecommons\.org\/licenses\/by-sa\/([\d.]+)/i, make: (v) => versioned('CC-BY-SA', v) },
  { re: /creativecommons\.org\/licenses\/by\/([\d.]+)/i, make: (v) => versioned('CC-BY', v) },
  { re: /gnu\.org\/licenses\/gpl-?2/i, make: () => 'GPL-2.0' },
  { re: /gnu\.org\/licenses\/gpl-?3/i, make: () => 'GPL-3.0' },
];

function versioned(base: string, version: string): string {
  const v = ['2.0', '3.0', '4.0'].includes(version) ? version : '4.0';
  return `${base}-${v}`;
}

export interface NormalizeOpts {
  raw?: string | null;
  /** e.g. license URL parsed from a page. */
  licenseUrl?: string | null;
  sourceConfirmed: boolean;
  checkedAt?: string;
}

export function normalizeLicense(opts: NormalizeOpts): LicenseInfo {
  const def = resolveDefinition(opts.raw, opts.licenseUrl);
  return definitionToInfo(def, {
    raw: opts.raw ?? undefined,
    sourceConfirmed: opts.sourceConfirmed,
    checkedAt: opts.checkedAt ?? new Date().toISOString(),
  });
}

export function resolveDefinition(raw?: string | null, licenseUrl?: string | null): LicenseDefinition {
  if (raw) {
    const direct = LICENSE_REGISTRY[raw];
    if (direct) return direct;
    const alias = SOURCE_ALIASES[raw.trim().toLowerCase()];
    if (alias && LICENSE_REGISTRY[alias]) return LICENSE_REGISTRY[alias];
    // Free-text scan (page scrapes): "CC-BY-SA 3.0", "Creative Commons BY"
    const squashed = raw.toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/creative[-\s]*commons[-\s]*/g, 'cc-')
      .replace(/^cc(?![-])/g, 'cc-');
    const alias2 = SOURCE_ALIASES[squashed];
    if (alias2 && LICENSE_REGISTRY[alias2]) return LICENSE_REGISTRY[alias2];
    for (const { re, make } of URL_PATTERNS) {
      const m = raw.match(re);
      if (m) return LICENSE_REGISTRY[make(m[1] ?? '')] ?? UNKNOWN_LICENSE_DEFINITION;
    }
  }
  if (licenseUrl) for (const { re, make } of URL_PATTERNS) {
    const m = licenseUrl.match(re);
    if (m) return LICENSE_REGISTRY[make(m[1] ?? '')] ?? UNKNOWN_LICENSE_DEFINITION;
  }
  return UNKNOWN_LICENSE_DEFINITION;
}

export function definitionToInfo(
  def: LicenseDefinition,
  ctx: { raw?: string; sourceConfirmed: boolean; checkedAt: string; licenseUrl?: string },
): LicenseInfo {
  const unknown = def.id === UNKNOWN_LICENSE_ID;
  return {
    id: def.id,
    name: def.name,
    url: ctx.licenseUrl || def.url || undefined,
    commercialUse: def.commercialUse,
    attributionRequired: def.attributionRequired,
    shareAlike: def.shareAlike,
    redistribution: def.redistribution,
    modification: def.modification,
    unknown,
    raw: ctx.raw,
    sourceConfirmed: ctx.sourceConfirmed,
    licenseCheckedAt: ctx.checkedAt,
  };
}

export function unknownLicenseInfo(reason?: string): LicenseInfo {
  return definitionToInfo(UNKNOWN_LICENSE_DEFINITION, {
    raw: reason,
    sourceConfirmed: false,
    checkedAt: new Date().toISOString(),
  });
}

const TONE_LABELS: Record<LicenseDefinition['tone'], { label: string; emoji: string }> = {
  green: { label: 'Safe for commercial use', emoji: '🟢' },
  yellow: { label: 'Commercial use allowed with conditions', emoji: '🟡' },
  blue: { label: 'Attribution required', emoji: '🔵' },
  red: { label: 'Non-commercial', emoji: '🔴' },
  black: { label: 'License unknown', emoji: '⚫' },
};

export function badgeFor(info: Pick<LicenseInfo, 'id' | 'commercialUse' | 'attributionRequired' | 'unknown'>): LicenseBadge {
  const def = LICENSE_REGISTRY[info.id] ?? UNKNOWN_LICENSE_DEFINITION;
  const meta = TONE_LABELS[def.tone];
  return {
    tone: def.tone,
    label: `${meta.emoji} ${meta.label}`,
    tooltip: def.summary,
  };
}

export function formatAttribution(
  def: LicenseDefinition,
  vars: { name: string; creator?: string; url: string },
): string {
  return def.attributionTemplate
    .replaceAll('{{name}}', vars.name)
    .replaceAll('{{creator}}', vars.creator ?? 'Unknown creator')
    .replaceAll('{{url}}', vars.url)
    .replaceAll('{{license}}', def.name);
}

export function listLicenses(): LicenseDefinition[] {
  return Object.values(LICENSE_REGISTRY);
}
