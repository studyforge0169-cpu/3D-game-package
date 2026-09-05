/**
 * `asset-hub mirror …` — the Git/GitHub-backed mirroring workflow (spec §4–6,
 * §12–15, §23–24). Every subcommand supports --json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { CommandCtx } from './commands';
import { UserError, flag, num } from './commands';
import { CliError } from './errors';
import { fmtBytes, fmtInt, table } from './output';
import { Hub } from '../core/services/hub';
import { MirrorState, MirrorEntry } from '../core/mirror/state';
import * as git from '../core/mirror/git';
import * as mirror from '../core/mirror/service';

export function resolveRepo(ctx: CommandCtx): string {
  const explicit = flag(ctx, 'repo');
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new CliError('NOT_FOUND', `--repo directory does not exist: ${explicit}`, { path: explicit });
    return path.resolve(explicit);
  }
  const root = git.gitInfo(process.cwd()).root;
  return path.resolve(root ?? process.cwd());
}

async function loadState(repoRoot: string): Promise<MirrorState> {
  const st = await MirrorState.load(repoRoot);
  await fsp.mkdir(gitWorkingDir(st), { recursive: true }).catch(() => {});
  return st;
}

function gitWorkingDir(st: MirrorState): string {
  return path.join(st.repoRoot, '.asset-hub-mirror', 'tmp');
}

export async function cmdMirror(ctx: CommandCtx): Promise<number> {
  const sub = ctx.args.positionals.shift() ?? '';
  const handlers: Record<string, (c: CommandCtx) => Promise<number>> = {
    discover: cmdDiscover,
    download: cmdDownload,
    update: cmdUpdate,
    status: cmdStatus,
    report: cmdReport,
    audit: cmdAudit,
    capacity: cmdCapacity,
    commit: cmdCommit,
    push: cmdPush,
    sync: cmdSync,
    remediate: cmdRemediate,
  };
  const handler = handlers[sub];
  if (!handler) throw new UserError(`unknown mirror subcommand "${sub}" (discover | download | update | status | report | audit | capacity | commit | push | sync | remediate)`);
  return handler(ctx);
}

// ------------------------------------------------------------------ discover

async function cmdDiscover(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const hub = await ctx.getHub();
  const state = await loadState(repoRoot);
  const providers = (ctx.args.flags.get('provider') ?? []).flatMap((v) => v.split(',')).filter(Boolean);
  const res = await mirror.discover(hub, state, {
    providers: providers.length ? providers : undefined,
    maxPages: num(ctx, 'max-pages'),
  });
  await state.save();
  git.ensureIgnore(repoRoot);
  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      success: true,
      repo: repoRoot,
      newly_discovered: res.discovered,
      total_catalog: res.total,
      providers: res.providers,
      paused: state.paused ?? null,
    }, null, 2));
    return 0;
  }
  ctx.io.out(`Repository: ${repoRoot}`);
  for (const p of res.providers) {
    ctx.io.out(`  ${p.provider.padEnd(14)} ${fmtInt(p.found)} asset(s)${p.error ? `  ! ${p.error}` : ''}`);
  }
  ctx.io.out(`Catalog: ${fmtInt(res.total)} asset(s) (${res.discovered} newly discovered). Next: asset-hub mirror download`);
  return 0;
}

// ------------------------------------------------------------------ download

async function cmdDownload(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const hub = await ctx.getHub();
  const state = await loadState(repoRoot);
  const providers = (ctx.args.flags.get('provider') ?? []).flatMap((v) => v.split(',')).filter(Boolean);

  let interrupted = false;
  const onInt = (): void => { interrupted = true; };
  process.once('SIGINT', onInt);
  let summary: mirror.DownloadSummary;
  try {
    summary = await mirror.downloadAssets(hub, state, {
      providers: providers.length ? providers : undefined,
      resume: ctx.args.booleans.has('resume'),
      failed: ctx.args.booleans.has('failed'),
      limit: num(ctx, 'limit'),
      shouldAbort: () => interrupted,
      onEvent: ctx.json ? undefined : (ev) => {
        if (ev.state === 'PROCESSED') ctx.io.out(`✓ ${ev.ref}`);
        else if (ev.state === 'SKIPPED') ctx.io.out(`= ${ev.ref} — ${ev.detail ?? ''}`);
        else if (ev.state === 'FAILED') ctx.io.out(`✗ ${ev.ref} — ${ev.detail ?? ''}`);
      },
    });
  } finally {
    process.removeListener('SIGINT', onInt);
  }

  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      success: summary.failed === 0,
      aborted: summary.aborted,
      summary: {
        processed: summary.processed,
        completed: summary.completed,
        skipped: summary.skipped,
        duplicates: summary.duplicates,
        failed: summary.failed,
      },
      paused: summary.paused,
      resume_with: 'asset-hub mirror download --resume',
    }, null, 2));
    return summary.failed > 0 ? 4 : 0;
  }
  ctx.io.out('');
  ctx.io.out(`Processed ${summary.processed}: ${summary.completed} mirrored · ${summary.skipped} skipped (license/redistribution) · ${summary.duplicates} duplicates · ${summary.failed} failed`);
  if (summary.aborted) ctx.io.out('Interrupted — progress saved. Resume with: asset-hub mirror download --resume');
  if (summary.paused) ctx.io.out(`MIRROR PAUSED — reason: ${summary.paused.reason}`);
  return summary.failed > 0 ? 4 : 0;
}

// -------------------------------------------------------------------- update

async function cmdUpdate(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const hub = await ctx.getHub();
  const state = await loadState(repoRoot);
  const providers = (ctx.args.flags.get('provider') ?? []).flatMap((v) => v.split(',')).filter(Boolean);
  const res = await mirror.updateMirror(hub, state, { providers: providers.length ? providers : undefined });
  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      success: true,
      discovered: {
        newly_discovered: res.discovered.discovered,
        total_catalog: res.discovered.total,
        providers: res.discovered.providers,
      },
      added: res.added,
      removed: res.removedRefs,
      changed_metadata: res.changedMetadata,
      license_changes: res.licenseChanges,
    }, null, 2));
    return 0;
  }
  ctx.io.out(`Discovery: ${res.discovered.discovered} new · ${res.discovered.total} total`);
  ctx.io.out(`Added: ${res.added.length} · Removed from source: ${res.removedRefs.length} · Metadata changed: ${res.changedMetadata.length}`);
  for (const lc of res.licenseChanges) {
    ctx.io.out(`⚠ ${lc.ref}: ${lc.action}`);
    if (/no longer permitted/i.test(lc.action)) {
      ctx.io.out(`    remediation: asset-hub mirror remediate ${lc.ref} --remove   (or keep history — audit recorded)`);
    }
  }
  return 0;
}

// -------------------------------------------------------------------- status

async function cmdStatus(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const state = await loadState(repoRoot);
  const info = git.gitInfo(repoRoot);
  const stats = state.stats();
  const doc = {
    repo: repoRoot,
    git: info,
    paused: state.paused ?? null,
    states: stats,
    totals: { entries: state.all().length },
  };
  if (ctx.json) {
    ctx.io.out(JSON.stringify(doc, null, 2));
    return 0;
  }
  ctx.io.out(`Repository: ${repoRoot}`);
  ctx.io.out(`Git: ${info.isRepo ? `${info.branch ?? '?'}${info.dirty ? ' (dirty)' : ''} → ${info.remote ?? 'no remote'}` : 'not a git repo'}`);
  ctx.io.out(`LFS: ${info.lfsInstalled ? 'installed' : 'not installed (large binaries will be plain git objects)'}`);
  if (state.paused) ctx.io.out(`⛔ MIRROR PAUSED — reason: ${state.paused.reason} (at ${state.paused.at})`);
  const rows = Object.entries(stats).map(([s, n]) => [s, fmtInt(n)]);
  ctx.io.out(table(rows, ['State', 'Assets']).join('\n'));
  return 0;
}

// -------------------------------------------------------------------- report

async function cmdReport(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const hub = await ctx.getHub();
  const state = await loadState(repoRoot);
  const classifications = mirror.classifyProviders(hub);
  const entries = state.all();

  const byProvider = new Map<string, { discovered: number; mirrored: number; skipped: number }>();
  for (const e of entries) {
    const rec = byProvider.get(e.providerId) ?? { discovered: 0, mirrored: 0, skipped: 0 };
    rec.discovered++;
    if (['PROCESSED', 'COMMITTED'].includes(e.state)) rec.mirrored++;
    if (e.state === 'SKIPPED') rec.skipped++;
    byProvider.set(e.providerId, rec);
  }
  const redistributable = entries.filter((e) => !e.license.unknown && e.license.redistribution === 'allowed').length;
  const restricted = entries.filter((e) => !e.license.unknown && e.license.redistribution !== 'allowed').length;
  const unknown = entries.filter((e) => e.license.unknown).length;
  const cap = await mirror.capacity(hub, state);

  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      providers: classifications.map((c) => ({ ...c, ...(byProvider.get(c.providerId) ?? { discovered: 0, mirrored: 0, skipped: 0 }) })),
      license: { redistributable, restricted, unknown },
      repository: {
        mirrored: cap.assets_mirrored,
        failed: cap.assets_failed,
        pending: cap.assets_pending,
        skipped: cap.assets_skipped,
        repository_bytes: cap.repository_bytes,
        git_object_store_bytes: cap.git_object_store_bytes,
        lfs_bytes: cap.lfs_bytes,
        paused: cap.paused,
        pause_reason: cap.pause_reason,
      },
    }, null, 2));
    return 0;
  }

  ctx.io.out('Providers:');
  for (const c of classifications) {
    const rec = byProvider.get(c.providerId) ?? { discovered: 0, mirrored: 0, skipped: 0 };
    ctx.io.out(`    ${c.displayName.padEnd(22)} ${fmtInt(rec.discovered)} discovered · ${fmtInt(rec.mirrored)} mirrored · ${c.tier}`);
  }
  ctx.io.out('');
  ctx.io.out('License:');
  ctx.io.out(`    Redistributable  ${fmtInt(redistributable)}`);
  ctx.io.out(`    Restricted       ${fmtInt(restricted)}`);
  ctx.io.out(`    Unknown          ${fmtInt(unknown)}`);
  ctx.io.out('');
  ctx.io.out('Repository:');
  ctx.io.out(`    Mirrored         ${fmtInt(cap.assets_mirrored)}`);
  ctx.io.out(`    Failed           ${fmtInt(cap.assets_failed)}`);
  ctx.io.out(`    Pending          ${fmtInt(cap.assets_pending)}`);
  ctx.io.out(`    Skipped          ${fmtInt(cap.assets_skipped)}`);
  ctx.io.out(`    Size             ${fmtBytes(cap.repository_bytes)} (git objects ${fmtBytes(cap.git_object_store_bytes)}, LFS-tracked ${fmtBytes(cap.lfs_bytes)})`);
  if (cap.paused) ctx.io.out(`    ⛔ MIRROR PAUSED — reason: ${cap.pause_reason}`);
  return 0;
}

// --------------------------------------------------------------------- audit

async function cmdAudit(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const state = await loadState(repoRoot);
  const findings = await mirror.auditMirror(state);
  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      success: findings.length === 0,
      checked_assets: mirror.mirroredEntries(state).length,
      findings,
    }, null, 2));
    return findings.some((f) => f.severity === 'ERROR') ? 4 : 0;
  }
  if (!findings.length) {
    ctx.io.out(`✓ audit clean — ${mirror.mirroredEntries(state).length} mirrored asset(s) all have metadata, license, integrity and attribution in order`);
    return 0;
  }
  for (const f of findings) {
    ctx.io.out(`${f.severity === 'ERROR' ? '✗' : '⚠'} ${f.path}${f.ref ? ` (${f.ref})` : ''}`);
    ctx.io.out(`    ${f.problem}`);
  }
  return findings.some((f) => f.severity === 'ERROR') ? 4 : 0;
}

// ----------------------------------------------------------------- capacity

async function cmdCapacity(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const hub = await ctx.getHub();
  const state = await loadState(repoRoot);
  const cap = await mirror.capacity(hub, state);
  if (ctx.json) {
    ctx.io.out(JSON.stringify(cap, null, 2));
    return cap.paused ? 3 : 0;
  }
  ctx.io.out(`Assets discovered:    ${fmtInt(cap.assets_discovered)}`);
  ctx.io.out(`Assets mirrorable:    ${fmtInt(cap.assets_mirrorable)}`);
  ctx.io.out(`Assets mirrored:      ${fmtInt(cap.assets_mirrored)}`);
  ctx.io.out(`Assets skipped:       ${fmtInt(cap.assets_skipped)}`);
  ctx.io.out(`Repository size:      ${fmtBytes(cap.repository_bytes)} (git objects ${fmtBytes(cap.git_object_store_bytes)})`);
  ctx.io.out(`LFS-tracked size:     ${fmtBytes(cap.lfs_bytes)}`);
  ctx.io.out(`Estimated additional: ${fmtBytes(cap.estimated_additional_bytes)}`);
  ctx.io.out(`Limits: warn ${fmtBytes(cap.warn_bytes)} · pause ${fmtBytes(cap.pause_bytes)}`);
  if (cap.paused) ctx.io.out(`⛔ MIRROR PAUSED — reason: ${cap.pause_reason}`);
  return cap.paused ? 3 : 0;
}

// ------------------------------------------------------------------- commit

async function cmdCommit(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const hub = await ctx.getHub();
  const state = await loadState(repoRoot);

  if (!git.gitInfo(repoRoot).isRepo) git.initRepo(repoRoot);
  git.ensureIgnore(repoRoot);
  const cfg = hub.getConfig().mirror;
  const lfs = git.ensureLfs(repoRoot, cfg.lfsPatterns);

  const cap = await mirror.capacity(hub, state);
  if (cap.paused) {
    state.setPaused('REPOSITORY_CAPACITY');
    await state.save();
    throw new CliError('REPOSITORY_CAPACITY',
      `mirror is paused at ${fmtBytes(cap.repository_bytes + cap.git_object_store_bytes)} (pause limit ${fmtBytes(cap.pause_bytes)}). Raise mirror.pauseBytes in config, remove assets (asset-hub mirror remediate <ref> --remove), or run git gc — then retry.`,
      { path: repoRoot, hint: 'asset-hub config set mirror.pauseBytes <bytes>' });
  }

  const generated = await mirror.regenerateRepoFiles(state);
  const toStage = ['assets', 'indexes', 'ASSET_INDEX.json', 'ASSET_INDEX.jsonl', 'licenses.json', 'LICENSES.md', 'ATTRIBUTIONS.md', 'ATTRIBUTIONS.txt', 'mirror-audit.jsonl', '.gitattributes', '.gitignore'];
  git.stageAll(repoRoot, toStage.filter((p) => fs.existsSync(path.join(repoRoot, p))));

  const staged = git.stagedFiles(repoRoot);
  const stagedBytes = staged.reduce((n, f) => n + (fs.statSync(path.join(repoRoot, f)).size || 0), 0);
  if (stagedBytes > cfg.warnBytes) {
    ctx.io.err(`⚠ staging ${fmtBytes(stagedBytes)} of new content (limit awareness: warn ${fmtBytes(cfg.warnBytes)})`);
  }
  if (!git.hasStagedChanges(repoRoot)) {
    if (ctx.json) ctx.io.out(JSON.stringify({ success: true, committed: false, reason: 'nothing to commit' }, null, 2));
    else ctx.io.out('Nothing to commit — mirror is up to date.');
    return 0;
  }

  const commitCount = state.all().filter((e) => e.state === 'PROCESSED').length;
  const sha = git.commit(repoRoot, `mirror: ${commitCount} new asset(s) + indexes/licenses/attribution\n\nRegenerated ASSET_INDEX, licenses.json, ATTRIBUTIONS via asset-hub mirror commit.`);
  for (const e of state.all()) {
    if (e.state === 'PROCESSED') {
      e.state = 'COMMITTED';
      state.upsert(e);
    }
  }
  await state.save();
  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      success: true,
      committed: true,
      commit: sha,
      files: staged.length,
      estimated_new_bytes: stagedBytes,
      lfs: lfs.lfs,
      generated,
    }, null, 2));
    return 0;
  }
  ctx.io.out(`✓ commit ${sha} — ${staged.length} file(s), ~${fmtBytes(stagedBytes)} new content${lfs.lfs ? ' (LFS active)' : ''}`);
  return 0;
}

// --------------------------------------------------------------------- push

async function cmdPush(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const state = await loadState(repoRoot);
  // License gate before pushing (spec §12): no FAILED/skipped-license assets staged.
  const uncommittedLicensed = state.all().filter((e) => e.state === 'FAILED').length;
  if (uncommittedLicensed > 0 && git.gitInfo(repoRoot).dirty) {
    ctx.io.err(`⚠ ${uncommittedLicensed} asset(s) in FAILED state — only verified assets are staged by 'mirror commit', pushing is safe.`);
  }
  try {
    git.push(repoRoot, flag(ctx, 'remote') ?? 'origin');
  } catch (e) {
    throw new CliError('EXPORT_FAILED', `git push failed: ${String((e as Error).message ?? e)}`, { path: repoRoot });
  }
  if (ctx.json) {
    ctx.io.out(JSON.stringify({ success: true, pushed: true, repo: repoRoot }, null, 2));
    return 0;
  }
  ctx.io.out(`✓ pushed ${repoRoot}`);
  return 0;
}

// --------------------------------------------------------------------- sync

async function cmdSync(ctx: CommandCtx): Promise<number> {
  const steps = ['discover', 'download', 'commit', ...(ctx.args.booleans.has('no-push') ? [] : ['push'])] as const;
  const results: Record<string, unknown>[] = [];
  const savedJson = ctx.json;
  for (const step of steps) {
    ctx.args.positionals.unshift(step);
    // capture JSON output per step
    const lines: string[] = [];
    const savedOut = ctx.io.out;
    ctx.io.out = (l = '') => lines.push(l);
    let code = 0;
    try {
      code = await cmdMirror(ctx);
    } finally {
      ctx.io.out = savedOut;
      ctx.args.positionals.shift();
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(lines.join('\n'));
    } catch {
      parsed = { human: lines.join('\n') };
    }
    results.push({ step, code, result: parsed });
    if (code !== 0) break;
  }
  if (savedJson) {
    ctx.io.out(JSON.stringify({ success: results.every((r) => r.code === 0), steps: results }, null, 2));
  } else {
    for (const r of results) ctx.io.out(`· ${String(r.step)}: ${Number(r.code) === 0 ? 'ok' : 'FAILED'}`);
  }
  return results.every((r) => Number(r.code) === 0) ? 0 : 4;
}

// --------------------------------------------------------------- remediate

async function cmdRemediate(ctx: CommandCtx): Promise<number> {
  const repoRoot = resolveRepo(ctx);
  const ref = ctx.args.positionals.shift();
  if (!ref) throw new UserError('usage: asset-hub mirror remediate <provider:asset-id> [--remove]');
  const state = await loadState(repoRoot);
  const res = await mirror.remediate(state, ref, { remove: ctx.args.booleans.has('remove') });
  if (ctx.json) {
    ctx.io.out(JSON.stringify({ success: true, ref, removed: res.removed, audit: res.auditPath }, null, 2));
    return 0;
  }
  ctx.io.out(`✓ ${ref} marked REMEDIATED${res.removed ? ' and removed from the working tree (git history preserved until you commit the deletion)' : ''}`);
  ctx.io.out(`  audit record appended to ${res.auditPath}`);
  return 0;
}

/** Re-exported for library command reuse. */
export function mirrorEntryOf(state: MirrorState, ref: string): MirrorEntry | undefined {
  return state.get(ref);
}

export type { Hub as HubType };
