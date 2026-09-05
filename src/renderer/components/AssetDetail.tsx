/** Asset detail modal — license intelligence screen (spec §4) + download options. */

import React, { useEffect, useState } from 'react';
import type { AssetRef, DownloadOption } from '../../core/types';
import { api } from '../api';
import { Modal } from './Modal';
import { LicenseBadge, licenseFacts } from './LicenseBadge';
import { fmtBytes } from './AssetCard';
import { useToast } from './Toast';

export function AssetDetailModal(props: { asset: AssetRef; onClose: () => void }) {
  const [options, setOptions] = useState<DownloadOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setLoading(true);
    void api.getAssetDetail(props.asset.providerId, props.asset.id)
      .then((d) => { setOptions(d.options); })
      .catch((e) => toast({ message: `Could not load download options: ${String(e.message ?? e)}`, kind: 'error' }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.asset.id, props.asset.providerId]);

  const download = async (option?: DownloadOption) => {
    if (props.asset.license.unknown) {
      toast({ message: 'Download blocked: this asset\'s license could not be established. Open the official page and confirm the license first.', kind: 'error' });
      return;
    }
    setBusy(true);
    try {
      const task = await api.enqueueDownload(props.asset.providerId, props.asset.id, option?.id);
      if (task.state === 'blocked_license') toast({ message: 'Blocked: license unknown.', kind: 'error' });
      else if (task.state === 'skipped_duplicate') toast({ message: 'Possible duplicate — already in your library.', kind: 'info' });
      else if (task.errorCode === 'AUTH_REQUIRED') toast({ message: task.error ?? 'API key required — add it in Settings.', kind: 'error' });
      else toast({ message: `Queued: ${props.asset.name}`, kind: 'success' });
      props.onClose();
    } catch (e) {
      toast({ message: String((e as Error).message ?? e), kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const a = props.asset;
  return (
    <Modal title={a.name} onClose={props.onClose}>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <LicenseBadge license={a.license} />
        {a.free ? <span className="badge neutral">free</span> : <span className="badge red">paid</span>}
        {a.animated && <span className="badge neutral">animated</span>}
        {a.rigged && <span className="badge neutral">rigged</span>}
        {a.pbr && <span className="badge neutral">PBR</span>}
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(200px, 300px) 1fr', alignItems: 'start', gap: 18 }}>
        <div>
          {a.previewUrl && <img src={a.previewUrl} alt="" style={{ width: '100%', borderRadius: 10, border: '1px solid var(--border)' }} />}
        </div>
        <div>
          <dl className="kv">
            <dt>Creator</dt><dd>{a.creator ?? '—'}</dd>
            <dt>Source</dt><dd>{a.providerId}</dd>
            <dt>Original URL</dt>
            <dd>
              <a href={a.assetUrl} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); void api.openExternal(a.assetUrl); }}>{a.assetUrl}</a>
            </dd>
            <dt>Polygons</dt><dd>{a.polyCount?.toLocaleString() ?? '—'}</dd>
            <dt>Texture res</dt><dd>{a.textureResolution ? `${a.textureResolution}px` : '—'}</dd>
            <dt>Formats</dt><dd>{a.formats.join(', ') || '—'}</dd>
            {a.description && <><dt>Description</dt><dd>{a.description.slice(0, 300)}</dd></>}
          </dl>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <h2>📋 License details</h2>
        <dl className="kv">
          {licenseFacts(a.license).map((f) => (
            <React.Fragment key={f.k}><dt>{f.k}</dt><dd>{f.v || '—'}</dd></React.Fragment>
          ))}
        </dl>
        {a.license.unknown && (
          <p className="small" style={{ color: 'var(--bad)' }}>
            ⚠ License could not be established from the source. Automated download is blocked.
            Open the official asset page, confirm the license, then use Library → Import if permitted.
          </p>
        )}
      </div>

      <div className="panel">
        <h2>⬇ Download options</h2>
        {loading && <p className="muted">Loading official download options…</p>}
        {!loading && options.length === 0 && (
          <p className="muted">
            Automated access is unavailable for this source. Open the official asset page to obtain it manually,
            then use <b>Library → Import file</b>.
          </p>
        )}
        <div className="grid" style={{ gap: 8 }}>
          {options.map((o) => (
            <div key={o.id} className="row" style={{ justifyContent: 'space-between', background: 'var(--bg-3)', padding: '8px 12px', borderRadius: 8 }}>
              <div>
                <b>{o.label}</b>
                <span className="muted small"> · {o.format}{o.sizeBytes ? ` · ${fmtBytes(o.sizeBytes)}` : ''}{o.requiresAuth ? ' · your API key used' : ''}</span>
              </div>
              <button className="btn primary small" disabled={busy || a.license.unknown} onClick={() => void download(o)}>Download</button>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void api.openExternal(a.assetUrl)}>Open official page ↗</button>
          <span className="spacer" />
          <button className="btn primary" disabled={busy || a.license.unknown || options.length === 0} onClick={() => void download()}>Download default</button>
        </div>
      </div>
    </Modal>
  );
}
