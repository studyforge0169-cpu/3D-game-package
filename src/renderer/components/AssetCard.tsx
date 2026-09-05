import React from 'react';
import type { AssetRef, LibraryAsset } from '../../core/types';
import { LicenseBadge } from './LicenseBadge';

export function fmtBytes(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function AssetCardView(props: {
  name: string; creator?: string; source: string; license: AssetRef['license'];
  polyCount?: number; textureResolution?: number; formats: string[];
  previewUrl?: string; commercialUse: string; onClick?: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="asset-card" onClick={props.onClick}>
      <div className="thumb">
        {props.previewUrl ? <img src={props.previewUrl} alt="" loading="lazy" /> : '🧊'}
      </div>
      <div className="body">
        <div className="name">{props.name}</div>
        <div className="meta">
          <span>{props.creator ?? 'Unknown creator'}</span>
          <span>·</span>
          <span>{props.source}</span>
        </div>
        <LicenseBadge license={props.license} />
        <div className="meta">
          {props.polyCount !== undefined && <span title="Polygon count">△ {props.polyCount.toLocaleString()}</span>}
          {props.textureResolution !== undefined && <span title="Texture resolution">▣ {props.textureResolution}px</span>}
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="formats">{props.formats.slice(0, 4).join(' · ')}</span>
          {props.extra}
        </div>
      </div>
    </div>
  );
}

export function SearchAssetCard({ asset, onClick }: { asset: AssetRef; onClick?: () => void }) {
  return (
    <AssetCardView
      name={asset.name}
      creator={asset.creator}
      source={asset.providerId}
      license={asset.license}
      polyCount={asset.polyCount}
      textureResolution={asset.textureResolution}
      formats={asset.formats}
      previewUrl={asset.previewUrl}
      commercialUse={asset.license.commercialUse}
      onClick={onClick}
      extra={!asset.free ? <span className="badge red">paid</span> : undefined}
    />
  );
}

export function LibraryAssetCard({ asset, previewUrl, onClick, onFav }: {
  asset: LibraryAsset; previewUrl?: string | null; onClick?: () => void; onFav?: () => void;
}) {
  return (
    <AssetCardView
      name={asset.name}
      creator={asset.creator}
      source={asset.providerId}
      license={{
        id: asset.licenseId, name: asset.licenseId, commercialUse: 'allowed', attributionRequired: false,
        shareAlike: false, redistribution: 'allowed', modification: 'allowed', unknown: asset.licenseId === 'unknown',
        sourceConfirmed: true, licenseCheckedAt: asset.licenseCheckedAt,
      }}
      polyCount={asset.polyCount}
      textureResolution={asset.textureResolution}
      formats={[asset.format]}
      previewUrl={previewUrl ?? undefined}
      commercialUse="allowed"
      onClick={onClick}
      extra={
        <button
          className="btn small ghost"
          title={asset.favorite ? 'Remove favorite' : 'Favorite'}
          onClick={(e) => { e.stopPropagation(); onFav?.(); }}
        >
          {asset.favorite ? '★' : '☆'}
        </button>
      }
    />
  );
}
