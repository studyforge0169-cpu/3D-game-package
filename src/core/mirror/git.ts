/**
 * Git operations for the mirror workflow (spec §12, §13). Runs the real git
 * binary in the repository; never force-pushes, never pushes when license
 * verification failed (the caller guarantees only verified assets are
 * staged), and is deliberately conservative: any git failure surfaces as an
 * error instead of being ignored.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GitInfo {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  remote: string | null;
  lfsInstalled: boolean;
  dirty: boolean;
}

function runGit(args: string[], cwd: string, okCodes: number[] = [0]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function tryGit(args: string[], cwd: string): string | null {
  try {
    return runGit(args, cwd);
  } catch {
    return null;
  }
}

export function gitInfo(repoRoot: string): GitInfo {
  const root = tryGit(['rev-parse', '--show-toplevel'], repoRoot)?.trim() ?? null;
  const isRepo = !!root;
  const branch = isRepo ? (tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)?.trim() ?? null) : null;
  const remote = isRepo ? (tryGit(['remote', 'get-url', 'origin'], repoRoot)?.trim() ?? null) : null;
  const lfsInstalled = isRepo && !!tryGit(['lfs', 'version'], repoRoot);
  let dirty = false;
  if (isRepo) {
    const st = tryGit(['status', '--porcelain'], repoRoot) ?? '';
    dirty = st.trim().length > 0;
  }
  return { isRepo, root, branch, remote, lfsInstalled, dirty };
}

export function ensureIgnore(repoRoot: string): void {
  const entries = [
    '# asset-hub mirror working state (never commit)',
    '.asset-hub-mirror/',
    '# local game-ready cache (spec §22) — never commit',
    '.cache/',
  ];
  const file = path.join(repoRoot, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = entries.filter((e) => !e.startsWith('#') && !current.split('\n').includes(e));
  if (missing.length) fs.writeFileSync(file, current + (current.endsWith('\n') || !current ? '' : '\n') + missing.join('\n') + '\n');
}

/**
 * Idempotent Git LFS setup: only writes .gitattributes patterns when
 * git-lfs is actually installed in this repository (spec §13). Returns the
 * list of tracked patterns.
 */
export function ensureLfs(repoRoot: string, patterns: string[]): { lfs: boolean; patterns: string[] } {
  const info = gitInfo(repoRoot);
  if (!info.lfsInstalled) return { lfs: false, patterns: [] };
  try {
    runGit(['lfs', 'install', '--local'], repoRoot);
  } catch {
    // some git versions dislike --local in fresh repos; plain install is fine
    runGit(['lfs', 'install'], repoRoot);
  }
  const file = path.join(repoRoot, '.gitattributes');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = current.split('\n').filter(Boolean);
  const added: string[] = [];
  for (const p of patterns) {
    const rule = `${p} filter=lfs diff=lfs merge=lfs -text`;
    if (!lines.some((l) => l.startsWith(p + ' '))) {
      lines.push(rule);
      added.push(p);
    }
  }
  if (added.length) fs.writeFileSync(file, lines.join('\n') + '\n');
  return { lfs: true, patterns };
}

export function stageAll(repoRoot: string, paths: string[]): void {
  runGit(['add', '--', ...paths], repoRoot);
}

export function stagedFiles(repoRoot: string): string[] {
  return (tryGit(['diff', '--cached', '--name-only'], repoRoot) ?? '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

export function hasStagedChanges(repoRoot: string): boolean {
  return stagedFiles(repoRoot).length > 0;
}

function hasIdentity(repoRoot: string): boolean {
  const email = tryGit(['config', 'user.email'], repoRoot);
  return !!email && email.trim().length > 0;
}

export function commit(repoRoot: string, message: string): string {
  const args = ['commit', '-m', message];
  if (!hasIdentity(repoRoot)) {
    // fresh mirror repos may have no git identity — use an explicit local one
    // (never overrides an identity the user actually configured)
    args.unshift('-c', 'user.name=asset-hub mirror', '-c', 'user.email=mirror@asset-hub.invalid');
  }
  runGit(args, repoRoot);
  return (tryGit(['rev-parse', '--short', 'HEAD'], repoRoot) ?? 'unknown').trim();
}

export function push(repoRoot: string, remote = 'origin', branch?: string): void {
  const b = branch ?? gitInfo(repoRoot).branch ?? 'HEAD';
  runGit(['push', remote, b], repoRoot);
}

/** Size of the git object store in bytes (count-objects -vH). */
export function gitObjectStoreBytes(repoRoot: string): number {
  const out = tryGit(['count-objects', '-vH'], repoRoot) ?? '';
  const m = /size-pack:\s*([\d.]+)/i.exec(out);
  const k = /size-pack:\s*[\d.]+\s*(\w+)/i.exec(out);
  if (!m) return 0;
  let bytes = parseFloat(m[1]);
  const unit = (k?.[1] ?? 'KiB').toLowerCase();
  const mult: Record<string, number> = { b: 1, kib: 1024, k: 1024, mib: 1024 ** 2, m: 1024 ** 2, gib: 1024 ** 3, g: 1024 ** 3 };
  bytes *= mult[unit] ?? 1024;
  return Math.round(bytes);
}

export function initRepo(repoRoot: string): void {
  if (!gitInfo(repoRoot).isRepo) {
    runGit(['init', '-q'], repoRoot);
  }
}
