import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertAsset } from '../src/core/convert/pipeline';
import { readGlbOrGltf, writeGlb, writeObj } from '../src/core/convert/gltf';
import { parseObj, parseStl, parsePly, triangleCount } from '../src/core/convert/mesh';
import { geometryFingerprint } from '../src/core/convert/stats';
import { decimateMesh } from '../src/core/convert/pipeline';

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugah-conv-'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CUBE_OBJ = `
# simple textured cube-ish quad
mtllib cube.mtl
usemtl wood
v -1 -1 0
v  1 -1 0
v  1  1 0
v -1  1 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
f 1/1/1 2/2/1 3/3/1
f 1/1/1 3/3/1 4/4/1
`;

const CUBE_MTL = `
newmtl wood
Kd 0.8 0.6 0.4
Ns 250
map_Kd wood_albedo.png
`;

function binaryStl(tris: number): Buffer {
  const buf = Buffer.alloc(84 + tris * 50);
  for (let i = 0; i < tris; i++) {
    const off = 84 + i * 50;
    buf.writeFloatLE(0, off); buf.writeFloatLE(0, off + 4); buf.writeFloatLE(1, off + 8);
    for (let v = 0; v < 3; v++) {
      buf.writeFloatLE(v, off + 12 + v * 12);
      buf.writeFloatLE(i % 10, off + 16 + v * 12);
      buf.writeFloatLE(0, off + 20 + v * 12);
    }
  }
  buf.writeUInt32LE(tris, 80);
  return buf;
}

describe('mesh parsers', () => {
  it('parses OBJ with materials/UVs/normals', () => {
    const m = parseObj(CUBE_OBJ, { mtlResolver: () => CUBE_MTL });
    expect(m.meshes).toHaveLength(1);
    expect(triangleCount(m.meshes[0])).toBe(2);
    expect(m.meshes[0].uvs).toBeTruthy();
    expect(m.meshes[0].normals).toBeTruthy();
    expect(m.materials[0].name).toBe('wood');
    expect(m.materials[0].textures?.baseColor).toBe('wood_albedo.png');
  });

  it('parses binary STL', () => {
    const m = parseStl(binaryStl(10));
    expect(triangleCount(m.meshes[0])).toBe(10);
    expect(m.meshes[0].normals!.length).toBe(90);
  });

  it('parses ASCII STL', () => {
    const ascii = `solid x
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid x`;
    const m = parseStl(Buffer.from(ascii));
    expect(triangleCount(m.meshes[0])).toBe(1);
  });

  it('parses binary PLY with vertex normals', () => {
    const header = [
      'ply', 'format binary_little_endian 1.0',
      'element vertex 3',
      'property float x', 'property float y', 'property float z',
      'property float nx', 'property float ny', 'property float nz',
      'element face 1',
      'property list uchar int vertex_indices',
      'end_header', '',
    ].join('\n');
    const body = Buffer.alloc(3 * 24 + 1 + 3 * 4);
    for (let i = 0; i < 3; i++) {
      body.writeFloatLE(i, i * 24);
      body.writeFloatLE(i, i * 24 + 4);
      body.writeFloatLE(0, i * 24 + 8);
      body.writeFloatLE(0, i * 24 + 12);
      body.writeFloatLE(1, i * 24 + 16);
      body.writeFloatLE(0, i * 24 + 20);
    }
    body.writeUInt8(3, 72);
    body.writeUInt32LE(0, 73); body.writeUInt32LE(1, 77); body.writeUInt32LE(2, 81);
    const m = parsePly(Buffer.concat([Buffer.from(header, 'ascii'), body]));
    expect(m.meshes[0].positions.length).toBe(9);
    expect(m.meshes[0].normals!.length).toBe(9);
    expect(Array.from(m.meshes[0].indices!)).toEqual([0, 1, 2]);
  });
});

describe('GLB writer/reader round-trips', () => {
  it('OBJ → GLB → parse gives the same geometry and material', async () => {
    const src = path.join(tmp, 'cube.obj');
    fs.writeFileSync(src, CUBE_OBJ);
    fs.writeFileSync(path.join(tmp, 'cube.mtl'), CUBE_MTL);
    // tiny valid png (1x1) as albedo
    fs.copyFileSync(await makePng(path.join(tmp, 'wood_albedo.png')), path.join(tmp, 'wood_albedo.png'));
    const out = path.join(tmp, 'out1');
    const res = await convertAsset(src, out, { targetFormat: 'glb' });
    expect(res.ok).toBe(true);
    const glbPath = res.outputs.find((o) => o.kind === 'model')!.path;
    expect(glbPath.endsWith('.glb')).toBe(true);
    const read = readGlbOrGltf(fs.readFileSync(glbPath), glbPath);
    expect(read.model.meshes.length).toBe(1);
    expect(triangleCount(read.model.meshes[0])).toBe(2);
    expect(read.model.meshes[0].material).toBe('wood');
    expect(res.stats!.faces).toBe(2);
    expect(res.stats!.hasUvs).toBe(true);
  });

  it('STL → GLB → OBJ chain works', async () => {
    const stl = path.join(tmp, 'part.stl');
    fs.writeFileSync(stl, binaryStl(24));
    const glbDir = path.join(tmp, 'stl-glb');
    const r1 = await convertAsset(stl, glbDir, { targetFormat: 'glb', recomputeNormals: true });
    expect(r1.ok).toBe(true);
    const glb = r1.outputs[0].path;
    const r2 = await convertAsset(glb, path.join(tmp, 'glb-obj'), { targetFormat: 'obj' });
    expect(r2.ok).toBe(true);
    const objFile = r2.outputs.find((o) => o.path.endsWith('.obj'))!.path;
    const reparsed = parseObj(fs.readFileSync(objFile, 'utf8'), {});
    expect(triangleCount(reparsed.meshes[0])).toBe(24);
  });

  it('GLB → glTF with external files', async () => {
    const glb = path.join(tmp, 'ext.glb');
    const model = parseObj(CUBE_OBJ, { mtlResolver: () => CUBE_MTL });
    writeGlb(model, glb);
    const r = await convertAsset(glb, path.join(tmp, 'ext-out'), { targetFormat: 'gltf' });
    expect(r.ok).toBe(true);
    expect(r.outputs.some((o) => o.path.endsWith('.gltf'))).toBe(true);
    expect(r.outputs.some((o) => o.path.endsWith('.bin'))).toBe(true);
  });
});

describe('processing ops', () => {
  it('decimation reduces faces and LODs are written', async () => {
    const stl = path.join(tmp, 'dense.stl');
    fs.writeFileSync(stl, binaryStl(2000));
    const mesh = parseStl(fs.readFileSync(stl)).meshes[0];
    const dec = decimateMesh(mesh, 0.25);
    // vertex-clustering merges vertices → drastically fewer verts, faces ≤ original
    expect(dec.positions.length / 3).toBeLessThan(mesh.positions.length / 3);
    expect(triangleCount(dec)).toBeLessThanOrEqual(triangleCount(mesh));
    const r = await convertAsset(stl, path.join(tmp, 'lods'), {
      targetFormat: 'glb',
      generateLods: { levels: [{ ratio: 0.5, suffix: '_lod1' }, { ratio: 0.25, suffix: '_lod2' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.outputs.filter((o) => o.kind === 'lod')).toHaveLength(2);
  });

  it('collision proxies: bbox and decimated', async () => {
    const stl = path.join(tmp, 'col.stl');
    fs.writeFileSync(stl, binaryStl(100));
    const bbox = await convertAsset(stl, path.join(tmp, 'col-bbox'), { targetFormat: 'glb', generateCollision: 'bbox' });
    expect(bbox.ok).toBe(true);
    expect(bbox.outputs.some((o) => o.kind === 'collision')).toBe(true);
    const dec = await convertAsset(stl, path.join(tmp, 'col-dec'), { targetFormat: 'glb', generateCollision: 'decimated', decimateRatio: 0.3 });
    expect(dec.ok).toBe(true);
  });

  it('geometry fingerprints are stable across format changes (dup detection)', async () => {
    const stl = path.join(tmp, 'fp.stl');
    fs.writeFileSync(stl, binaryStl(50));
    const glb = path.join(tmp, 'fp.glb');
    const r = await convertAsset(stl, path.join(tmp, 'fp-out'), { targetFormat: 'glb' });
    expect(r.ok).toBe(true);
    fs.copyFileSync(r.outputs[0].path, glb);
    const fp1 = geometryFingerprint(parseStl(fs.readFileSync(stl)));
    const fp2 = geometryFingerprint(readGlbOrGltf(fs.readFileSync(glb), glb).model);
    expect(fp2).toBe(fp1);
    // different geometry → different fingerprint
    const other = geometryFingerprint(parseStl(binaryStl(7)));
    expect(other).not.toBe(fp1);
  });

  it('FBX conversion reports honestly when no external tool is available', async () => {
    const r = await convertAsset('/fake/model.fbx', path.join(tmp, 'fbx-out'), { targetFormat: 'glb' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Blender|assimp/i);
  });
});

async function makePng(p: string): Promise<string> {
  const Jimp = (await import('jimp')).default;
  const img = new Jimp(1, 1, 0xff0000ff);
  await img.writeAsync(p);
  return p;
}
