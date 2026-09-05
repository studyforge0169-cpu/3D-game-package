import { promises as fs, constants as fsConstants, type Stats } from 'node:fs';
import * as path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function isWritable(dir: string): Promise<boolean> {
  try {
    await fs.access(dir, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch { return false; }
}

export async function fileSize(p: string): Promise<number> {
  try { return (await fs.stat(p)).size; } catch { return 0; }
}

export async function statOrNull(p: string): Promise<Stats | null> {
  try { return await fs.stat(p); } catch { return null; }
}

/** Free bytes on the volume containing `p` (works on Win/Linux/mac). */
export async function freeDiskBytes(p: string): Promise<number> {
  const { statfs } = (await import('node:fs')) as unknown as {
    statfs: (target: string) => Promise<{ bavail: bigint; bsize: bigint }>;
  };
  const target = (await pathExists(p)) ? p : path.dirname(p);
  try {
    const st = await statfs(target);
    return Number(st.bavail * st.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER; // unknown → don't block
  }
}

/** Sanitize for Windows-unsafe characters. */
export function safeFileName(name: string, fallback = 'asset'): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/** Atomic file write: temp + rename so readers never see partial content. */
export async function atomicWriteFile(p: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, p);
}

export async function readJsonFile<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch { return null; }
}

export async function writeJsonFile(p: string, data: unknown): Promise<void> {
  await atomicWriteFile(p, JSON.stringify(data, null, 2));
}

export async function copyFile(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  await fs.copyFile(src, dest);
}

export async function moveFile(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  await fs.rename(src, dest).catch(async (e: NodeJS.ErrnoException) => {
    if (e.code === 'EXDEV') {
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    } else throw e;
  });
}

export async function listFiles(dir: string, recursive = false): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive) await walk(full); }
      else out.push(full);
    }
  }
  await walk(dir);
  return out;
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Magic-byte sniffing for corruption detection (spec §18). */
export function sniffFormat(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';       // PK (zip, glb-in-zip, blend?)
  if (buf.subarray(0, 4).toString('ascii') === 'glTF') return 'glb';
  if (buf.subarray(0, 4).toString('ascii').startsWith('BLEND')) return 'blend';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.subarray(0, 3).toString('ascii') === '#py') return 'hdr';
  if (buf.subarray(0, 6).toString('latin1') === 'solid ' || (buf.length > 84 && buf[80] === 0)) return 'stl'; // heuristic
  if (buf.subarray(0, 5).toString('ascii').match(/^ply$/)) return 'ply'; // 'ply\n'/'ply\r'
  return null;
}
