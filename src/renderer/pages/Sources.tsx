/** Sources page (spec §2/§13): every connector with its tier and legal status. */

import React, { useEffect, useState } from 'react';
import { api, ProviderInfoDto } from '../api';
import { useToast } from '../components/Toast';

export default function Sources() {
  const [providers, setProviders] = useState<(ProviderInfoDto & { tier: string; capabilities: Record<string, unknown> })[]>([]);
  const toast = useToast();

  useEffect(() => {
    void api.providerInfos().then(setProviders).catch((e) => toast({ message: String(e), kind: 'error' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tierBadge = (tier: string) => {
    const map: Record<string, [string, string]> = {
      full: ['tier-full', 'Full API'],
      hybrid: ['tier-hybrid', 'Hybrid'],
      manual: ['tier-manual', 'Manual / browser'],
    };
    const [cls, label] = map[tier] ?? map.manual;
    return <span className={`badge ${cls}`}>{label}</span>;
  };

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        Each source is an isolated connector built on its official access mechanism.
        Where automation isn't permitted, UGAH only opens official pages — it never scrapes or bypasses protections.
      </p>
      <div className="source-grid">
        {providers.map((p) => (
          <div key={p.id} className="panel source-card">
            <div className="row">
              <b style={{ fontSize: 15 }}>{p.displayName}</b>
              <span className="spacer" />
              {tierBadge(p.tier)}
            </div>
            <div className="note">{p.legalNote}</div>
            <div className="row wrap">
              {p.siteLicense && <span className="badge neutral">{p.siteLicense}</span>}
              {(p.capabilities as { perAssetLicense?: boolean })?.perAssetLicense ? <span className="badge neutral">per-asset license</span> : null}
              {(p.capabilities as { needsApiKey?: boolean })?.needsApiKey && (
                <span className={`badge ${p.configured ? 'green' : 'yellow'}`}>
                  {p.configured ? 'API key set' : 'API key required'}
                </span>
              )}
            </div>
            <div className="row wrap" style={{ marginTop: 'auto' }}>
              <button className="btn small" onClick={() => void api.openExternal(p.homeUrl)}>Open site ↗</button>
              {(p.capabilities as { browserSearch?: boolean })?.browserSearch && (
                <button className="btn small" onClick={() => void api.openExternal(`${p.homeUrl}/search?q=`)}>Site search ↗</button>
              )}
              {p.docsUrl && <button className="btn small ghost" onClick={() => void api.openExternal(p.docsUrl ?? p.homeUrl)}>API docs ↗</button>}
              {(p.capabilities as { needsApiKey?: boolean })?.needsApiKey && p.configured === false && (
                <button className="btn small" onClick={() => void api.openExternal(String((p.capabilities as { apiKeyUrl?: string })?.apiKeyUrl ?? p.homeUrl))}>Get a key ↗</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
