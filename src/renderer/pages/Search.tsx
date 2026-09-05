/** Unified search across all configured providers (spec §3). */

import React, { useEffect, useMemo, useState } from 'react';
import type { AssetRef, SearchPage, SearchQuery, SortKey } from '../../core/types';
import { api, ProviderInfoDto } from '../api';
import { SearchAssetCard } from '../components/AssetCard';
import { AssetDetailModal } from '../components/AssetDetail';
import { useToast } from '../components/Toast';

const SORTS: { id: SortKey; label: string }[] = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'quality', label: 'Quality' },
  { id: 'popularity', label: 'Popularity' },
  { id: 'polygons', label: 'Poly count' },
  { id: 'textureResolution', label: 'Texture res' },
  { id: 'fileSize', label: 'File size' },
  { id: 'newest', label: 'Newest' },
];

const TOPICS = ['character', 'environment', 'prop', 'vehicle', 'weapon', 'building', 'vegetation', 'creature', 'material', 'hdri', 'vfx', 'audio'];

export default function Search() {
  const [text, setText] = useState('');
  const [sort, setSort] = useState<SortKey>('relevance');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [pages, setPages] = useState<SearchPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderInfoDto[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(true);
  const [detail, setDetail] = useState<AssetRef | null>(null);
  const [f, setF] = useState({
    freeOnly: false, cc0Only: false, commercialOnly: false, noAttributionOnly: false,
    kind: '', topic: '', maxPoly: '', minTexRes: '', animatedOnly: false, riggedOnly: false, pbrOnly: false,
  });
  const toast = useToast();

  useEffect(() => {
    void api.providerInfos().then((infos) => {
      setProviders(infos);
      setEnabled(new Set(infos.filter((p) => p.capabilities.search).map((p) => p.id)));
    }).catch(() => {});
  }, []);

  const runSearch = async () => {
    setBusy(true);
    setPages([]);
    const query: SearchQuery = {
      text,
      providers: [...enabled],
      sort,
      perPage: 24,
      filters: {
        freeOnly: f.freeOnly || undefined,
        cc0Only: f.cc0Only || undefined,
        commercialOnly: f.commercialOnly || undefined,
        noAttributionOnly: f.noAttributionOnly || undefined,
        kind: (f.kind || undefined) as never,
        topics: f.topic ? [f.topic] : undefined,
        maxPolyCount: f.maxPoly ? Number(f.maxPoly) : undefined,
        minTextureResolution: f.minTexRes ? Number(f.minTexRes) : undefined,
        animatedOnly: f.animatedOnly || undefined,
        riggedOnly: f.riggedOnly || undefined,
        pbrOnly: f.pbrOnly || undefined,
      },
    };
    try {
      const result = await api.search(query);
      setPages(result);
    } catch (e) {
      toast({ message: `Search failed: ${String((e as Error).message ?? e)}`, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const allResults = useMemo(() => pages.flatMap((p) => p.results), [pages]);
  const manualPages = pages.filter((p) => p.manualOnly);
  const erroredPages = pages.filter((p) => p.error);

  return (
    <div>
      <div className="topbar" style={{ margin: '-20px -20px 16px', padding: '12px 20px' }}>
        <div className="search-bar">
          <input
            type="text"
            placeholder='Search assets — "medieval castle", "AK-style rifle", "zombie", "space station"…'
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
            autoFocus
          />
          <button className="btn primary" onClick={() => void runSearch()} disabled={busy}>Search</button>
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          {SORTS.map((s) => <option key={s.id} value={s.id}>Sort: {s.label}</option>)}
        </select>
        <button className="btn small" onClick={() => setView(view === 'grid' ? 'list' : 'grid')}>{view === 'grid' ? '☰ List' : '▦ Grid'}</button>
        <button className="btn small" onClick={() => setShowFilters(!showFilters)}>⚙ Filters</button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: showFilters ? '240px 1fr' : '1fr', alignItems: 'start' }}>
        {showFilters && (
          <div className="panel filters">
            <h3>Sources</h3>
            <div className="filter-group">
              {providers.filter((p) => p.capabilities.search).map((p) => (
                <label key={p.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={enabled.has(p.id)}
                    onChange={(e) => {
                      const next = new Set(enabled);
                      if (e.target.checked) next.add(p.id); else next.delete(p.id);
                      setEnabled(next);
                    }}
                  />
                  {p.displayName}
                </label>
              ))}
            </div>
            <h3 style={{ marginTop: 8 }}>License</h3>
            <div className="filter-group">
              <label className="checkbox-row"><input type="checkbox" checked={f.freeOnly} onChange={(e) => setF({ ...f, freeOnly: e.target.checked })} />Free only</label>
              <label className="checkbox-row"><input type="checkbox" checked={f.cc0Only} onChange={(e) => setF({ ...f, cc0Only: e.target.checked })} />CC0 only</label>
              <label className="checkbox-row"><input type="checkbox" checked={f.commercialOnly} onChange={(e) => setF({ ...f, commercialOnly: e.target.checked })} />Commercial use allowed</label>
              <label className="checkbox-row"><input type="checkbox" checked={f.noAttributionOnly} onChange={(e) => setF({ ...f, noAttributionOnly: e.target.checked })} />No attribution required</label>
            </div>
            <h3 style={{ marginTop: 8 }}>Type</h3>
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="">Any type</option>
              <option value="model">Model</option>
              <option value="texture">Texture</option>
              <option value="material">Material</option>
              <option value="hdri">HDRI</option>
              <option value="audio">Audio</option>
              <option value="animation">Animation</option>
              <option value="vfx">VFX</option>
            </select>
            <select value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })}>
              <option value="">Any topic</option>
              {TOPICS.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
            </select>
            <h3 style={{ marginTop: 8 }}>Technical</h3>
            <input type="number" placeholder="Max polygon count" value={f.maxPoly} onChange={(e) => setF({ ...f, maxPoly: e.target.value })} />
            <input type="number" placeholder="Min texture resolution (px)" value={f.minTexRes} onChange={(e) => setF({ ...f, minTexRes: e.target.value })} />
            <label className="checkbox-row"><input type="checkbox" checked={f.pbrOnly} onChange={(e) => setF({ ...f, pbrOnly: e.target.checked })} />PBR available</label>
            <label className="checkbox-row"><input type="checkbox" checked={f.riggedOnly} onChange={(e) => setF({ ...f, riggedOnly: e.target.checked })} />Rigged</label>
            <label className="checkbox-row"><input type="checkbox" checked={f.animatedOnly} onChange={(e) => setF({ ...f, animatedOnly: e.target.checked })} />Animated</label>
          </div>
        )}

        <div>
          {busy && <div className="muted" style={{ padding: 20 }}>Searching sources…</div>}
          {!busy && pages.length === 0 && (
            <div className="empty"><div className="big">⌕</div>Search {providers.filter((p) => p.capabilities.search).length} sources with official APIs.<br />Manual sources open in your browser from the Sources page.</div>
          )}
          {allResults.length > 0 && (
            <>
              <p className="muted small" style={{ marginTop: 0 }}>{allResults.length} API results · {manualPages.length} manual sources open in browser</p>
              {view === 'grid' ? (
                <div className="grid cards">
                  {allResults.map((a) => <SearchAssetCard key={`${a.providerId}:${a.id}`} asset={a} onClick={() => setDetail(a)} />)}
                </div>
              ) : (
                <div className="grid" style={{ gap: 8 }}>
                  {allResults.map((a) => (
                    <div key={`${a.providerId}:${a.id}`} className="asset-row" onClick={() => setDetail(a)}>
                      <div className="thumb">🧊</div>
                      <div><b>{a.name}</b><div className="muted small">{a.creator ?? '—'} · {a.providerId}</div></div>
                      <span className={`badge ${a.license.unknown ? 'black' : a.license.commercialUse === 'forbidden' ? 'red' : a.license.attributionRequired ? 'blue' : 'green'}`}>{a.license.id}</span>
                      <span className="small muted">{a.polyCount ? `△ ${a.polyCount.toLocaleString()}` : ''}</span>
                      <span className="small muted">{a.formats.slice(0, 3).join(' · ')}</span>
                      <span className="small muted">{a.free ? 'free' : 'paid'}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {manualPages.length > 0 && (
            <div className="panel" style={{ marginTop: 16 }}>
              <h3>Manual sources</h3>
              <p className="small muted">These sources don't offer automated search. Open their official search in your browser, download manually, then use Library → Import.</p>
              <div className="row wrap">
                {manualPages.map((p) => (
                  <button key={p.providerId} className="btn small" onClick={() => void api.openExternal(p.searchUrl ?? 'https://example.com')}>
                    {p.providerId} ↗
                  </button>
                ))}
              </div>
            </div>
          )}

          {erroredPages.length > 0 && (
            <div className="panel" style={{ marginTop: 16 }}>
              <h3>Source messages</h3>
              {erroredPages.map((p) => (
                <div key={p.providerId} className="small" style={{ marginBottom: 6 }}>
                  <b>{p.providerId}:</b> <span className="muted">{p.error}</span>
                  {p.searchUrl && <button className="btn small ghost" onClick={() => void api.openExternal(p.searchUrl ?? '')}>open site ↗</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {detail && <AssetDetailModal asset={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
