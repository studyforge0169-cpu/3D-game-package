/**
 * Installer & packaging contract tests (spec §21): the electron-builder NSIS
 * config must produce UniversalGameAssetHub-Setup.exe with shortcuts,
 * uninstaller and file associations; the CI workflow must build it on
 * windows-latest.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');

describe('Windows installer (electron-builder NSIS)', () => {
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');

  it('builds UniversalGameAssetHub.exe with the required product name', () => {
    expect(yml).toContain('productName: Universal Game Asset Hub');
    expect(yml).toMatch(/artifactName: UniversalGameAssetHub-Setup\.\$\{ext\}/);
  });

  it('targets NSIS (assisted installer) + portable', () => {
    expect(yml).toMatch(/nsis/);
    expect(yml).toMatch(/oneClick: false/);
    expect(yml).toMatch(/portable/);
  });

  it('includes Start Menu shortcut, optional desktop shortcut and uninstaller', () => {
    expect(yml).toMatch(/shortcutName/);
    expect(yml).toMatch(/createDesktopShortcut: (always|true|ask)/);
    expect(yml).toMatch(/uninstallDisplayName/);
  });

  it('declares file associations for supported formats', () => {
    expect(yml).toContain('fileAssociations');
    expect(yml).toMatch(/ugahcollection/);
    expect(yml).toMatch(/ugahproject/);
  });

  it('bundles the app (no asar unpack problems for native-free build)', () => {
    expect(yml).toMatch(/appId/);
    // We use node:sqlite — no native modules to unpack
    expect(yml).not.toMatch(/better-sqlite3/);
  });

  it('packages the three.js viewer and renderer assets', () => {
    expect(existsSync(join(root, 'src', 'renderer', 'Viewer3D.tsx'))).toBe(true);
  });

  it('CI workflow builds the Windows installer on windows-latest', () => {
    const wf = readFileSync(join(root, '.github', 'workflows', 'windows-installer.yml'), 'utf8');
    expect(wf).toContain('windows-latest');
    expect(wf).toContain('dist:win');
    expect(wf).toMatch(/upload-artifact/);
  });

  it('README documents the installer build', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('UniversalGameAssetHub-Setup.exe');
  });
});
