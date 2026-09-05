import React from 'react';

export function Modal(props: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal" style={props.wide === false ? { maxWidth: 560 } : undefined}>
        <div className="row" style={{ marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>{props.title}</h2>
          <span className="spacer" />
          <button className="btn small ghost" onClick={props.onClose}>✕</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
