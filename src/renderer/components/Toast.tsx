import React, { createContext, useContext } from 'react';

export interface Toast { id: string; message: string; kind?: 'info' | 'error' | 'success' }

export const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind ?? 'info'}`}>{t.message}</div>
      ))}
    </div>
  );
}
