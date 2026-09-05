/** Downloads queue (spec §9): pause/resume/cancel/retry/progress. */

import React, { useEffect, useState } from 'react';
import type { DownloadProgressEvent, DownloadTask } from '../../core/types';
import { api } from '../api';
import { fmtBytes } from '../components/AssetCard';

export default function Downloads() {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [, force] = useState(0);

  const refresh = () => api.downloads().then(setTasks).catch(() => {});

  useEffect(() => {
    void refresh();
    const off = api.onProgress(() => {
      void refresh();
      force((n) => n + 1);
    });
    const timer = setInterval(() => void refresh(), 1500);
    return () => { off(); clearInterval(timer); };
  }, []);

  const grouped = {
    active: tasks.filter((t) => ['queued', 'running', 'paused'].includes(t.state)),
    done: tasks.filter((t) => ['completed', 'skipped_duplicate'].includes(t.state)),
    failed: tasks.filter((t) => ['failed', 'canceled', 'corrupt', 'blocked_license'].includes(t.state)),
  };

  const Row = ({ t }: { t: DownloadTask }) => {
    const pct = t.totalBytes ? Math.min(100, Math.round((t.bytes / t.totalBytes) * 100)) : 0;
    return (
      <div className="download-row">
        <div>
          <b className="small">{t.assetRef.name}</b>
          <div className="muted small">{t.providerId} · {t.assetRef.license.id}{t.error ? ` · ${t.error}` : ''}</div>
        </div>
        <span className={`state-${t.state} small`}>{t.state.replace('_', ' ')}</span>
        <div>
          <div className="progress"><div style={{ width: `${t.state === 'completed' ? 100 : pct}%` }} /></div>
          <div className="muted small" style={{ marginTop: 3 }}>{fmtBytes(t.bytes)}{t.totalBytes ? ` / ${fmtBytes(t.totalBytes)}` : ''} {t.state === 'running' && `· ${pct}%`}</div>
        </div>
        <div className="row">
          {['paused'].includes(t.state) && <button className="btn small primary" onClick={() => void api.resumeDownloads(t.id)}>Resume</button>}
          {['queued', 'running'].includes(t.state) && <button className="btn small" onClick={() => void api.pauseDownloads(t.id)}>Pause</button>}
          {['failed', 'corrupt', 'canceled'].includes(t.state) && <button className="btn small" onClick={() => void api.retryDownload(t.id)}>Retry</button>}
          {['blocked_license'].includes(t.state) && (
            <button className="btn small" onClick={() => void api.openExternal(t.assetRef.assetUrl)}>Open page ↗</button>
          )}
          {!['running'].includes(t.state) && <button className="btn small danger" onClick={() => void api.removeDownload(t.id)}>✕</button>}
        </div>
      </div>
    );
  };

  const anyActive = grouped.active.some((t) => ['queued', 'running'].includes(t.state));

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" disabled={!anyActive} onClick={() => void api.pauseDownloads()}>⏸ Pause all</button>
        <button className="btn" disabled={grouped.active.length === 0} onClick={() => void api.resumeDownloads()}>▶ Resume all</button>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => void api.clearFinishedDownloads()}>Clear finished</button>
      </div>

      <div className="panel">
        <h2>Active / paused ({grouped.active.length})</h2>
        {grouped.active.length === 0 ? <p className="muted">Queue is empty.</p> : grouped.active.map((t) => <Row key={t.id} t={t} />)}
      </div>
      <div className="panel">
        <h2>Failed / blocked ({grouped.failed.length})</h2>
        {grouped.failed.length === 0 ? <p className="muted">No failures 🎉</p> : grouped.failed.map((t) => <Row key={t.id} t={t} />)}
      </div>
      <div className="panel">
        <h2>Completed ({grouped.done.length})</h2>
        {grouped.done.length === 0 ? <p className="muted">Nothing downloaded yet.</p> : grouped.done.map((t) => <Row key={t.id} t={t} />)}
      </div>
    </div>
  );
}
