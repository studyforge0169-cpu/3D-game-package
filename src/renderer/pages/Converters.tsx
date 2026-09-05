/** Converters (spec §7): game-ready pipeline with honest capability reporting. */

import React, { useEffect, useState } from 'react';
import type { ConvertResult, LibraryAsset } from '../../core/types';
import { api, ConverterToolsDto } from '../api';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';

export default function Converters() {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [target, setTarget] = useState<'glb' | 'gltf' | 'obj' | 'fbx'>('glb');
  const [tools, setTools] = useState<ConverterToolsDto | null>(null);
  const [opts, setOpts] = useState({
    resize: false, resizeMax: 2048,
    jpeg: false, jpegQuality: 85,
    weld: true, recomputeNormals: false, prune: true,
    lods: false, lodRatios: '0.5,0.25',
    collision: 'none' as 'none' | 'bbox' | 'decimated',
  });
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    void api.librarySearch({}).then(setAssets);
    void api.converterTools().then(setTools);
  }, []);

  const convert = async (a: LibraryAsset) => {
    setBusy(a.id);
    setResult(null);
    try {
      const ratios = opts.lods ? opts.lodRatios.split(',').map((r, i) => ({ ratio: Number(r.trim()) || 0.5, suffix: `_lod${i + 1}` })) : undefined;
      const r = await api.convertAsset(a.id, {
        targetFormat: target,
        textureResize: opts.resize ? { maxSize: opts.resizeMax } : undefined,
        textureCompress: opts.jpeg ? { format: 'jpeg', quality: opts.jpegQuality } : undefined,
        weldVertices: opts.weld || undefined,
        recomputeNormals: opts.recomputeNormals || undefined,
        pruneUnusedMaterials: opts.prune || undefined,
        generateLods: ratios ? { levels: ratios } : undefined,
        generateCollision: opts.collision,
      });
      setResult(r);
      toast({ message: r.ok ? `Converted → ${r.outputs.length} file(s)` : `Conversion failed: ${r.error}`, kind: r.ok ? 'success' : 'error' });
    } catch (e) {
      toast({ message: String((e as Error).message ?? e), kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="panel">
        <h2>⚙ Conversion pipeline</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Originals are never modified — outputs go to <code>Processed/</code> and <code>GameReady/</code> inside the asset folder.
          Native conversions: OBJ/STL/PLY → GLB/GLTF/OBJ and GLB↔GLTF. FBX/BLEND/DAE import needs an external tool.
        </p>
        <div className="row wrap">
          <span className="badge neutral">native: OBJ · STL · PLY · GLB · GLTF</span>
          <span className={`badge ${tools?.assimp.available ? 'green' : 'yellow'}`}>assimp {tools?.assimp.available ? `✓ (${tools.assimp.path})` : 'not found — FBX/DAE unavailable'}</span>
          <span className={`badge ${tools?.blender.available ? 'green' : 'yellow'}`}>Blender {tools?.blender.available ? `✓ (${tools.blender.path})` : 'not found — BLEND unavailable'}</span>
        </div>
      </div>

      <div className="panel">
        <h2>Options</h2>
        <div className="form-grid">
          <label>Target format</label>
          <select value={target} onChange={(e) => setTarget(e.target.value as never)}>
            <option value="glb">GLB (recommended)</option>
            <option value="gltf">glTF (external files)</option>
            <option value="obj">OBJ (+MTL)</option>
            <option value="fbx">FBX (needs Blender/assimp)</option>
          </select>
          <label>Mesh cleanup</label>
          <div className="row wrap">
            <label className="checkbox-row"><input type="checkbox" checked={opts.weld} onChange={(e) => setOpts({ ...opts, weld: e.target.checked })} />Weld vertices</label>
            <label className="checkbox-row"><input type="checkbox" checked={opts.recomputeNormals} onChange={(e) => setOpts({ ...opts, recomputeNormals: e.target.checked })} />Recompute normals</label>
            <label className="checkbox-row"><input type="checkbox" checked={opts.prune} onChange={(e) => setOpts({ ...opts, prune: e.target.checked })} />Prune unused materials</label>
          </div>
          <label>Textures</label>
          <div className="row wrap">
            <label className="checkbox-row"><input type="checkbox" checked={opts.resize} onChange={(e) => setOpts({ ...opts, resize: e.target.checked })} />Resize max</label>
            <input type="number" style={{ width: 100 }} value={opts.resizeMax} onChange={(e) => setOpts({ ...opts, resizeMax: Number(e.target.value) })} disabled={!opts.resize} />
            <label className="checkbox-row"><input type="checkbox" checked={opts.jpeg} onChange={(e) => setOpts({ ...opts, jpeg: e.target.checked })} />Compress to JPEG</label>
            <input type="number" style={{ width: 70 }} value={opts.jpegQuality} onChange={(e) => setOpts({ ...opts, jpegQuality: Number(e.target.value) })} disabled={!opts.jpeg} />
          </div>
          <label>LOD generation</label>
          <div className="row wrap">
            <label className="checkbox-row"><input type="checkbox" checked={opts.lods} onChange={(e) => setOpts({ ...opts, lods: e.target.checked })} />Generate LODs (ratios)</label>
            <input type="text" style={{ width: 110 }} value={opts.lodRatios} onChange={(e) => setOpts({ ...opts, lodRatios: e.target.value })} disabled={!opts.lods} />
          </div>
          <label>Collision mesh</label>
          <select value={opts.collision} onChange={(e) => setOpts({ ...opts, collision: e.target.value as never })}>
            <option value="none">None</option>
            <option value="bbox">Bounding-box proxy</option>
            <option value="decimated">Decimated copy</option>
          </select>
        </div>
      </div>

      <div className="panel">
        <h2>Assets ({assets.length})</h2>
        <div className="grid" style={{ gap: 6 }}>
          {assets.map((a) => (
            <div key={a.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 4px', borderBottom: '1px solid var(--border)' }}>
              <div>
                <b className="small">{a.name}</b>
                <span className="muted small"> · {a.format} · {a.category} · {a.processingStatus}</span>
              </div>
              <button className="btn small primary" disabled={busy !== null} onClick={() => void convert(a)}>
                {busy === a.id ? 'Converting…' : `Convert → ${target.toUpperCase()}`}
              </button>
            </div>
          ))}
          {assets.length === 0 && <p className="muted">Library is empty.</p>}
        </div>
      </div>

      {result && (
        <Modal title="Conversion result" onClose={() => setResult(null)}>
          {result.ok ? (
            <>
              <p>✅ {result.outputs.length} file(s) written:</p>
              {result.outputs.map((o) => (
                <div key={o.path} className="small" style={{ padding: '2px 0' }}>
                  <span className="badge neutral">{o.kind}</span> {o.path}
                </div>
              ))}
              {result.stats && (
                <div className="panel" style={{ marginTop: 10 }}>
                  <dl className="kv">
                    <dt>Vertices</dt><dd>{result.stats.vertices.toLocaleString()}</dd>
                    <dt>Triangles</dt><dd>{result.stats.faces.toLocaleString()}</dd>
                    <dt>Materials</dt><dd>{result.stats.materials}</dd>
                    <dt>UVs / Normals</dt><dd>{result.stats.hasUvs ? 'yes' : 'no'} / {result.stats.hasNormals ? 'yes' : 'no'}</dd>
                    <dt>Animations</dt><dd>{result.stats.animations}</dd>
                    <dt>BBox</dt><dd>{result.stats.boundingBox.min.join(', ')} → {result.stats.boundingBox.max.join(', ')}</dd>
                  </dl>
                </div>
              )}
            </>
          ) : <p style={{ color: 'var(--bad)' }}>❌ {result.error}</p>}
          {result.warnings.length > 0 && (
            <div className="panel"><h3>Warnings</h3>{result.warnings.map((w, i) => <div key={i} className="small">⚠ {w}</div>)}</div>
          )}
        </Modal>
      )}
    </div>
  );
}
