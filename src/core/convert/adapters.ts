/**
 * Optional external tool adapters (spec §7): assimp for FBX/DAE→glTF and
 * Blender (headless) for BLEND→glTF + high-quality decimation. Both are
 * auto-detected from PATH or configured explicitly in Settings. When absent,
 * the UI reports the capability honestly instead of failing silently.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { rootLogger } from '../util/logger';

const log = rootLogger.child('adapters');

export interface ExternalTool {
  kind: 'assimp' | 'blender';
  path: string;
  version?: string;
}

const BLENDER_SCRIPT = `
import bpy, sys
argv = sys.argv[sys.argv.index("--") + 1:]
src, dst, mode = argv[0], argv[1], argv[2]
bpy.ops.wm.read_factory_settings(use_empty=False)
bpy.ops.wm.read_file(filepath=src)
if mode == "decimate":
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            mod = obj.modifiers.new("UGAH_Decimate", 'DECIMATE')
            mod.ratio = float(argv[3]) if len(argv) > 3 else 0.5
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', use_selection=False)
print("UGAH_OK")
`;

export function detectExternalTool(kind: 'assimp' | 'blender', opts?: { blenderPath?: string | null; assimpPath?: string | null }): ExternalTool | null {
  const candidates: string[] = [];
  if (kind === 'assimp') {
    if (opts?.assimpPath) candidates.push(opts.assimpPath);
    candidates.push('assimp');
  } else {
    if (opts?.blenderPath) candidates.push(opts.blenderPath);
    candidates.push('blender');
    const progDirs = ['C:\\Program Files\\Blender Foundation', '/usr/bin', '/usr/local/bin', '/opt', '/Applications'];
    for (const d of progDirs) {
      if (existsSync(d)) candidates.push(path.join(d, 'blender'));
    }
  }
  for (const c of candidates) {
    const resolved = whichSync(c, kind);
    if (resolved) return { kind, path: resolved };
  }
  return null;
}

function whichSync(cmd: string, kind: 'assimp' | 'blender'): string | null {
  if (cmd.includes(path.sep) || cmd.includes('/') || cmd.includes('\\')) {
    const exe = kind === 'blender' && process.platform === 'win32' && !cmd.toLowerCase().endsWith('.exe') ? `${cmd}\\blender.exe` : cmd;
    if (existsSync(exe)) return exe;
    return null;
  }
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', '.bat'] : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) for (const ext of exts) {
    const p = path.join(d, cmd + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface AdapterResult { ok: boolean; path?: string; error?: string; warnings: string[] }

export async function convertViaAssimp(src: string, dest: string, target: string, tool: ExternalTool): Promise<AdapterResult> {
  // assimp export infers format from extension; verbose flag lists result.
  const args = ['export', src, dest, '-v'];
  if (target === 'glb' || target === 'gltf') args.push('-j'); // prefer glTF JSON joiner when available
  const r = await run(tool.path, args, 120_000);
  if (r.code !== 0) return { ok: false, error: `assimp failed: ${r.stderr || r.stdout}`.slice(0, 500), warnings: [] };
  if (!existsSync(dest)) return { ok: false, error: 'assimp produced no output', warnings: [] };
  return { ok: true, path: dest, warnings: r.stderr ? [r.stderr.slice(0, 300)] : [] };
}

export async function convertViaBlender(
  src: string, dest: string, _target: string, tool: ExternalTool, decimateRatio?: number,
): Promise<AdapterResult> {
  const scriptPath = dest + '.ugah.py';
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(scriptPath, BLENDER_SCRIPT);
  try {
    const args = ['-b', '--factory-startup', '-P', scriptPath, '--', src, dest, decimateRatio ? 'decimate' : 'plain', String(decimateRatio ?? '')];
    const r = await run(tool.path, args, 300_000);
    if (r.code !== 0 || !existsSync(dest)) {
      return { ok: false, error: `Blender failed: ${(r.stderr || r.stdout).slice(0, 500)}`, warnings: [] };
    }
    return { ok: true, path: dest, warnings: [] };
  } finally {
    try { unlinkSync(scriptPath); } catch { /* keep */ }
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let settled = false;
    const child = spawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGKILL'); resolve({ code: -1, stdout, stderr: 'timeout' }); }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); if (stdout.length > 20_000) stdout = stdout.slice(-10_000); });
    child.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 20_000) stderr = stderr.slice(-10_000); });
    child.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }); }
    });
    child.on('close', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); }
    });
    log.debug('adapter run', { cmd: path.basename(cmd), code: null });
  });
}
