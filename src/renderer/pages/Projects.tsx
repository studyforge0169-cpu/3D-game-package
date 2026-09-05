/** Projects & export (spec §8): Game → Engine → Asset type → location. */

import React, { useEffect, useState } from 'react';
import type { EngineId, ExportResult, GameProject, LibraryAsset } from '../../core/types';
import { api } from '../api';
import { Modal } from '../components/Modal';
import { ASSET_CATEGORIES } from '../../core/types';
import { useToast } from '../components/Toast';

const ENGINES: { id: EngineId; label: string; note: string }[] = [
  { id: 'unity', label: 'Unity', note: '<Project>/Assets/<Category> · .meta files untouched' },
  { id: 'unreal', label: 'Unreal Engine', note: '<Project>/Content/<Category> · glTF via Interchange' },
  { id: 'godot', label: 'Godot 4', note: 'next to project.godot · native GLTF import' },
  { id: 'blender', label: 'Blender', note: 'plain folder layout' },
];

export default function Projects() {
  const [projects, setProjects] = useState<GameProject[]>([]);
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [conflicts, setConflictsState] = useState<{ conflicts: { intendedPath: string; existingSize: number; newSize: number }[]; req: Record<string, unknown> } | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const toast = useToast();

  const refresh = () => api.listProjects().then(setProjects).catch(() => {});
  useEffect(() => {
    void refresh();
    void api.librarySearch({}).then(setAssets);
    const off = api.onExportConflicts((ev) => setConflictsState({ ...ev, req: pendingReqRef.current }));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingReqRef = React.useRef<Record<string, unknown>>({});

  const newProject = async () => {
    const name = prompt('Game / project name (e.g. MyGame):');
    if (!name) return;
    const root = await api.pickDirectory();
    if (!root) return;
    const engine = prompt(`Engine — type one of: ${ENGINES.map((e) => e.id).join(', ')}`, 'unity') as EngineId;
    if (!ENGINES.some((e) => e.id === engine)) return;
    await api.saveProject({ name, engine, rootPath: root });
    void refresh();
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn primary" onClick={() => void newProject()}>+ New game project</button>
        <span className="spacer" />
        <button className="btn" disabled={assets.length === 0} onClick={() => setExportOpen(true)}>⬆ Export assets…</button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {projects.map((p) => (
          <div key={p.id} className="panel">
            <div className="row"><b>{p.name}</b><span className="spacer" /><span className="badge neutral">{p.engine}</span></div>
            <div className="small muted" style={{ margin: '6px 0' }}>{p.rootPath}</div>
            <div className="small muted">Created {new Date(p.createdAt).toLocaleDateString()}{p.lastExportAt ? ` · last export ${new Date(p.lastExportAt).toLocaleDateString()}` : ''}</div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn small" onClick={() => void api.openExternal(p.rootPath)}>Open folder</button>
              <button className="btn small" onClick={() => {
                pendingReqRef.current = { engine: p.engine, projectName: p.name, exportRoot: p.rootPath, assetIds: [], source: 'gameReady' };
                setExportOpen(true);
              }}>Export here…</button>
              <span className="spacer" />
              <button className="btn small danger" onClick={async () => { if (confirm('Remove project record? (files untouched)')) { await api.deleteProject(p.id); void refresh(); } }}>✕</button>
            </div>
          </div>
        ))}
        {projects.length === 0 && <div className="empty" style={{ gridColumn: '1/-1' }}><div className="big">▷</div>No projects yet — register your game folder to export into it.</div>}
      </div>

      {exportOpen && (
        <ExportModal
          assets={assets}
          onClose={() => setExportOpen(false)}
          onDone={(r) => { setResult(r); setExportOpen(false); }}
          setConflicts={setConflictsState}
        />
      )}

      {conflicts && (
        <Modal title="⚠ Overwrite confirmation" onClose={() => { void api.resolveExportConflicts(conflicts.req, 'skip'); setConflictsState(null); }} wide={false}>
          <p>The following files already exist in the target project:</p>
          <div className="small" style={{ maxHeight: 200, overflow: 'auto' }}>
            {conflicts.conflicts.map((c) => (
              <div key={c.intendedPath} className="row" style={{ justifyContent: 'space-between' }}>
                <span>{c.intendedPath}</span>
                <span className="muted">{c.existingSize} → {c.newSize} bytes</span>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <span className="spacer" />
            <button className="btn" onClick={() => { void api.resolveExportConflicts(conflicts.req, 'skip'); setConflictsState(null); }}>Skip all</button>
            <button className="btn" onClick={() => { void api.resolveExportConflicts(conflicts.req, 'rename'); setConflictsState(null); }}>Keep both (rename)</button>
            <button className="btn danger" onClick={() => { void api.resolveExportConflicts(conflicts.req, 'overwrite'); setConflictsState(null); }}>Overwrite all</button>
          </div>
        </Modal>
      )}

      {result && (
        <Modal title="Export result" onClose={() => setResult(null)}>
          {result.ok ? (
            <>
              <p>✅ Exported {result.exported.length} asset(s), skipped {result.skipped.length}.</p>
              <div className="small" style={{ maxHeight: 260, overflow: 'auto' }}>
                {result.exported.flatMap((e) => e.files).map((f) => <div key={f}>📄 {f}</div>)}
              </div>
              {result.attributionFiles.length > 0 && (
                <p className="small" style={{ color: 'var(--good)' }}>Attribution written: {result.attributionFiles.join(', ')}</p>
              )}
            </>
          ) : <p style={{ color: 'var(--bad)' }}>❌ {result.error}</p>}
        </Modal>
      )}
    </div>
  );
}

function ExportModal(props: {
  assets: LibraryAsset[];
  onClose: () => void;
  onDone: (r: ExportResult) => void;
  setConflicts: (c: { conflicts: { intendedPath: string; existingSize: number; newSize: number }[]; req: Record<string, unknown> } | null) => void;
}) {
  const [engine, setEngine] = useState<EngineId>('unity');
  const [source, setSource] = useState<'original' | 'processed' | 'gameReady'>('gameReady');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [root, setRoot] = useState('');
  const [projectName, setProjectName] = useState('MyGame');
  const [busy, setBusy] = useState(false);
  const [filterCat, setFilterCat] = useState<string>('');

  const shown = props.assets.filter((a) => !filterCat || a.category === filterCat);

  const run = async () => {
    setBusy(true);
    const req = { engine, projectName, exportRoot: root, assetIds: [...selected], source, collisionPolicy: 'ask' };
    try {
      const r = await api.exportAssets(req);
      props.onDone(r);
    } catch (e) {
      alert(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Export to game project" onClose={props.onClose}>
      <div className="form-grid">
        <label>Engine</label>
        <div className="row wrap">
          {ENGINES.map((e) => (
            <button key={e.id} className={`btn small ${engine === e.id ? 'primary' : ''}`} onClick={() => setEngine(e.id)} title={e.note}>{e.label}</button>
          ))}
        </div>
        <label>Export root</label>
        <div className="row">
          <input type="text" style={{ flex: 1 }} value={root} onChange={(e) => setRoot(e.target.value)} placeholder="C:\Games" />
          <button className="btn small" onClick={async () => { const p = await api.pickDirectory(); if (p) setRoot(p); }}>Browse…</button>
        </div>
        <label>Project folder name</label>
        <input type="text" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
        <label>What to copy</label>
        <select value={source} onChange={(e) => setSource(e.target.value as never)}>
          <option value="gameReady">GameReady (converted/LODs — recommended)</option>
          <option value="processed">Processed</option>
          <option value="original">Original downloads</option>
        </select>
        <label>Filter category</label>
        <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
          <option value="">All categories</option>
          {ASSET_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="panel" style={{ marginTop: 12, maxHeight: 280, overflow: 'auto' }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <b className="small">Assets ({selected.size} selected)</b>
          <span className="spacer" />
          <button className="btn small ghost" onClick={() => setSelected(new Set(shown.map((a) => a.id)))}>Select all shown</button>
          <button className="btn small ghost" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
        {shown.map((a) => (
          <label key={a.id} className="checkbox-row" style={{ padding: '3px 0' }}>
            <input
              type="checkbox"
              checked={selected.has(a.id)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(a.id); else next.delete(a.id);
                setSelected(next);
              }}
            />
            {a.name} <span className="muted small">· {a.category} · {a.licenseId}</span>
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <span className="muted small">Never overwrites without asking. ATTRIBUTIONS.txt/md written automatically.</span>
        <span className="spacer" />
        <button className="btn" onClick={props.onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || selected.size === 0 || !root} onClick={() => void run()}>Export {selected.size} asset(s)</button>
      </div>
    </Modal>
  );
}
