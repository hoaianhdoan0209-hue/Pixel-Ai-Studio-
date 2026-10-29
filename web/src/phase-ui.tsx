import React, { useState, type ReactNode } from 'react';

export async function request<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const multipart = body instanceof FormData;
  const response = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({ error: 'Phản hồi máy chủ không hợp lệ.' }));
  if (!response.ok) throw new Error(value.error || `Yêu cầu thất bại (${response.status}).`);
  return value;
}

export function ErrorMessage({ error }: { error: string }) { return error ? <p className="form-error" role="alert">{error}</p> : null; }
export function Notice({ children }: { children: ReactNode }) { return <p className="notice">{children}</p>; }
export function ActionForm({ children, onSubmit, submit = 'Lưu', onDone }: { children: ReactNode; onSubmit: (data: FormData, form: HTMLFormElement) => Promise<unknown>; submit?: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <form className="form-stack phase-form" onSubmit={async e => {
    e.preventDefault(); const form = e.currentTarget; setBusy(true); setError('');
    try { await onSubmit(new FormData(form), form); onDone?.(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }}>{children}<ErrorMessage error={error}/><button className="button button-primary" disabled={busy}>{busy ? 'Đang xử lý…' : submit}</button></form>;
}
export const readableDate = (value?: string) => value ? new Date(value).toLocaleString('vi-VN') : '—';
