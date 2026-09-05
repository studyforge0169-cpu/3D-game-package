/** Settings (spec §14/§16): API keys (secure storage), library location, downloads, converters, backups. */

import React, { useEffect, useState } from 'react';
import type { AppConfig } from '../../core/util/config';
import { api } from '../api';
import { useToast } from '../components/Toast';

export default function Settings(props: { theme: string; setTheme: (t: 'dark' | 'light') => void }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [secretBackend, setSecretBackend] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const toast = useToast();

  useEffect(() => {
    void api.getConfig().then(setCfg);
    void api.secretBackend().then(setSecretBackend);
    for (const p of ['sketchfab', 'polypizza', 'blenderkit']) {
      void api.hasApiKey(p).then((has) => setKeys((k) => ({ ...k, [p]: has })));
    }
  }, []);

  const patch = (p: Partial<AppConfig>) => {
    setCfg((c: AppConfig | null) => (c ? ({ ...c, ...p } as AppConfig) : c));
  };

  const save = async () => {
    if (!cfg) return;
    await api.updateConfig(cfg);
    toast({ message: 'Settings saved', kind: 'success' });
  };

  const saveKey = async (provider: string) => {
    const v = drafts[provider] ?? '';
    await api.setApiKey(provider, v.trim());
    setKeys((k) => ({ ...k, [provider]: v.trim().length > 0 }));
    setDrafts((d) => ({ ...d, [provider]: '' }));
    toast({ message: v.trim() ? `${provider} key stored securely` : `${provider} key removed`, kind: 'success' });
  };

  if (!cfg) return <div className="muted">Loading…</div>;

  const KeyRow = ({ id, name, url, hint }: { id: string; name: string; url: string; hint: string }) => (
    <>
      <label>{name} API key {keys[id] ? <span className="badge green">set</span> : <span className="badge yellow">not set</span>}</label>
      <div className="row">
        <input type="password" placeholder={keys[id] ? '•••••••• (stored) — type to replace' : hint} value={drafts[id] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [id]: e.target.value }))} style={{ flex: 1 }} />
        <button className="btn small" onClick={() => void api.openExternal(url)}>get key ↗</button>
        <button className="btn small primary" disabled={!(drafts[id] ?? '').trim() && keys[id]} onClick={() => void saveKey(id)}>{keys[id] ? 'Replace' : 'Save'}</button>
        {keys[id] && <button className="btn small danger" onClick={() => void saveKey(id).then(() => setDrafts((d) => ({ ...d, [id]: '' })))} title="remove">✕</button>}
      </div>
    </>
  );

  return (
    <div>
      <div className="panel">
        <h2>General</h2>
        <div className="form-grid">
          <label>Theme</label>
          <div className="row">
            <button className={`btn small ${props.theme === 'dark' ? 'primary' : ''}`} onClick={() => props.setTheme('dark')}>🌙 Dark</button>
            <button className={`btn small ${props.theme === 'light' ? 'primary' : ''}`} onClick={() => props.setTheme('light')}>☀ Light</button>
          </div>
          <label>Asset library location</label>
          <div className="row">
            <input type="text" style={{ flex: 1 }} value={cfg.libraryDir} onChange={(e) => patch({ libraryDir: e.target.value })} />
            <button className="btn small" onClick={async () => { const p = await api.pickDirectory(); if (p) patch({ libraryDir: p }); }}>Browse…</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>API keys</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Stored {secretBackend === 'safeStorage' ? 'in your OS secure credential store (Windows DPAPI / macOS Keychain / Linux keyring)' : `encrypted locally (${secretBackend}) — run the desktop app for OS keychain storage`}.
          Keys are never written to the database, config files or logs.
        </p>
        <div className="form-grid">
          <KeyRow id="sketchfab" name="Sketchfab" url="https://sketchfab.com/settings/password" hint="Account → Settings → API token" />
          <KeyRow id="polypizza" name="Poly Pizza" url="https://poly.pizza/settings/api" hint="free key from poly.pizza/settings/api" />
          <KeyRow id="blenderkit" name="BlenderKit" url="https://www.blenderkit.com/prefs/" hint="profile page API key" />
        </div>
      </div>

      <div className="panel">
        <h2>Downloads</h2>
        <div className="form-grid">
          <label>Max concurrent downloads</label>
          <input type="number" min={1} max={8} value={cfg.downloads.globalConcurrency} onChange={(e) => patch({ downloads: { ...cfg.downloads, globalConcurrency: Number(e.target.value) } })} />
          <label>Retry limit</label>
          <input type="number" min={0} max={9} value={cfg.downloads.retryLimit} onChange={(e) => patch({ downloads: { ...cfg.downloads, retryLimit: Number(e.target.value) } })} />
          <label>Timeout (ms)</label>
          <input type="number" value={cfg.downloads.timeoutMs} onChange={(e) => patch({ downloads: { ...cfg.downloads, timeoutMs: Number(e.target.value) } })} />
        </div>
        <p className="small muted">Per-source rate limits are enforced automatically (e.g. OpenGameArt ≥ 12 s between requests per its robots.txt). 429 responses trigger cool-downs, never circumvention.</p>
      </div>

      <div className="panel">
        <h2>Converters</h2>
        <div className="form-grid">
          <label>Blender executable (BLEND, quality decimate)</label>
          <input type="text" style={{ flex: 1 }} placeholder="leave empty to auto-detect" value={cfg.converters.blenderPath ?? ''} onChange={(e) => patch({ converters: { ...cfg.converters, blenderPath: e.target.value || null } })} />
          <label>assimp executable (FBX/DAE import)</label>
          <input type="text" style={{ flex: 1 }} placeholder="leave empty to auto-detect" value={cfg.converters.assimpPath ?? ''} onChange={(e) => patch({ converters: { ...cfg.converters, assimpPath: e.target.value || null } })} />
        </div>
      </div>

      <div className="panel">
        <h2>Data</h2>
        <div className="row wrap">
          <button className="btn" onClick={async () => {
            const p = await api.backupDatabase();
            toast({ message: `Database backup created: ${p}`, kind: 'success' });
          }}>Back up database now</button>
        </div>
        <p className="small muted">SQLite (WAL) with rolling backups + config backups. Attribution docs include everything you need to restore on another machine.</p>
      </div>

      <div className="row" style={{ marginTop: 6 }}>
        <span className="spacer" />
        <button className="btn primary" onClick={() => void save()}>Save settings</button>
      </div>
    </div>
  );
}
