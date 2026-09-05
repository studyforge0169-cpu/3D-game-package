import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api';
import Home from './pages/Home';
import Search from './pages/Search';
import Sources from './pages/Sources';
import Downloads from './pages/Downloads';
import Library from './pages/Library';
import Collections from './pages/Collections';
import Converters from './pages/Converters';
import Projects from './pages/Projects';
import Attributions from './pages/Attributions';
import Settings from './pages/Settings';
import { ToastCtx, Toast, Toasts } from './components/Toast';

export type Page = 'home' | 'search' | 'sources' | 'downloads' | 'library' | 'collections' | 'converters' | 'projects' | 'attributions' | 'settings';

const NAV: { id: Page; label: string; ico: string }[] = [
  { id: 'home', label: 'Home', ico: '⌂' },
  { id: 'search', label: 'Search', ico: '⌕' },
  { id: 'sources', label: 'Sources', ico: '⇄' },
  { id: 'downloads', label: 'Downloads', ico: '↓' },
  { id: 'library', label: 'Library', ico: '▤' },
  { id: 'collections', label: 'Collections', ico: '❑' },
  { id: 'converters', label: 'Converters', ico: '⚙' },
  { id: 'projects', label: 'Projects', ico: '▷' },
  { id: 'attributions', label: 'Attributions', ico: '©' },
  { id: 'settings', label: 'Settings', ico: '✳' },
];

export const NavCtx = createContext<{ page: Page; go: (p: Page) => void }>({ page: 'home', go: () => {} });

export default function App() {
  const [page, setPage] = useState<Page>('home');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mode, setMode] = useState<string>('');

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 6000);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void api.getConfig().then((cfg) => {
      const t = cfg.ui?.theme ?? 'dark';
      setTheme(t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t);
    }).catch(() => {});
    setMode(api.mode);
  }, []);

  const go = useCallback((p: Page) => setPage(p), []);

  return (
    <ToastCtx.Provider value={pushToast}>
      <NavCtx.Provider value={{ page, go }}>
        <div className="app">
          <aside className="sidebar">
            <div className="brand"><div className="brand-logo">🧊</div><span>Universal Game Asset Hub</span></div>
            <nav className="nav">
              {NAV.map((n) => (
                <button key={n.id} className={page === n.id ? 'active' : ''} onClick={() => go(n.id)} title={n.label}>
                  <span className="nav-ico">{n.ico}</span><span>{n.label}</span>
                </button>
              ))}
            </nav>
            <div className="sidebar-footer">
              {mode === 'http' ? <div>Server mode (browser)</div> : <div>Desktop app</div>}
              <div style={{ marginTop: 6 }}>
                <button className="btn small ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                  {theme === 'dark' ? '☀ Light' : '🌙 Dark'}
                </button>
              </div>
            </div>
          </aside>
          <div className="main">
            <div className="content">
              {page === 'home' && <Home />}
              {page === 'search' && <Search />}
              {page === 'sources' && <Sources />}
              {page === 'downloads' && <Downloads />}
              {page === 'library' && <Library />}
              {page === 'collections' && <Collections />}
              {page === 'converters' && <Converters />}
              {page === 'projects' && <Projects />}
              {page === 'attributions' && <Attributions />}
              {page === 'settings' && <Settings theme={theme} setTheme={setTheme} />}
            </div>
          </div>
          <Toasts toasts={toasts} />
        </div>
      </NavCtx.Provider>
    </ToastCtx.Provider>
  );
}
