/** Local asset library (spec §5/§15): offline search, taxonomy, viewer, import. */

import React, { useEffect, useMemo, useState } from 'react';
import { ASSET_CATEGORIES, type AssetCategory, type LibraryAsset } from '../../core/types';
import { api } from '../api';
import { LibraryAssetCard, fmtBytes } from '../components/AssetCard';
import { Modal } from '../components/Modal';
import { LicenseBadge } from '../components/LicenseBadge';
import Viewer3D from '../Viewer3D';
import { useToast } from '../components/Toast';

export default function Library() {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [text, setText] = useState('');
  const [cat, setCat] = useState<AssetCategory | 'All' | 'Favorites'>('All');
  const [favOnly, setFavOnly] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [detail, setDetail] = useState<LibraryAsset | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [preview, setPreview] = useState<Record<string, string>>({});
  const [importOpen, setImportOpen] = useState(false);
  const toast = useToast();

  const refresh = () => {
    void api.librarySearch({
      text: text || undefined,
      categories: cat !== 'All' && cat !== 'Favorites' ? [cat] : undefined,
      favorites: cat === 'Favorites' || favOnly || undefined,
    }).then(setAssets).catch(() => {});
  };

  useEffect(refresh, [text, cat, favOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // lazy-load preview thumbnails
    void (async () => {
      for (const a of assets.slice(0, 60)) {
        if (preview[a.id] !== undefined) continue;
        const url = await api.readPreview(a.id).catch(() => null);
        setPreview((p) => ({ ...p, [a.id]: url ?? '' }));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets]);

  const openDetail = async (a: LibraryAsset) => {
    setDetail(a);
    setBuffer(null);
    if (/\.(glb|gltf|obj|stl|ply|fbx|dae)$/i.test(a.localPath)) {
      const buf = await api.readAssetFile(a.id).catch(() => null);
      setBuffer(buf);
    }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of assets) c[a.category] = (c[a.category] ?? 0) + 1;
    return c;
  }, [assets]);

  return (
    <div className="grid" style={{ gridTemplateColumns: '210px 1fr', alignItems: 'start' }}>
      <div className="panel">
        <h3>Library</h3>
        <div className="tree">
          <button className={cat === 'All' ? 'active' : ''} onClick={() => setCat('All')}>All assets ({assets.length})</button>
          <button className={cat === 'Favorites' ? 'active' : ''} onClick={() => setCat('Favorites')}>★ Favorites</button>
          {ASSET_CATEGORIES.map((c) => (
            <button key={c} className={cat === c ? 'active' : ''} onClick={() => setCat(c)}>
              {c}{counts[c] ? ` (${counts[c]})` : ''}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary small" style={{ width: '100%' }} onClick={() => setImportOpen(true)}>+ Import file</button>
        </div>
      </div>

      <div>
        <div className="row" style={{ marginBottom: 12 }}>
          <input type="text" placeholder="Search library…" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }} />
          <label className="checkbox-row small"><input type="checkbox" checked={favOnly} onChange={(e) => setFavOnly(e.target.checked)} />★</label>
          <button className="btn small" onClick={() => setView(view === 'grid' ? 'list' : 'grid')}>{view === 'grid' ? '☰ List' : '▦ Grid'}</button>
          <button className="btn small" onClick={() => void api.scanDuplicates().then(() => toast({ message: 'Duplicate scan complete', kind: 'success' }))}>Find duplicates</button>
        </div>

        {assets.length === 0 && <div className="empty"><div className="big">▤</div>No assets here yet. Download some from Search, or import files you downloaded manually.</div>}

        {view === 'grid' ? (
          <div className="grid cards">
            {assets.map((a) => (
              <LibraryAssetCard
                key={a.id}
                asset={a}
                previewUrl={preview[a.id] || undefined}
                onClick={() => void openDetail(a)}
                onFav={async () => { await api.updateAsset(a.id, { favorite: !a.favorite }); refresh(); }}
              />
            ))}
          </div>
        ) : (
          <div className="grid" style={{ gap: 8 }}>
            {assets.map((a) => (
              <div key={a.id} className="asset-row" onClick={() => void openDetail(a)}>
                <div className="thumb">{preview[a.id] ? <img src={preview[a.id]} alt="" /> : '🧊'}</div>
                <div><b>{a.name}</b><div className="muted small">{a.creator ?? '—'} · {a.providerId} · {new Date(a.downloadedAt).toLocaleDateString()}</div></div>
                <span className="badge neutral">{a.category}</span>
                <span className={`badge ${a.licenseId === 'unknown' ? 'black' : a.licenseId === 'CC0-1.0' ? 'green' : 'blue'}`}>{a.licenseId}</span>
                <span className="small muted">{fmtBytes(a.fileSize)}</span>
                <span className="small muted">{a.processingStatus}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)}>
          <div className="row wrap" style={{ marginBottom: 12 }}>
            <span className="badge neutral">{detail.category}</span>
            <span className="badge neutral">{detail.format} · {fmtBytes(detail.fileSize)}</span>
            <span className="badge neutral">{detail.providerId}</span>
            {detail.processingStatus !== 'original' && <span className="badge neutral">{detail.processingStatus}</span>}
            <LicenseBadge license={{
              id: detail.licenseId, name: detail.licenseId, commercialUse: 'allowed', attributionRequired: false,
              shareAlike: false, redistribution: 'allowed', modification: 'allowed', unknown: detail.licenseId === 'unknown',
              sourceConfirmed: true, licenseCheckedAt: detail.licenseCheckedAt,
            }} />
          </div>

          {buffer !== null || /\.(glb|gltf|obj|stl|ply|fbx|dae)$/i.test(detail.localPath) ? (
            <Viewer3D buffer={buffer} fileName={detail.localPath.split(/[\\/]/).pop() ?? 'model.glb'} height={380} />
          ) : (
            <div className="empty"><div className="big">🧊</div>No in-app 3D preview for {detail.format.toUpperCase()} — convert to GLB in Converters.</div>
          )}

          <div className="panel" style={{ marginTop: 14 }}>
            <h2>Metadata</h2>
            <dl className="kv">
              <dt>Creator</dt><dd>{detail.creator ?? '—'}</dd>
              <dt>Source</dt><dd>{detail.providerId}</dd>
              <dt>Original URL</dt><dd><a href={detail.sourceUrl} onClick={(e) => { e.preventDefault(); void api.openExternal(detail.sourceUrl); }}>{detail.sourceUrl}</a></dd>
              <dt>License</dt><dd>{detail.licenseId}{detail.licenseUrl ? ` — ${detail.licenseUrl}` : ''}</dd>
              <dt>License checked</dt><dd>{new Date(detail.licenseCheckedAt).toLocaleString()}</dd>
              <dt>Downloaded</dt><dd>{new Date(detail.downloadedAt).toLocaleString()}</dd>
              <dt>SHA-256</dt><dd className="small">{detail.sha256 ?? '—'}</dd>
              <dt>Polygons / TexRes</dt><dd>{detail.polyCount?.toLocaleString() ?? '—'} / {detail.textureResolution ?? '—'}</dd>
              <dt>Version</dt><dd>v{detail.currentVersion}</dd>
              <dt>Tags</dt><dd>{JSON.parse(detail.tagsJson || '[]').join(', ') || '—'}</dd>
              <dt>Path</dt><dd className="small">{detail.originalDir}</dd>
            </dl>
          </div>

          <div className="row wrap" style={{ marginTop: 14 }}>
            <select value={detail.category} onChange={async (e) => { await api.moveAssetCategory(detail.id, e.target.value as AssetCategory); refresh(); toast({ message: 'Moved', kind: 'success' }); }}>
              {ASSET_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button className="btn" onClick={async () => {
              const v = await api.verifyAsset(detail.id);
              toast({ message: v.ok ? '✓ Integrity verified (sha256 matches)' : `⚠ ${v.reason}`, kind: v.ok ? 'success' : 'error' });
            }}>Verify integrity</button>
            <button className="btn" onClick={() => void api.openExternal(detail.sourceUrl)}>Open source ↗</button>
            <span className="spacer" />
            <button className="btn danger" onClick={async () => {
              if (!confirm(`Delete "${detail.name}" from your library? Original files on disk will be removed.`)) return;
              await api.deleteAsset(detail.id);
              setDetail(null);
              refresh();
            }}>Delete</button>
          </div>
        </Modal>
      )}

      {importOpen && <ImportModal onClose={() => { setImportOpen(false); refresh(); }} />}
    </div>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState('');
  const [provider, setProvider] = useState('kenney');
  const [name, setName] = useState('');
  const [creator, setCreator] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [license, setLicense] = useState('CC0');
  const [licenseUrl, setLicenseUrl] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const importFile = async () => {
    if (!file) { toast({ message: 'Pick a file first', kind: 'error' }); return; }
    if (!license) { toast({ message: 'A license must be established before importing (unknown licenses are blocked from export).', kind: 'error' }); return; }
    setBusy(true);
    try {
      const r = await api.importLocalFile({
        filePath: file, providerId: provider, name: name || undefined, creator: creator || undefined,
        sourceUrl: sourceUrl || undefined, licenseRaw: license, licenseUrl: licenseUrl || undefined,
        tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      });
      toast({
        message: r.duplicates.duplicate
          ? `Imported — but note: possible duplicate of ${r.duplicates.matches.length} existing asset(s)`
          : `Imported "${r.asset.name}" into ${r.asset.category}`,
        kind: 'success',
      });
      onClose();
    } catch (e) {
      toast({ message: String((e as Error).message ?? e), kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Import a manually-downloaded asset" onClose={onClose} wide={false}>
      <p className="muted small">
        Use this for sources without automated downloads (Kenney, Quaternius, KayKit, CGBookcase, itch.io,
        CGTrader, TurboSquid, Free3D, Mixamo, Fab…). You downloaded the file in your browser — register it here
        with its license so the library stays compliant.
      </p>
      <div className="form-grid">
        <label>File</label>
        <div className="row"><input type="text" value={file} onChange={(e) => setFile(e.target.value)} placeholder="C:\Downloads\kenney_castle-kit.zip" style={{ flex: 1 }} />
          <button className="btn small" onClick={async () => { const p = await api.pickFile(); if (p) setFile(p); }}>Browse…</button></div>
        <label>Source</label>
        <select value={provider} onChange={(e) => { setProvider(e.target.value); if (['kenney', 'quaternius', 'kaykit', 'cgbookcase'].includes(e.target.value)) setLicense('CC0'); }}>
          {['kenney', 'quaternius', 'kaykit', 'cgbookcase', 'itch', 'cgtrader', 'turbosquid', 'free3d', 'mixamo', 'fab', 'opengameart', 'polyhaven', 'ambientcg', 'sketchfab', 'polypizza', 'blenderkit'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <label>Asset name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="from filename if empty" />
        <label>Creator</label><input type="text" value={creator} onChange={(e) => setCreator(e.target.value)} />
        <label>Original URL</label><input type="text" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://…" />
        <label>License</label>
        <div className="row">
          <select value={license} onChange={(e) => setLicense(e.target.value)}>
            {['CC0', 'CC-BY-4.0', 'CC-BY-3.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'GPL-3.0', 'MIT', 'royalty_free', 'mixamo', ''].map((l) => (
              <option key={l || 'unknown'} value={l}>{l || '⚠ Unknown'}</option>
            ))}
          </select>
          <input type="text" value={licenseUrl} onChange={(e) => setLicenseUrl(e.target.value)} placeholder="license URL (optional)" style={{ flex: 1 }} />
        </div>
        <label>Tags</label><input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="castle, medieval" />
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !file} onClick={() => void importFile()}>Import</button>
      </div>
    </Modal>
  );
}
