/**
 * CLI output helpers — plain-text formatting with stable, script-friendly
 * layouts (and --json variants produced by the commands themselves).
 */

import type { AssetRef, LicenseInfo } from '../core/types';

export interface CliIo {
  out(line?: string): void;
  err(line?: string): void;
}

export function fmtBytes(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtInt(n?: number): string {
  return n === undefined || n === null ? '—' : n.toLocaleString('en-US');
}

/** Aligned text table; headers optional. */
export function table(rows: string[][], headers?: string[]): string[] {
  const all = headers ? [headers, ...rows] : rows;
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  const lines = all.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
  if (headers) {
    const sep = widths.map((w) => '─'.repeat(Math.min(w, 40))).join('──');
    lines.splice(1, 0, sep);
  }
  return lines;
}

export function commercialWord(l: LicenseInfo): string {
  if (l.unknown) return 'UNKNOWN';
  if (l.commercialUse === 'allowed') return 'YES';
  if (l.commercialUse === 'conditions') return 'CONDITIONS';
  if (l.commercialUse === 'forbidden') return 'NO';
  return 'UNKNOWN';
}

export function licenseLabel(l: LicenseInfo): string {
  return l.unknown ? 'LICENSE UNKNOWN' : `${l.id}${l.raw && l.raw !== l.id ? ` ("${l.raw}")` : ''}`;
}

/** Compact single-line license summary used by `info`. */
export function licenseSummary(l: LicenseInfo): string[] {
  return [
    `License:          ${licenseLabel(l)}`,
    `License name:     ${l.name}`,
    ...(l.url ? [`License URL:      ${l.url}`] : []),
    `Commercial use:   ${commercialWord(l)}`,
    `Attribution:      ${l.attributionRequired ? 'REQUIRED' : 'not required'}`,
    `Share-alike:      ${l.shareAlike ? 'YES' : 'no'}`,
    `Source confirmed: ${l.sourceConfirmed ? 'yes (official data)' : 'no'}`,
    `Checked at:       ${l.licenseCheckedAt}`,
  ];
}

/** Spec-format search result block. */
export function assetBlock(n: number, a: AssetRef): string[] {
  const lines = [
    `${n}. ${a.name}`,
    `   Source: ${a.providerId}`,
    ...(a.creator ? [`   Creator: ${a.creator}`] : []),
    `   License: ${licenseLabel(a.license)}  (commercial use: ${commercialWord(a.license)})`,
    `   Format: ${a.formats.length ? a.formats.join(' / ') : '—'}`,
  ];
  const bits: string[] = [];
  if (a.polyCount !== undefined) bits.push(`poly ${fmtInt(a.polyCount)}`);
  if (a.textureResolution !== undefined) bits.push(`textures ${fmtInt(a.textureResolution)}px`);
  if (a.fileSize !== undefined) bits.push(fmtBytes(a.fileSize));
  if (bits.length) lines.push(`   Detail: ${bits.join(' · ')}`);
  lines.push(
    `   Download: ${a.license.unknown ? 'BLOCKED — license could not be verified' : a.free ? 'free' : a.price ?? 'paid / check source'}`,
    `   URL: ${a.assetUrl}`,
  );
  return lines;
}
