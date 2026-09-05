/**
 * Conversion pipeline (spec §7): read → process → write, with Original/
 * Processed/GameReady separation. Never modifies the source file.
 *
 * Native conversions: OBJ(+MTL)/STL/PLY → GLB/GLTF/OBJ, GLB↔GLTF repackage,
 * plus texture ops (resize/compress via Jimp), vertex welding, normal
 * recompute, unused-material pruning, axis conversion, LOD generation
 * (vertex-clustering decimation) and collision proxies.
 * FBX/BLEND/DAE require the optional external adapters (assimp/Blender) —
 * reported honestly when unavailable (see adapters.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import Jimp from 'jimp';
import type { ConvertOptions, ConvertResult, MeshStats } from '../types';
import type { MeshData, ModelData } from './mesh';
import { computeBoundingBox, parseObj, parsePly, parseStl, triangleCount } from './mesh';
import { readGlbOrGltf, writeGlb, writeGltf, writeObj } from './gltf';
import { geometryFingerprint } from './stats';
import { convertViaAssimp, convertViaBlender, detectExternalTool } from './adapters';
import { rootLogger } from '../util/logger';

const log = rootLogger.child('convert');

export function extensionOf(p: string): string {
  return path.extname(p).toLowerCase().replace('.', '');
}

export async function loadModel(source: string): Promise<ModelData> {
  const ext = extensionOf(source);
  switch (ext) {
    case 'obj': {
      const text = await fsp.readFile(source, 'utf8');
      const dir = path.dirname(source);
      const mtlResolver = asyncSafeMtl(dir);
      return parseObj(text, {
        mtlResolver,
        dir,
      });
    }
    case 'stl':
      return parseStl(await fsp.readFile(source));
    case 'ply':
      return parsePly(await fsp.readFile(source));
    case 'glb': case 'gltf': {
      const buf = await fsp.readFile(source);
      return readGlbOrGltf(buf, source).model;
    }
    default:
      throw new Error(`Format .${ext} cannot be parsed natively (use an external converter adapter for FBX/BLEND/DAE)`);
  }
}

function asyncSafeMtl(dir: string): (name: string) => string | null {
  return (name: string) => {
    try {
      const candidates = [path.join(dir, name), path.join(dir, name.toLowerCase())];
      for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
      return null;
    } catch { return null; }
  };
}

// ------------------------------------------------------------------- ops

export function flipYZ(model: ModelData): void {
  for (const m of model.meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      const y = m.positions[i + 1], z = m.positions[i + 2];
      m.positions[i + 1] = z; m.positions[i + 2] = -y;
    }
    if (m.normals) {
      for (let i = 0; i < m.normals.length; i += 3) {
        const y = m.normals[i + 1], z = m.normals[i + 2];
        m.normals[i + 1] = z; m.normals[i + 2] = -y;
      }
    }
  }
}

export function recomputeNormals(model: ModelData): void {
  for (const m of model.meshes) {
    const n = new Float32Array(m.positions.length);
    const tri = (a: number, b: number, c: number) => {
      const i0 = a * 3, i1 = b * 3, i2 = c * 3;
      const ux = m.positions[i1] - m.positions[i0], uy = m.positions[i1 + 1] - m.positions[i0 + 1], uz = m.positions[i1 + 2] - m.positions[i0 + 2];
      const vx = m.positions[i2] - m.positions[i0], vy = m.positions[i2 + 1] - m.positions[i0 + 1], vz = m.positions[i2 + 2] - m.positions[i0 + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      for (const i of [i0, i1, i2]) { n[i] += cx; n[i + 1] += cy; n[i + 2] += cz; }
    };
    if (m.indices) for (let i = 0; i < m.indices.length; i += 3) tri(m.indices[i], m.indices[i + 1], m.indices[i + 2]);
    else for (let i = 0; i < m.positions.length / 3; i += 3) tri(i, i + 1, i + 2);
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    m.normals = n;
  }
}

export function weldVertices(model: ModelData, precision = 1e5): void {
  for (const m of model.meshes) {
    if (!m.indices) continue;
    const map = new Map<string, number>();
    const newPositions: number[] = [], newNormals: number[] = [], newUvs: number[] = [];
    const remap = new Uint32Array(m.positions.length / 3);
    for (let i = 0; i < m.positions.length / 3; i++) {
      const key = `${Math.round(m.positions[i * 3] * precision)},${Math.round(m.positions[i * 3 + 1] * precision)},${Math.round(m.positions[i * 3 + 2] * precision)}`;
      let idx = map.get(key);
      if (idx === undefined) {
        idx = newPositions.length / 3;
        map.set(key, idx);
        newPositions.push(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]);
        if (m.normals) newNormals.push(m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]);
        if (m.uvs) newUvs.push(m.uvs[i * 2], m.uvs[i * 2 + 1]);
      }
      remap[i] = idx;
    }
    m.positions = new Float32Array(newPositions);
    if (m.normals && newNormals.length) m.normals = new Float32Array(newNormals); else m.normals = undefined;
    if (m.uvs && newUvs.length) m.uvs = new Float32Array(newUvs); else m.uvs = undefined;
    for (let i = 0; i < m.indices.length; i++) m.indices[i] = remap[m.indices[i]];
  }
}

export function pruneUnusedMaterials(model: ModelData): number {
  const used = new Set(model.meshes.map((m) => m.material).filter(Boolean));
  const before = model.materials.length;
  model.materials = model.materials.filter((m) => used.has(m.name));
  const usedImages = new Set<string>();
  for (const m of model.materials) for (const t of Object.values(m.textures ?? {})) if (t) usedImages.add(t);
  model.images = model.images.filter((im) => usedImages.has(im.name) || model.images.length <= usedImages.size);
  return before - model.materials.length;
}

/** Vertex-clustering decimation (real, deterministic LOD approximation). */
export function decimateMesh(mesh: MeshData, ratio: number): MeshData {
  const targetVerts = Math.max(3, Math.floor((mesh.positions.length / 3) * ratio));
  const bbox = (() => {
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (mesh.positions[i + k] < min[k]) min[k] = mesh.positions[i + k];
        if (mesh.positions[i + k] > max[k]) max[k] = mesh.positions[i + k];
      }
    }
    return { min, max };
  })();
  const cells = Math.max(1, Math.floor(Math.cbrt(targetVerts)));
  const cellSize = [
    Math.max(1e-9, (bbox.max[0] - bbox.min[0]) / cells),
    Math.max(1e-9, (bbox.max[1] - bbox.min[1]) / cells),
    Math.max(1e-9, (bbox.max[2] - bbox.min[2]) / cells),
  ];
  const map = new Map<string, { sx: number; sy: number; sz: number; n: number; uvx: number; uvz: number }>();
  const clusterIdx = new Int32Array(mesh.positions.length / 3);
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const cx = Math.floor((mesh.positions[i * 3] - bbox.min[0]) / cellSize[0]);
    const cy = Math.floor((mesh.positions[i * 3 + 1] - bbox.min[1]) / cellSize[1]);
    const cz = Math.floor((mesh.positions[i * 3 + 2] - bbox.min[2]) / cellSize[2]);
    const key = `${cx},${cy},${cz}`;
    let c = map.get(key);
    if (!c) { c = { sx: 0, sy: 0, sz: 0, n: 0, uvx: 0, uvz: 0 }; map.set(key, c); }
    c.sx += mesh.positions[i * 3]; c.sy += mesh.positions[i * 3 + 1]; c.sz += mesh.positions[i * 3 + 2]; c.n++;
    if (mesh.uvs) { c.uvx += mesh.uvs[i * 2]; c.uvz += mesh.uvs[i * 2 + 1]; }
    clusterIdx[i] = [...map.keys()].indexOf(key);
  }
  const positions: number[] = [], uvs: number[] = [];
  let ci = 0;
  for (const c of map.values()) {
    positions.push(c.sx / c.n, c.sy / c.n, c.sz / c.n);
    if (mesh.uvs) uvs.push(c.uvx / c.n, c.uvz / c.n);
    ci++;
  }
  const indices: number[] = [];
  const tri = mesh.indices ? mesh.indices : Uint32Array.from({ length: mesh.positions.length / 3 }, (_, i) => i);
  for (let i = 0; i < tri.length; i += 3) {
    const a = clusterIdx[tri[i]], b = clusterIdx[tri[i + 1]], c2 = clusterIdx[tri[i + 2]];
    if (a !== b && b !== c2 && a !== c2) indices.push(a, b, c2);
  }
  const out: MeshData = {
    name: mesh.name,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    material: mesh.material,
  };
  if (uvs.length) out.uvs = new Float32Array(uvs);
  return out;
}

export function bboxMesh(model: ModelData, name: string): MeshData {
  const bb = computeBoundingBox(model.meshes);
  const [minx, miny, minz] = bb.min, [maxx, maxy, maxz] = bb.max;
  const v: number[] = [];
  const push = (x: number, y: number, z: number) => v.push(x, y, z);
  // 8 corners, 12 triangles
  const c: [number, number, number][] = [
    [minx, miny, minz], [maxx, miny, minz], [maxx, maxy, minz], [minx, maxy, minz],
    [minx, miny, maxz], [maxx, miny, maxz], [maxx, maxy, maxz], [minx, maxy, maxz],
  ];
  const quads: [number, number, number, number][] = [
    [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [1, 2, 6, 5], [0, 3, 7, 4],
  ];
  for (const [a, b, d, e] of quads) { push(...c[a]); push(...c[b]); push(...c[d]); push(...c[a]); push(...c[d]); push(...c[e]); }
  return { name, positions: new Float32Array(v) };
}

// ------------------------------------------------------------- texture ops

async function processTextures(model: ModelData, opts: ConvertOptions, outDir: string): Promise<string[]> {
  const warnings: string[] = [];
  const resize = opts.textureResize?.maxSize;
  const compress = opts.textureCompress;
  for (const im of model.images) {
    let bytes = im.bytes;
    let file = im.file;
    if (!bytes && file && fs.existsSync(file)) bytes = await fsp.readFile(file);
    if (!bytes) continue;
    if (resize || compress) {
      try {
        const img = await Jimp.read(bytes);
        const w = img.bitmap.width, h = img.bitmap.height;
        let out = img;
        if (resize && Math.max(w, h) > resize) {
          const scale = resize / Math.max(w, h);
          out = img.clone().resize(Math.round(w * scale), Math.round(h * scale));
        }
        const mime = compress?.format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const buf = await (compress?.format === 'jpeg'
          ? out.quality(compress.quality ?? 85).getBufferAsync('image/jpeg')
          : out.getBufferAsync('image/png'));
        im.bytes = buf;
        im.mimeType = mime;
        im.file = '';
      } catch (e) {
        warnings.push(`texture ${im.name} not processed: ${String(e)}`);
      }
    }
    void outDir;
  }
  return warnings;
}

// ------------------------------------------------------------- main entry

export async function convertAsset(source: string, outDir: string, options: ConvertOptions): Promise<ConvertResult> {
  const warnings: string[] = [];
  const outputs: ConvertResult['outputs'] = [];
  await fsp.mkdir(outDir, { recursive: true });
  const baseName = path.basename(source, path.extname(source)).replace(/\s+/g, '_');
  const sourceExt = extensionOf(source);
  const targetExt = options.targetFormat;

  // External-tool conversions where we have no native parser/writer.
  if (['fbx', 'blend', 'dae'].includes(sourceExt)) {
    const adapter = sourceExt === 'blend' ? 'blender' : 'assimp';
    const tool = detectExternalTool(adapter, options as unknown as { blenderPath?: string | null; assimpPath?: string | null });
    if (!tool) {
      return {
        ok: false, outputs, warnings: [`${adapter} not configured`],
        error: `${sourceExt.toUpperCase()} conversion requires the external ${adapter === 'blender' ? 'Blender' : 'assimp'} tool. Install it and set the path in Settings → Converters. The original file is untouched.`,
      };
    }
    const r = adapter === 'blender'
      ? await convertViaBlender(source, path.join(outDir, `${baseName}.${targetExt}`), targetExt, tool)
      : await convertViaAssimp(source, path.join(outDir, `${baseName}.${targetExt}`), targetExt, tool);
    if (!r.ok) return { ok: false, outputs: [], warnings, error: r.error };
    outputs.push({ path: r.path!, kind: 'model', bytes: (await fsp.stat(r.path!)).size });
    return { ok: true, outputs, warnings: [...warnings, ...r.warnings], stats: await statsForPath(r.path!) };
  }

  // Native pipeline.
  const model = await loadModel(source);
  // Load texture files referenced by materials (for embedding/processing).
  const srcDir = path.dirname(source);
  for (const mat of model.materials) {
    for (const kind of Object.keys(mat.textures ?? {}) as (keyof NonNullable<MaterialDef['textures']>)[]) {
      const ref = mat.textures![kind]!;
      if (model.images.some((im) => im.name === ref)) continue;
      const candidates = [path.join(srcDir, ref), path.join(srcDir, path.basename(ref))];
      const found = candidates.find((c) => fs.existsSync(c));
      if (found) {
        const bytes = await fsp.readFile(found);
        model.images.push({ name: ref, file: found, bytes, mimeType: mimeOf(found) });
      } else {
        warnings.push(`texture ${ref} not found next to the model`);
      }
    }
  }

  if (options.axisMode === 'z-up') { /* glTF is Y-up; OBJ from CAD is Z-up */ flipYZ(model); warnings.push('converted Z-up → Y-up'); }
  if (options.weldVertices) { weldVertices(model); }
  if (options.recomputeNormals || !model.meshes.every((m) => m.normals)) {
    const anyMissing = model.meshes.some((m) => !m.normals);
    if (options.recomputeNormals || anyMissing) { recomputeNormals(model); }
  }
  if (options.pruneUnusedMaterials) {
    const removed = pruneUnusedMaterials(model);
    if (removed) warnings.push(`pruned ${removed} unused material(s)`);
  }
  warnings.push(...(await processTextures(model, options, outDir)));

  const stats = computeStats(model);

  // Primary output.
  if (targetExt === 'glb') {
    const out = path.join(outDir, `${baseName}.glb`);
    writeGlb(model, out);
    outputs.push({ path: out, kind: 'model', bytes: fs.statSync(out).size });
  } else if (targetExt === 'gltf') {
    const r = writeGltf(model, path.join(outDir, `${baseName}.gltf`), { outDir, baseName });
    for (const f of r.files) outputs.push({ path: f, kind: path.extname(f) === '.gltf' ? 'model' : 'texture', bytes: fs.statSync(f).size });
  } else if (targetExt === 'obj') {
    const r = writeObj(model, path.join(outDir, `${baseName}.obj`), { outDir, baseName });
    for (const f of r.files) outputs.push({ path: f, kind: f.endsWith('.obj') ? 'model' : 'texture', bytes: fs.statSync(f).size });
  } else if (targetExt === 'fbx') {
    return { ok: false, outputs, warnings, error: 'FBX export requires the external Blender/assimp adapter (Settings → Converters). Original untouched.' };
  }

  // LODs.
  if (options.generateLods?.levels?.length) {
    for (const lod of options.generateLods.levels) {
      const lodMeshes = model.meshes.map((m) => decimateMesh(m, lod.ratio));
      const lodModel: ModelData = { ...model, meshes: lodMeshes };
      const out = path.join(outDir, `${baseName}${lod.suffix}.glb`);
      writeGlb(lodModel, out);
      outputs.push({ path: out, kind: 'lod', bytes: fs.statSync(out).size });
    }
  }

  // Collision proxies.
  if (options.generateCollision && options.generateCollision !== 'none') {
    const colModel: ModelData = { meshes: [], materials: [], images: [], animations: [], hasSkeleton: false };
    colModel.meshes.push(options.generateCollision === 'bbox'
      ? bboxMesh(model, `${baseName}_col`)
      : decimateMesh(model.meshes[0], options.decimateRatio ?? 0.25));
    if (options.generateCollision === 'decimated') {
      for (let i = 1; i < model.meshes.length; i++) colModel.meshes.push(decimateMesh(model.meshes[i], options.decimateRatio ?? 0.25));
    }
    const out = path.join(outDir, `${baseName}_collision.glb`);
    writeGlb(colModel, out);
    outputs.push({ path: out, kind: 'collision', bytes: fs.statSync(out).size });
  }

  return { ok: true, outputs, warnings, stats };
}

export function computeStats(model: ModelData): MeshStats {
  const bb = computeBoundingBox(model.meshes);
  let vertices = 0, faces = 0, hasNormals = true, hasUvs = true;
  for (const m of model.meshes) {
    vertices += m.positions.length / 3;
    faces += triangleCount(m);
    if (!m.normals) hasNormals = false;
    if (!m.uvs) hasUvs = false;
  }
  return {
    vertices,
    faces,
    meshes: model.meshes.length,
    materials: model.materials.length,
    hasNormals,
    hasUvs,
    hasSkeleton: model.hasSkeleton,
    animations: model.animations.length,
    boundingBox: bb,
    textureFiles: model.images.map((im) => ({
      name: im.name,
      format: im.mimeType,
    })),
  };
}

async function statsForPath(p: string): Promise<MeshStats | undefined> {
  try {
    const model = await loadModel(p);
    return computeStats(model);
  } catch { return undefined; }
}

function mimeOf(p: string): string {
  const e = extensionOf(p);
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  return 'image/png';
}

type MaterialDef = import('./mesh').MaterialDef;
