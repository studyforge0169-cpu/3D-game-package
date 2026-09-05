/**
 * Mesh data model + parsers for the conversion pipeline (spec §7).
 * All parsers produce the same MeshData/ModelData representation which the
 * writers (GLB/glTF/OBJ) and processors (LOD, collision, stats) consume.
 */

export interface MeshData {
  name: string;
  positions: Float32Array;          // xyz
  normals?: Float32Array;           // xyz (optional)
  uvs?: Float32Array;               // uv (optional)
  indices?: Uint32Array;            // triangle list (optional = non-indexed)
  material?: string;                // material name ref
}

export interface MaterialDef {
  name: string;
  baseColor?: [number, number, number, number]; // linear rgba 0..1
  metallic?: number;
  roughness?: number;
  /** Texture image references by name (albedo/normal/roughness/metallic). */
  textures?: Partial<Record<'baseColor' | 'normal' | 'metallicRoughness' | 'occlusion' | 'emissive', string>>;
  doubleSided?: boolean;
}

export interface ImageData {
  name: string;      // logical name e.g. "wood_albedo"
  file: string;      // source file path (absolute) or '' if embedded bytes
  bytes?: Buffer;    // embedded image bytes (GLB)
  mimeType: string;  // image/png | image/jpeg
}

export interface ModelData {
  meshes: MeshData[];
  materials: MaterialDef[];
  images: ImageData[];
  animations: { name: string }[];
  hasSkeleton: boolean;
}

export function emptyModel(): ModelData {
  return { meshes: [], materials: [], images: [], animations: [], hasSkeleton: false };
}

export function computeBoundingBox(meshes: MeshData[]): { min: [number, number, number]; max: [number, number, number] } {
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = m.positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  if (!Number.isFinite(min[0])) { min = [0, 0, 0]; max = [0, 0, 0]; }
  return { min, max };
}

export function triangleCount(m: MeshData): number {
  return m.indices ? m.indices.length / 3 : m.positions.length / 9;
}

// ---------------------------------------------------------------- OBJ parser

export interface ParseOpts {
  mtlResolver?: (name: string) => string | null; // resolve referenced .mtl content
  dir?: string; // base dir for texture references
}

export function parseObj(text: string, opts: ParseOpts = {}): ModelData {
  const model = emptyModel();
  const pos: number[] = [], norm: number[] = [], uv: number[] = [];
  let current: MeshData | null = null;
  const materialMap = new Map<string, number>();

  const ensureMesh = (name: string): MeshData => {
    if (!current) current = { name, positions: new Float32Array(0) };
    return current;
  };

  const meshes: MeshData[] = [];
  let positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];

  const pushFace = (tokens: string[]): void => {
    const tri: [number, number, number][] = [];
    for (const t of tokens) {
      const parts = t.split('/');
      const v = parseInt(parts[0], 10);
      if (Number.isNaN(v)) continue;
      tri.push([v, parts[1] ? parseInt(parts[1], 10) : 0, parts[2] ? parseInt(parts[2], 10) : 0]);
    }
    for (let i = 1; i < tri.length - 1; i++) {
      const face = [tri[0], tri[i], tri[i + 1]];
      const outPos: number[] = [], outNorm: number[] = [], outUv: number[] = [];
      for (const [vi, ti, ni] of face) {
        const pi = (vi > 0 ? vi - 1 : pos.length / 3 + vi) * 3;
        outPos.push(pos[pi], pos[pi + 1], pos[pi + 2]);
        if (ti) {
          const ui = (ti > 0 ? ti - 1 : uv.length / 2 + ti) * 2;
          outUv.push(uv[ui], uv[ui + 1]);
        }
        if (ni) {
          const niIdx = (ni > 0 ? ni - 1 : norm.length / 3 + ni) * 3;
          outNorm.push(norm[niIdx], norm[niIdx + 1], norm[niIdx + 2]);
        }
      }
      const base = positions.length / 3;
      positions.push(...outPos);
      if (outUv.length) uvs.push(...outUv);
      if (outNorm.length) normals.push(...outNorm);
      indices.push(base, base + 1, base + 2);
    }
  };

  let currentMaterial: string | undefined;
  let objectName = 'obj';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [kw, ...rest] = line.split(/\s+/);
    switch (kw) {
      case 'v': pos.push(parseFloat(rest[0]), parseFloat(rest[1]), parseFloat(rest[2])); break;
      case 'vn': norm.push(parseFloat(rest[0]), parseFloat(rest[1]), parseFloat(rest[2])); break;
      case 'vt': uv.push(parseFloat(rest[0]), parseFloat(rest[1])); break;
      case 'f': pushFace(rest); break;
      case 'o': case 'g': {
        if (positions.length) {
          meshes.push(makeMesh(objectName, positions, normals, uvs, indices, currentMaterial));
          positions = []; normals = []; uvs = []; indices = [];
        }
        objectName = rest[0] ?? objectName;
        break;
      }
      case 'usemtl': currentMaterial = rest[0]; break;
      case 'mtllib': {
        const mtl = opts.mtlResolver?.(rest[0]);
        if (mtl) parseMtl(mtl, model, materialMap, opts.dir);
        break;
      }
      default: break;
    }
  }
  if (positions.length) meshes.push(makeMesh(objectName, positions, normals, uvs, indices, currentMaterial));
  model.meshes = meshes;
  ensureMesh('none'); // no-op to satisfy lint
  return model;
}

function makeMesh(name: string, pos: number[], norm: number[], uv: number[], idx: number[], material?: string): MeshData {
  const mesh: MeshData = {
    name,
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx),
    material,
  };
  if (norm.length === pos.length) mesh.normals = new Float32Array(norm);
  if (uv.length / 2 === pos.length / 3) mesh.uvs = new Float32Array(uv);
  return mesh;
}

export function parseMtl(text: string, model: ModelData, map: Map<string, number>, dir?: string): void {
  let cur: MaterialDef | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [kw, ...rest] = line.split(/\s+/);
    const val = rest.join(' ');
    if (kw === 'newmtl') {
      cur = { name: val };
      map.set(val, model.materials.length);
      model.materials.push(cur);
    } else if (!cur) continue;
    else if (kw === 'Kd') cur.baseColor = [parseFloat(rest[0]), parseFloat(rest[1]), parseFloat(rest[2]), 1];
    else if (kw === 'Ns') cur.roughness = Math.max(0.0, 1 - Math.min(1, parseFloat(rest[0]) / 1000));
    else if (kw === 'map_Kd') cur.textures = { ...cur.textures, baseColor: cleanTextureName(val) };
    else if (kw === 'map_Bump' || kw === 'bump' || kw === 'norm') cur.textures = { ...cur.textures, normal: cleanTextureName(val) };
    else if (kw === 'map_Ks') cur.textures = { ...cur.textures, metallicRoughness: cleanTextureName(val) };
    else if (kw === 'map_d') cur.doubleSided = true;
  }
  void dir;
}

function cleanTextureName(v: string): string {
  return v.trim().replace(/^"|"$/g, '');
}

// ---------------------------------------------------------------- STL parser

export function parseStl(buf: Buffer): ModelData {
  const model = emptyModel();
  // ASCII?
  const head = buf.subarray(0, Math.min(200, buf.length)).toString('latin1').trim().toLowerCase();
  if (head.startsWith('solid') && !looksBinaryStl(buf)) {
    const text = buf.toString('latin1');
    const pos: number[] = [], norm: number[] = [];
    const re = /facet\s+normal\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)[\s\S]*?outer\s+loop([\s\S]*?)endloop/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const n = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
      const verts = [...m[4].matchAll(/vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g)].map((x) => [parseFloat(x[1]), parseFloat(x[2]), parseFloat(x[3])]);
      for (const v of verts) { pos.push(...v); norm.push(...n); }
    }
    model.meshes.push({ name: 'stl', positions: new Float32Array(pos), normals: norm.length ? new Float32Array(norm) : undefined });
    return model;
  }
  // Binary STL: 80 header + uint32 count + 50-byte triangles
  const count = buf.readUInt32LE(80);
  const pos: number[] = [], norm: number[] = [];
  let off = 84;
  for (let i = 0; i < count && off + 50 <= buf.length; i++, off += 50) {
    for (let v = 0; v < 3; v++) {
      const b = off + 12 + v * 12;
      pos.push(buf.readFloatLE(b), buf.readFloatLE(b + 4), buf.readFloatLE(b + 8));
      norm.push(buf.readFloatLE(off), buf.readFloatLE(off + 4), buf.readFloatLE(off + 8));
    }
  }
  model.meshes.push({ name: 'stl', positions: new Float32Array(pos), normals: new Float32Array(norm) });
  return model;
}

function looksBinaryStl(buf: Buffer): boolean {
  if (buf.length < 84) return false;
  const count = buf.readUInt32LE(80);
  return 84 + count * 50 === buf.length;
}

// ---------------------------------------------------------------- PLY parser

export function parsePly(buf: Buffer): ModelData {
  const model = emptyModel();
  const headerEnd = buf.indexOf('end_header\n');
  if (headerEnd < 0) return model;
  const header = buf.subarray(0, headerEnd).toString('ascii');
  const body = buf.subarray(headerEnd + 'end_header\n'.length);
  const lines = header.split(/\r?\n/);
  let format = 'ascii';
  const vertexProps: { name: string; type: string; offset: number; size: number }[] = [];
  let vertexCount = 0, faceCount = 0, propOffset = 0;
  let element = '';
  const SIZES: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  for (const line of lines) {
    const [kw, ...rest] = line.trim().split(/\s+/);
    if (kw === 'format') format = rest[0];
    else if (kw === 'element') { element = rest[0]; if (element === 'vertex') vertexCount = parseInt(rest[1], 10); if (element === 'face') faceCount = parseInt(rest[1], 10); if (element === 'vertex') propOffset = 0; }
    else if (kw === 'property' && element === 'vertex' && rest[0] !== 'list') {
      vertexProps.push({ name: rest[1], type: rest[0], offset: propOffset, size: SIZES[rest[0]] ?? 4 });
      propOffset += SIZES[rest[0]] ?? 4;
    }
  }
  const stride = propOffset;
  const pos: number[] = [], norm: number[] = [], uv: number[] = [], idx: number[] = [];
  const prop = (name: string) => vertexProps.find((p) => p.name === name);

  if (format === 'ascii') {
    const rows = body.toString('ascii').split(/\r?\n/).filter(Boolean);
    for (let i = 0; i < Math.min(vertexCount, rows.length); i++) {
      const cols = rows[i].trim().split(/\s+/).map(parseFloat);
      const px = prop('x'), py = prop('y'), pz = prop('z');
      if (!px || !py || !pz) break;
      pos.push(cols[px.offset] ?? 0, cols[py.offset] ?? 0, cols[pz.offset] ?? 0);
      const nx = prop('nx'), ny = prop('ny'), nz = prop('nz');
      if (nx && ny && nz) norm.push(cols[nx.offset] ?? 0, cols[ny.offset] ?? 0, cols[nz.offset] ?? 0);
      const s = prop('s') ?? prop('u') ?? prop('texture_u'), t = prop('t') ?? prop('v') ?? prop('texture_v');
      if (s && t) uv.push(cols[s.offset] ?? 0, cols[t.offset] ?? 0);
    }
    for (let i = vertexCount; i < rows.length && idx.length / 3 < faceCount; i++) {
      const cols = rows[i].trim().split(/\s+/).map(parseFloat);
      const n = cols[0];
      for (let k = 1; k + 1 < n; k++) idx.push(cols[1], cols[1 + k], cols[2 + k]);
    }
  } else {
    const le = format.includes('little');
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let off = 0;
    for (let i = 0; i < vertexCount && off + stride <= body.length; i++, off += stride) {
      let x = 0, y = 0, z = 0;
      for (const p of vertexProps) {
        const v = readNum(dv, off + p.offset, p.type, le);
        if (p.name === 'x') x = v; else if (p.name === 'y') y = v; else if (p.name === 'z') z = v;
        else if (p.name === 'nx') { /* skip: pushed below via per-vertex props */ }
      }
      pos.push(x, y, z);
      const nx = prop('nx'), ny = prop('ny'), nz = prop('nz');
      if (nx && ny && nz) {
        norm.push(readNum(dv, off + nx.offset, nx.type, le), readNum(dv, off + ny.offset, ny.type, le), readNum(dv, off + nz.offset, nz.type, le));
      }
      const s = prop('s') ?? prop('u'), t = prop('t') ?? prop('v');
      if (s && t) uv.push(readNum(dv, off + s.offset, s.type, le), readNum(dv, off + t.offset, t.type, le));
    }
    // faces (assume list uchar int vertex_indices)
    let foff = off;
    for (let i = 0; i < faceCount; i++) {
      if (foff + 1 > body.length) break;
      const n = dv.getUint8(foff); foff += 1;
      const face: number[] = [];
      for (let k = 0; k < n; k++) {
        face.push(dv.getUint32(foff, true));
        foff += 4;
      }
      for (let k = 1; k + 1 < face.length; k++) idx.push(face[0], face[k], face[k + 1]);
    }
  }
  const mesh: MeshData = { name: 'ply', positions: new Float32Array(pos) };
  if (norm.length === pos.length) mesh.normals = new Float32Array(norm);
  if (uv.length / 2 === pos.length / 3) mesh.uvs = new Float32Array(uv);
  if (idx.length) mesh.indices = new Uint32Array(idx);
  model.meshes.push(mesh);
  return model;
}

function readNum(dv: DataView, off: number, type: string, le: boolean): number {
  switch (type) {
    case 'float': case 'float32': return dv.getFloat32(off, le);
    case 'double': case 'float64': return dv.getFloat64(off, le);
    case 'uchar': case 'uint8': return dv.getUint8(off);
    case 'char': case 'int8': return dv.getInt8(off);
    case 'ushort': case 'uint16': return dv.getUint16(off, le);
    case 'short': case 'int16': return dv.getInt16(off, le);
    case 'uint': case 'uint32': return dv.getUint32(off, le);
    default: return dv.getInt32(off, le);
  }
}
