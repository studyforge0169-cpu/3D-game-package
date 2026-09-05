/** Collections (spec §5): custom groups + per-collection attributions. */

import React, { useEffect, useState } from 'react';
import type { Collection, LibraryAsset } from '../../core/types';
import { api } from '../api';
import { LibraryAssetCard } from '../components/AssetCard';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';

export default function Collections() {
  const [cols, setCols] = useState<Collection[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [all, setAll] = useState<LibraryAsset[]>([]);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [attrDoc, setAttrDoc] = useState<{ txt: string; md: string } | null>(null);
  const toast = useToast();

  const refresh = () => api.listCollections().then(setCols).catch(() => {});
  useEffect(() => { void refresh(); void api.librarySearch({}).then(setAll); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selected) void api.collectionAssets(selected).then(setAssets);
    else setAssets([]);
  }, [selected]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <input type="text" placeholder="New collection name…" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={!name.trim()} onClick={async () => {
          await api.createCollection(name.trim());
          setName('');
          void refresh();
          toast({ message: 'Collection created', kind: 'success' });
        }}>Create</button>
      </div>

      {cols.length === 0 ? (
        <div className="empty"><div className="big">❑</div>Create collections to group assets for a game, level or art-direction pass.</div>
      ) : (
        <div className="row wrap">
          {cols.map((c) => (
            <button key={c.id} className={`btn ${selected === c.id ? 'primary' : ''}`} onClick={() => setSelected(selected === c.id ? null : c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      {selected && cols.find((c) => c.id === selected) && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="row">
            <h2>{cols.find((c) => c.id === selected)!.name} — {assets.length} assets</h2>
            <span className="spacer" />
            <button className="btn small" onClick={() => setAdding(true)}>+ Add assets</button>
            <button className="btn small" onClick={async () => {
              const doc = await api.attributionForCollection(selected);
              setAttrDoc({ txt: doc.txt, md: doc.md });
            }}>© Attribution preview</button>
            <button className="btn small danger" onClick={async () => {
              if (!confirm('Delete this collection? Assets are not deleted.')) return;
              await api.deleteCollection(selected);
              setSelected(null);
              void refresh();
            }}>Delete</button>
          </div>
          {assets.length === 0 ? <p className="muted">Empty collection.</p> : (
            <div className="grid cards">
              {assets.map((a) => (
                <LibraryAssetCard key={a.id} asset={a} onFav={async () => { await api.updateAsset(a.id, { favorite: !a.favorite }); void api.collectionAssets(selected).then(setAssets); }} />
              ))}
            </div>
          )}
        </div>
      )}

      {adding && (
        <Modal title="Add assets to collection" onClose={() => setAdding(false)}>
          <div className="grid cards">
            {all.filter((a) => !assets.some((x) => x.id === a.id)).map((a) => (
              <LibraryAssetCard key={a.id} asset={a} onClick={async () => { await api.addToCollection(selected!, a.id); const next = await api.collectionAssets(selected!); setAssets(next); }} />
            ))}
          </div>
        </Modal>
      )}

      {attrDoc && (
        <Modal title="ATTRIBUTIONS preview" onClose={() => setAttrDoc(null)}>
          <pre className="attr-pre">{attrDoc.txt}</pre>
        </Modal>
      )}
    </div>
  );
}
