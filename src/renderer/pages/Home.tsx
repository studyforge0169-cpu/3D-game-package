import React, { useEffect, useState } from 'react';
import type { LibraryAsset } from '../../core/types';
import { api } from '../api';
import { LibraryAssetCard } from '../components/AssetCard';
import { NavCtx } from '../App';

export default function Home() {
  const [recent, setRecent] = useState<LibraryAsset[]>([]);
  const [stats, setStats] = useState({ assets: 0, categories: 0, providers: 0 });
  const nav = React.useContext(NavCtx);

  useEffect(() => {
    void api.recentlyDownloaded().then(setRecent).catch(() => {});
    void api.librarySearch({}).then((all) => {
      setStats({
        assets: all.length,
        categories: new Set(all.map((a) => a.category)).size,
        providers: new Set(all.map((a) => a.providerId)).size,
      });
    }).catch(() => {});
  }, []);

  return (
    <div>
      <div className="panel" style={{ background: 'linear-gradient(135deg, rgba(79,140,255,0.12), rgba(124,92,255,0.08))' }}>
        <h2 style={{ fontSize: 20 }}>🧊 Universal Game Asset Hub</h2>
        <p className="muted" style={{ margin: 0 }}>
          One legal, unified asset manager: search official APIs, verify per-asset licenses, download,
          organize, convert to game-ready formats and export to your engine — with attributions handled.
        </p>
        <div className="row wrap" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={() => nav.go('search')}>⌕ Search sources</button>
          <button className="btn" onClick={() => nav.go('library')}>▤ Open library</button>
          <button className="btn" onClick={() => nav.go('sources')}>⇄ Manage sources</button>
          <button className="btn" onClick={() => nav.go('settings')}>✳ Add API keys</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', marginTop: 14 }}>
        <div className="panel"><h3>Assets in library</h3><div style={{ fontSize: 26, fontWeight: 700 }}>{stats.assets}</div></div>
        <div className="panel"><h3>Categories in use</h3><div style={{ fontSize: 26, fontWeight: 700 }}>{stats.categories}</div></div>
        <div className="panel"><h3>Sources contributing</h3><div style={{ fontSize: 26, fontWeight: 700 }}>{stats.providers}</div></div>
        <div className="panel"><h3>Offline capable</h3><div style={{ fontSize: 26, fontWeight: 700 }}>✓</div><div className="small muted">library works without internet</div></div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <h2>Recently downloaded</h2>
        {recent.length === 0
          ? <div className="empty"><div className="big">↓</div>Nothing yet — search for <i>castle</i>, <i>rifle</i> or <i>tree</i> to get started.</div>
          : (
            <div className="grid cards">
              {recent.slice(0, 8).map((a) => (
                <LibraryAssetCard key={a.id} asset={a} onClick={() => nav.go('library')} />
              ))}
            </div>
          )}
      </div>
    </div>
  );
}
