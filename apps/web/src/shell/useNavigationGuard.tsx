import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type NavigationGuard = {
  message: string;
  title?: string;
  confirmLabel?: string;
  saveLabel?: string;
  continue?: (action: () => void) => void;
  save?: () => Promise<boolean>;
  /** Explicitly completed commands supersede a pending leave intent; ordinary draft saves do not. */
  completed?: () => boolean;
  discard: () => void | boolean;
};

/** Owns user intent before navigation mutates a route or tears down a session. */
export function useNavigationGuard() {
  const guardRef = useRef<NavigationGuard | null>(null);
  const pendingRef = useRef<{ guard: NavigationGuard; action: () => void } | null>(null);
  const bypassRef = useRef(false);
  const savingRef = useRef(false);
  const [pending, setPending] = useState<NavigationGuard | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const register = useCallback((guard: NavigationGuard | null) => {
    guardRef.current = guard;
    if (!guard && !savingRef.current && pendingRef.current?.guard.completed?.()) {
      pendingRef.current = null;
      setPending(null);
    }
  }, []);
  const runConfirmed = useCallback((action: () => void) => {
    const previous = bypassRef.current;
    bypassRef.current = true;
    try { action(); } finally { bypassRef.current = previous; }
  }, []);
  const request = useCallback((action: () => void, explicitGuard?: NavigationGuard) => {
    if (bypassRef.current) { action(); return; }
    // A save may clear the registered draft while its existing confirmation still owns an intent.
    if (pendingRef.current) return;
    const guard = explicitGuard ?? guardRef.current;
    if (!guard) { action(); return; }
    pendingRef.current = { guard, action };
    setPending(guard);
    setError("");
  }, []);
  const cancel = useCallback(() => {
    if (savingRef.current) return;
    pendingRef.current = null;
    setPending(null);
  }, []);
  const proceed = async (save: boolean) => {
    const intent = pendingRef.current;
    if (!intent || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (save && intent.guard.save) {
        if (!(await intent.guard.save())) { setError("尚未保存成功，请返回检查或重试。"); return; }
      } else if (intent.guard.discard() === false) {
        setError("操作尚未结束，请稍后再试。"); return;
      }
      pendingRef.current = null;
      setPending(null);
      runConfirmed(() => { if (intent.guard.continue) intent.guard.continue(intent.action); else intent.action(); });
    } catch {
      setError("操作未完成，当前内容仍然保留。");
    } finally { savingRef.current = false; setSaving(false); }
  };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!guardRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  return {
    register,
    request,
    runConfirmed,
    isBlocked: () => Boolean(guardRef.current || pendingRef.current),
    confirmation: pending ? <IntentDialog onCancel={cancel}>
      <h2 id="navigation-confirm-title">{pending.title ?? (pending.save ? "保存当前修改？" : "结束当前会话？")}</h2>
      <p id="navigation-confirm-description">{pending.message}</p>
      {error && <p role="alert">{error}</p>}
      <div className="action-row">
        <button type="button" className="secondary" onClick={cancel} disabled={saving} autoFocus>继续留在这里</button>
        <button type="button" className="secondary" onClick={() => void proceed(false)} disabled={saving}>{pending.confirmLabel ?? (pending.save ? "放弃修改并离开" : "结束会话")}</button>
        {pending.save && <button type="button" className="primary" onClick={() => void proceed(true)} disabled={saving}>{saving ? "正在保存…" : (pending.saveLabel ?? "保存并继续")}</button>}
      </div>
    </IntentDialog> : null
  };
}

function IntentDialog({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="intent-dialog" aria-labelledby="navigation-confirm-title" aria-describedby="navigation-confirm-description" onCancel={(event) => { event.preventDefault(); onCancel(); }}>{children}</dialog>;
}
