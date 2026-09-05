/** Attributions (spec §12): preview & export attribution documents. */

import React, { useEffect, useState } from 'react';
import type { LibraryAsset } from '../../core/types';
import { api } from '../api';
import { useToast } from '../components/Toast';

export default function Attributions() {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [doc, setDoc] = useState<{ txt: string; md: string } | null>(null);
  const [tab, setTab] = useState<'txt' | 'md'>('txt');
  const toast = useToast();

  useEffect(() => { void api.librarySearch({}).then(setAssets); }, []);

  const generate = async () => {
    if (selected.size === 0) return;
    const d = await api.attributionFor([...selected]);
    setDoc({ txt: d.txt, md: d.md });
  };

  const save = async () => {
    if (selected.size === 0) return;
    const dir = await api.pickDirectory();
    if (!dir) return;
    const files = await api.writeAttributionFiles([...selected], dir);
    toast({ message: `Written: ${files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`, kind: 'success' });
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: '340px 1fr', alignItems: 'start' }}>
      <div className="panel">
        <div className="row">
          <h2>Assets ({selected.size}/{assets.length})</h2>
          <span className="spacer" />
          <button className="btn small ghost" onClick={() => setSelected(new Set(assets.filter((a) => a.licenseId !== 'CC0-1.0').map((a) => a.id)))}>Select non-CC0</button>
          <button className="btn small ghost" onClick={() => setSelected(new Set(assets.map((a) => a.id)))}>All</button>
        </div>
        <div style={{ maxHeight: '55vh', overflow: 'auto' }}>
          {assets.map((a) => (
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
              <span className="small">{a.name}</span>
              <span className={`badge ${a.licenseId === 'unknown' ? 'black' : a.licenseId === 'CC0-1.0' ? 'green' : 'blue'}`}>{a.licenseId}</span>
            </label>
          ))}
          {assets.length === 0 && <p className="muted">Library is empty.</p>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={selected.size === 0} onClick={() => void generate()}>Preview</button>
          <button className="btn" disabled={selected.size === 0} onClick={() => void save()}>Save ATTRIBUTIONS files…</button>
        </div>
      </div>

      <div className="panel">
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Document</h2>
          <span className="spacer" />
          {doc && (
            <div className="row">
              <button className={`btn small ${tab === 'txt' ? 'primary' : ''}`} onClick={() => setTab('txt')}>ATTRIBUTIONS.txt</button>
              <button className={`btn small ${tab === 'md' ? 'primary' : ''}`} onClick={() => setTab('md')}>ATTRIBUTIONS.md</button>
            </div>
          )}
        </div>
        {doc ? <pre className="attr-pre">{tab === 'txt' ? doc.txt : doc.md}</pre> : (
          <div className="empty"><div className="big">©</div>Select assets and preview the generated attribution document.<br />CC0 assets get courtesy credit; unknown licenses get a loud warning block.</div>
        )}
      </div>
    </div>
  );
}
