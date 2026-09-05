/**
 * glTF 2.0 / GLB reader + writer (spec §7).
 * Writes valid GLB (embedded buffers + images) and .gltf (+external .bin and
 * texture files). Reads GLB/GLTF into ModelData for stats/processing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MaterialDef, MeshData, ModelData } from './mesh';
import { triangleCount } from './mesh';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

// ------------------------------------------------------------------- writer

interface GltfBuildOpts {
  embedTextures?: boolean;      // default true for GLB
  outDir?: string;              // for external resources (.gltf mode)
  baseName?: string;
}

export function buildGltfJson(model: ModelData, opts: GltfBuildOpts, buffers: { bin: Buffer[]; images: { name: string; mime: string; bytes: Buffer; file?: string }[] }): {
  json: Record<string, unknown>;
  bin: Buffer;
} {
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Universal Game Asset Hub' },
    scene: 0,
    scenes: [{ nodes: [0], name: 'Scene' }],
  };
  // Materials
  const materialsJson: Record<string, unknown>[] = [];
  const matIndex = new Map<string, number>();
  model.materials.forEach((m, i) => {
    matIndex.set(m.name, i);
    const mat: Record<string, unknown> = {
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: m.baseColor ?? [1, 1, 1, 1],
        metallicFactor: m.metallic ?? 0,
        roughnessFactor: m.roughness ?? 0.8,
      },
      doubleSided: !!m.doubleSided,
    };
    if (m.textures?.baseColor) {
      const imgIdx = buffers.images.findIndex((im) => im.name === m.textures!.baseColor);
      if (imgIdx >= 0) {
        mat.pbrMetallicRoughness = {
          ...(mat.pbrMetallicRoughness as object),
          baseColorTexture: { index: imgIdx },
        };
      }
    }
    materialsJson.push(mat);
  });
  if (materialsJson.length) json.materials = materialsJson;

  // Accessors/bufferViews
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const chunks: Buffer[] = [];
  let byteOffset = 0;

  const pushView = (data: Buffer, target?: number): number => {
    const aligned = pad4(data);
    chunks.push(aligned);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length, ...(target ? { target } : {}) });
    byteOffset += aligned.length;
    return bufferViews.length - 1;
  };

  const pushAccessor = (viewIdx: number, componentType: number, count: number, type: string, minMax?: { min: number[]; max: number[] }): number => {
    accessors.push({ bufferView: viewIdx, componentType, count, type, ...(minMax ? { min: minMax.min, max: minMax.max } : {}) });
    return accessors.length - 1;
  };

  const nodes: Record<string, unknown>[] = [];
  const meshesJson: Record<string, unknown>[] = [];
  model.meshes.forEach((mesh, mi) => {
    const primitives: Record<string, unknown>[] = [];
    const posView = pushView(bufferFrom(mesh.positions), 34962);
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
    if (!Number.isFinite(min[0])) min = [0, 0, 0], max = [0, 0, 0];
    const posAcc = pushAccessor(posView, 5126, mesh.positions.length / 3, 'VEC3', { min, max });
    const prim: Record<string, unknown> = { attributes: { POSITION: posAcc } };
    const attrs = prim.attributes as Record<string, number>;
    if (mesh.normals && mesh.normals.length === mesh.positions.length) {
      const nView = pushView(bufferFrom(mesh.normals), 34962);
      attrs.NORMAL = pushAccessor(nView, 5126, mesh.normals.length / 3, 'VEC3');
    }
    if (mesh.uvs && mesh.uvs.length / 2 === mesh.positions.length / 3) {
      const uvView = pushView(bufferFrom(mesh.uvs), 34962);
      attrs.TEXCOORD_0 = pushAccessor(uvView, 5126, mesh.uvs.length / 2, 'VEC2');
    }
    if (mesh.indices && mesh.indices.length) {
      const iView = pushView(bufferFrom(mesh.indices), 34963);
      prim.indices = pushAccessor(iView, 5125, mesh.indices.length, 'SCALAR');
    }
    if (mesh.material && matIndex.has(mesh.material)) prim.material = matIndex.get(mesh.material)!;
    primitives.push(prim);
    meshesJson.push({ name: mesh.name || `mesh_${mi}`, primitives });
    nodes.push({ mesh: mi, name: mesh.name || `node_${mi}` });
  });
  json.meshes = meshesJson;
  json.nodes = nodes;

  // Textures/images/samplers
  if (buffers.images.length) {
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    const imagesJson: Record<string, unknown>[] = [];
    const texturesJson: Record<string, unknown>[] = [];
    buffers.images.forEach((im, i) => {
      const view = pushView(im.bytes);
      imagesJson.push(opts.embedTextures === false
        ? { name: im.name, uri: im.file ?? `${im.name}.${extOf(im.mime)}` }
        : { name: im.name, bufferView: view, mimeType: im.mime });
      texturesJson.push({ sampler: 0, source: i });
    });
    json.images = imagesJson;
    json.textures = texturesJson;
  }
  json.bufferViews = bufferViews;
  json.accessors = accessors;
  const bin = Buffer.concat(chunks);
  if (bin.length) json.buffers = [{ byteLength: bin.length }];
  else delete json.buffers;
  return { json, bin };
}

export function writeGlb(model: ModelData, outPath: string, opts: GltfBuildOpts = {}): void {
  const images: { name: string; mime: string; bytes: Buffer; file?: string }[] = model.images.map((im) => ({
    name: im.name, mime: im.mimeType, bytes: im.bytes ?? Buffer.alloc(0), file: im.file,
  }));
  const { json, bin } = buildGltfJson(model, { ...opts, embedTextures: true }, { bin: [], images });
  const jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const binPadded = pad4(bin);
  const total = 12 + 8 + jsonPadded.length + (binPadded.length ? 8 + binPadded.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded.length, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  jsonPadded.copy(out, 20);
  if (binPadded.length) {
    const off = 20 + jsonPadded.length;
    out.writeUInt32LE(binPadded.length, off);
    out.writeUInt32LE(CHUNK_BIN, off + 4);
    binPadded.copy(out, off + 8);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out);
}

export function writeGltf(model: ModelData, outPath: string, opts: { outDir: string; baseName: string }): { files: string[] } {
  const files: string[] = [];
  const images: { name: string; mime: string; bytes: Buffer; file?: string }[] = model.images.map((im) => ({
    name: im.name,
    mime: im.mimeType,
    bytes: im.bytes ?? Buffer.alloc(0),
    file: `${im.name}.${extOf(im.mimeType)}`,
  }));
  const { json, bin } = buildGltfJson(model, { embedTextures: false }, { bin: [], images });
  fs.mkdirSync(opts.outDir, { recursive: true });
  const binPath = path.join(opts.outDir, `${opts.baseName}.bin`);
  if (bin.length) {
    fs.writeFileSync(binPath, bin);
    files.push(binPath);
    (json.buffers as Record<string, unknown>[])[0].uri = `${opts.baseName}.bin`;
  } else delete json.buffers;
  for (const im of images) {
    const p = path.join(opts.outDir, im.file!);
    if (im.bytes.length) { fs.writeFileSync(p, im.bytes); files.push(p); }
  }
  const jsonPath = path.join(opts.outDir, `${opts.baseName}.gltf`);
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 1));
  files.push(jsonPath);
  return { files };
}

function pad4(b: Buffer): Buffer {
  const pad = (4 - (b.length % 4)) % 4;
  return pad ? Buffer.concat([b, Buffer.alloc(pad, 0)]) : b;
}

function extOf(mime: string): string {
  return mime === 'image/jpeg' ? 'jpg' : 'png';
}

// ------------------------------------------------------------------- reader

export interface ReadGltfResult {
  model: ModelData;
  animationsCount: number;
  hasSkeleton: boolean;
}

export function readGlbOrGltf(buf: Buffer, sourcePath: string): ReadGltfResult {
  const isGlb = buf.subarray(0, 4).toString('ascii') === 'glTF';
  let gltf: Record<string, any> | null = null;
  let bin: Buffer | null = null;
  if (isGlb) {
    const version = buf.readUInt32LE(4);
    if (version !== 2) throw new Error(`unsupported GLB version ${version}`);
    let off = 12;
    while (off < buf.length) {
      const len = buf.readUInt32LE(off);
      const type = buf.readUInt32LE(off + 4);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === CHUNK_JSON) gltf = JSON.parse(data.toString('utf8'));
      else if (type === CHUNK_BIN) bin = data;
      off += 8 + len;
    }
  } else {
    const parsed: Record<string, any> = JSON.parse(buf.toString('utf8'));
    gltf = parsed;
    const buffers0 = (parsed.buffers ?? [])[0];
    if (buffers0?.uri) {
      if (buffers0.uri.startsWith('data:')) {
        bin = Buffer.from(buffers0.uri.split(',')[1], 'base64');
      } else {
        bin = fs.readFileSync(path.join(path.dirname(sourcePath), decodeURIComponent(buffers0.uri)));
      }
    }
  }

  if (!gltf) throw new Error('malformed glTF container: no JSON chunk');
  const model: ModelData = emptyModelRead();
  model.hasSkeleton = !!(gltf.skins?.length);
  model.animations = (gltf.animations ?? []).map((a: Record<string, any>) => ({ name: a.name ?? 'animation' }));

  const bufferViews: Record<string, any>[] = gltf.bufferViews ?? [];
  const accessors: Record<string, any>[] = gltf.accessors ?? [];
  const readAccessor = (idx: number): Float32Array | Uint32Array | null => {
    const acc = accessors[idx];
    if (!acc || acc.bufferView === undefined) return null;
    const view = bufferViews[acc.bufferView];
    const base = bin ?? Buffer.alloc(0);
    const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const count = acc.count * NUM_COMPONENTS[acc.type];
    if (acc.componentType === 5126) {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = base.readFloatLE(start + i * 4);
      return out;
    }
    if (acc.componentType === 5125) {
      const out = new Uint32Array(count);
      for (let i = 0; i < count; i++) out[i] = base.readUInt32LE(start + i * 4);
      return out;
    }
    return null;
  };

  const materials: Record<string, any>[] = gltf.materials ?? [];
  model.materials = materials.map((m, i) => ({
    name: m.name ?? `material_${i}`,
    baseColor: m.pbrMetallicRoughness?.baseColorFactor,
    metallic: m.pbrMetallicRoughness?.metallicFactor,
    roughness: m.pbrMetallicRoughness?.roughnessFactor,
    doubleSided: !!m.doubleSided,
  }));

  (gltf.meshes ?? []).forEach((m: Record<string, any>, mi: number) => {
    (m.primitives ?? []).forEach((prim: Record<string, any>, pi: number) => {
      const attrs = prim.attributes ?? {};
      const positions = readAccessor(attrs.POSITION) as Float32Array | null;
      if (!positions) return;
      const mesh: MeshData = {
        name: m.name ? `${m.name}${pi ? '_' + pi : ''}` : `mesh_${mi}_${pi}`,
        positions,
      };
      if (attrs.NORMAL) mesh.normals = readAccessor(attrs.NORMAL) as Float32Array;
      if (attrs.TEXCOORD_0) mesh.uvs = readAccessor(attrs.TEXCOORD_0) as Float32Array;
      if (prim.indices !== undefined) mesh.indices = readAccessor(prim.indices) as Uint32Array;
      if (prim.material !== undefined) mesh.material = model.materials[prim.material]?.name;
      model.meshes.push(mesh);
    });
  });

  // Embedded images (for stats / re-emit)
  (gltf.images ?? []).forEach((img: Record<string, any>, i: number) => {
    let bytes: Buffer = Buffer.alloc(0);
    let file = '';
    if (img.bufferView !== undefined && bin) {
      const view = bufferViews[img.bufferView];
      bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + (view.byteLength ?? 0));
    } else if (typeof img.uri === 'string' && !img.uri.startsWith('data:')) {
      file = img.uri;
    } else if (typeof img.uri === 'string') {
      bytes = Buffer.from(img.uri.split(',')[1] ?? '', 'base64');
    }
    model.images.push({ name: img.name ?? `image_${i}`, file, bytes: bytes.length ? bytes : undefined, mimeType: img.mimeType ?? 'image/png' });
  });

  return { model, animationsCount: model.animations.length, hasSkeleton: model.hasSkeleton };
}

function emptyModelRead(): ModelData {
  return { meshes: [], materials: [], images: [], animations: [], hasSkeleton: false };
}

const NUM_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// ---------------------------------------------------------------- OBJ writer

export function writeObj(model: ModelData, outPath: string, opts: { outDir: string; baseName: string }): { files: string[] } {
  const files: string[] = [];
  fs.mkdirSync(opts.outDir, { recursive: true });
  const lines: string[] = ['# Written by Universal Game Asset Hub'];
  let vOffset = 0;
  let mtlUsed = false;
  for (const im of model.images) {
    if (im.bytes?.length) {
      const p = path.join(opts.outDir, `${im.name}.${extOf(im.mimeType)}`);
      fs.writeFileSync(p, im.bytes);
      files.push(p);
    } else if (im.file) {
      try { fs.copyFileSync(im.file, path.join(opts.outDir, path.basename(im.file))); files.push(path.join(opts.outDir, path.basename(im.file))); } catch { /* missing source texture */ }
    }
  }
  for (const m of model.materials) mtlUsed = true;
  for (const mesh of model.meshes) {
    lines.push(`o ${mesh.name.replace(/\s+/g, '_')}`);
    if (mesh.material) lines.push(`usemtl ${mesh.material}`);
    for (let i = 0; i < mesh.positions.length; i += 3) lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`);
    if (mesh.uvs) for (let i = 0; i < mesh.uvs.length; i += 2) lines.push(`vt ${mesh.uvs[i]} ${mesh.uvs[i + 1]}`);
    if (mesh.normals) for (let i = 0; i < mesh.normals.length; i += 3) lines.push(`vn ${mesh.normals[i]} ${mesh.normals[i + 1]} ${mesh.normals[i + 2]}`);
    if (mesh.indices) {
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const face: string[] = [];
        for (const k of [0, 1, 2]) {
          const vi = mesh.indices[i + k] + 1 + vOffset;
          const hasUv = !!mesh.uvs, hasN = !!mesh.normals;
          face.push(hasUv && hasN ? `${vi}/${vi}/${vi}` : hasUv ? `${vi}/${vi}` : hasN ? `${vi}//${vi}` : `${vi}`);
        }
        lines.push(`f ${face.join(' ')}`);
      }
    } else {
      for (let i = 0; i < mesh.positions.length / 3; i += 3) {
        const face: string[] = [];
        for (let k = 0; k < 3; k++) {
          const vi = i + k + 1 + vOffset;
          const hasUv = !!mesh.uvs, hasN = !!mesh.normals;
          face.push(hasUv && hasN ? `${vi}/${vi}/${vi}` : hasUv ? `${vi}/${vi}` : hasN ? `${vi}//${vi}` : `${vi}`);
        }
        lines.push(`f ${face.join(' ')}`);
      }
    }
    vOffset += mesh.positions.length / 3;
  }
  const objPath = path.join(opts.outDir, `${opts.baseName}.obj`);
  if (mtlUsed) {
    const mtl: string[] = ['# Written by Universal Game Asset Hub'];
    for (const m of model.materials) {
      mtl.push(`newmtl ${m.name}`);
      const c = m.baseColor ?? [1, 1, 1, 1];
      mtl.push(`Kd ${c[0]} ${c[1]} ${c[2]}`);
      mtl.push(`Ns ${Math.round((1 - (m.roughness ?? 0.8)) * 1000)}`);
      if (m.textures?.baseColor) mtl.push(`map_Kd ${m.textures.baseColor}`);
      mtl.push('');
    }
    fs.writeFileSync(path.join(opts.outDir, `${opts.baseName}.mtl`), mtl.join('\n'));
    lines.splice(1, 0, `mtllib ${opts.baseName}.mtl`);
  }
  fs.writeFileSync(objPath, lines.join('\n'));
  files.push(objPath);
  return { files };
}


function bufferFrom(typed: Float32Array | Uint32Array): Buffer {
  return Buffer.from(typed.buffer as ArrayBuffer, typed.byteOffset, typed.byteLength);
}
