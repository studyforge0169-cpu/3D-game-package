import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import Jimp from 'jimp';

/** SHA-256 of a file (streamed). */
export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await streamInto(path, h);
  return h.digest('hex');
}

/** MD5 of a file (streamed) — used when a provider publishes md5 sums. */
export async function md5File(path: string): Promise<string> {
  const h = createHash('md5');
  await streamInto(path, h);
  return h.digest('hex');
}

function streamInto(path: string, h: import('node:crypto').Hash): Promise<void> {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(path, { highWaterMark: 1 << 20 });
    rs.on('data', (c) => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve());
  });
}

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Average-hash (aHash) perceptual hash of an image file → 64-bit hex string.
 * Used for duplicate detection across differently-compressed previews.
 */
export async function aHashFile(path: string): Promise<string | undefined> {
  try {
    const img = await Jimp.read(path);
    const g = img.clone().greyscale().resize(8, 8);
    const px: number[] = [];
    g.scan(0, 0, 8, 8, (_x, _y, idx) => { px.push(g.bitmap.data[idx]); });
    const avg = px.reduce((a, b) => a + b, 0) / px.length;
    let bits = '';
    for (const p of px) bits += p >= avg ? '1' : '0';
    return BigInt('0b' + bits).toString(16).padStart(16, '0');
  } catch {
    return undefined;
  }
}

/**
 * dHash (difference hash) — more robust than aHash for gradients.
 * Combined with aHash for a two-signal perceptual match.
 */
export async function dHashFile(path: string): Promise<string | undefined> {
  try {
    const img = await Jimp.read(path);
    const g = img.clone().greyscale().resize(9, 8);
    const rows: number[][] = [];
    for (let y = 0; y < 8; y++) {
      const row: number[] = [];
      for (let x = 0; x < 9; x++) row.push(g.bitmap.data[(y * 9 + x) * 4]);
      rows.push(row);
    }
    let bits = '';
    for (const row of rows) for (let x = 0; x < 8; x++) bits += row[x] < row[x + 1] ? '1' : '0';
    return BigInt('0b' + bits).toString(16).padStart(16, '0');
  } catch {
    return undefined;
  }
}

export function hammingHex(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}

/** Dice coefficient over bigrams — filename similarity. */
export function diceSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(A), gb = grams(B);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / (A.length - 1 + B.length - 1);
}
