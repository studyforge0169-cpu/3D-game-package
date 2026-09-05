/** Geometry fingerprint (spec §10) — robust to re-encoding, not to remeshing. */

import type { ModelData } from './mesh';
import { computeBoundingBox } from './mesh';
import { sha256Buffer } from '../util/hash';

/**
 * Fingerprint = counts + normalized extents + quantized vertex centroid +
 * sampled position hash. Two exports of the same mesh (OBJ vs GLB) produce
 * the same fingerprint as long as vertices are within quantization.
 */
export function geometryFingerprint(model: ModelData): string {
  if (!model.meshes.length) return '';
  const bb = computeBoundingBox(model.meshes);
  const size = [
    Math.max(1e-9, bb.max[0] - bb.min[0]),
    Math.max(1e-9, bb.max[1] - bb.min[1]),
    Math.max(1e-9, bb.max[2] - bb.min[2]),
  ];
  let vx = 0, vy = 0, vz = 0, n = 0;
  const sample: number[] = [];
  const total = model.meshes.reduce((s, m) => s + m.positions.length / 3, 0);
  const step = Math.max(1, Math.floor(total / 64));
  let seen = 0;
  for (const m of model.meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      vx += m.positions[i]; vy += m.positions[i + 1]; vz += m.positions[i + 2];
      n++;
      if (seen++ % step === 0 && sample.length < 64 * 3) {
        sample.push(
          Math.round((m.positions[i] - bb.min[0]) / size[0] * 255),
          Math.round((m.positions[i + 1] - bb.min[1]) / size[1] * 255),
          Math.round((m.positions[i + 2] - bb.min[2]) / size[2] * 255),
        );
      }
    }
  }
  const centroid = n ? [vx / n, vy / n, vz / n] : [0, 0, 0];
  const normCentroid = centroid.map((c, i) => Math.round((c - bb.min[i]) / size[i] * 255));
  const counts = [total, sample.length];
  const payload = Buffer.from([
    ...uint32s(counts),
    ...uint32s(normCentroid.map((v: number) => v * 1000)),
    ...uint32s(sample),
  ]);
  return `geo1:${sha256Buffer(payload).slice(0, 24)}`;
}

function uint32s(arr: number[]): Buffer {
  const b = Buffer.alloc(arr.length * 4);
  arr.forEach((v, i) => b.writeUInt32LE(Math.max(0, Math.round(v)), i * 4));
  return b;
}
