import React from 'react';
import type { LicenseInfo } from '../../core/types';

/** Spec §4 badge labels. */
export function LicenseBadge({ license }: { license: LicenseInfo }) {
  const tone = license.unknown
    ? 'black'
    : license.commercialUse === 'forbidden'
      ? 'red'
      : license.commercialUse === 'conditions' || license.shareAlike
        ? 'yellow'
        : license.attributionRequired
          ? 'blue'
          : 'green';
  const label = license.unknown
    ? '⚫ License unknown'
    : license.commercialUse === 'forbidden'
      ? '🔴 Non-commercial'
      : license.commercialUse === 'conditions' || license.shareAlike
        ? '🟡 Conditions'
        : license.attributionRequired
          ? '🔵 Attribution'
          : '🟢 Commercial OK';
  const tip = license.unknown
    ? 'License could not be established — automated download is blocked'
    : `${license.name}${license.attributionRequired ? ' · attribution required' : ''}${license.shareAlike ? ' · share-alike' : ''}`;
  return <span className={`badge ${tone}`} title={tip}>{label}</span>;
}

export function licenseFacts(license: LicenseInfo): { k: string; v: string }[] {
  const yn = (p?: boolean) => (p === undefined ? '—' : p ? 'Yes' : 'No');
  const perm = (p: string) => p === 'allowed' ? 'Allowed' : p === 'conditions' ? 'Allowed with conditions' : p === 'forbidden' ? 'Prohibited' : 'Unknown';
  return [
    { k: 'License', v: license.name },
    { k: 'Commercial use', v: perm(license.commercialUse) },
    { k: 'Attribution required', v: yn(license.attributionRequired) },
    { k: 'Redistribution', v: perm(license.redistribution) },
    { k: 'Modification', v: perm(license.modification) },
    { k: 'Share-alike', v: yn(license.shareAlike) },
    { k: 'Download permission', v: license.unknown ? 'BLOCKED (license unknown)' : 'Granted by source' },
    { k: 'License URL', v: license.url ?? '—' },
    { k: 'License checked', v: new Date(license.licenseCheckedAt).toLocaleString() },
    { k: 'Source-confirmed', v: license.sourceConfirmed ? 'Yes (official API/page)' : 'Assumed — verify before shipping' },
  ];
}
