import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import "./confirmation.css";

type Choice = "confirm" | "alternative" | "cancel";
type Confirmation = {
  title?: string;
  message: string;
  confirmLabel?: string;
  alternativeLabel?: string;
  danger?: boolean;
};
type ConfirmationService = {
  confirm: (message: string, options?: Omit<Confirmation, "message" | "alternativeLabel">) => Promise<boolean>;
  choose: (options: Confirmation) => Promise<Choice>;
  cancelPending: () => void;
};
const Context = createContext<ConfirmationService | null>(null);

/** Resolve one explicit command at a time; cancellation never performs another destructive command. */
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Confirmation | null>(null);
  const pending = useRef<((choice: Choice) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const choose = useCallback(async (options: Confirmation): Promise<Choice> => {
    const currentGeneration = generation.current;
    const choice = await new Promise<Choice>((resolve) => {
    if (pending.current) { resolve("cancel"); return; }
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pending.current = resolve;
    setRequest(options);
    });
    return currentGeneration === generation.current ? choice : "cancel";
  }, []);
  const confirm = useCallback(async (message: string, options: Omit<Confirmation, "message" | "alternativeLabel"> = {}) => (await choose({ message, ...options })) === "confirm", [choose]);
  const finish = (choice: Choice) => {
    const resolve = pending.current;
    pending.current = null;
    dialog.current?.close();
    setRequest(null);
    if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
    resolve?.(choice);
  };
  const cancelPending = useCallback(() => {
    generation.current += 1;
    const resolve = pending.current;
    pending.current = null;
    if (!resolve) return;
    dialog.current?.close();
    setRequest(null);
    resolve("cancel");
  }, []);
  useEffect(() => { if (request) dialog.current?.showModal(); }, [request]);
  useEffect(() => () => { pending.current?.("cancel"); pending.current = null; }, []);
  return <Context.Provider value={{ confirm, choose, cancelPending }}>{children}{request && <dialog ref={dialog} className="dl-confirmation-dialog" onKeyDown={(event) => event.stopPropagation()} aria-labelledby="command-confirm-title" aria-describedby="command-confirm-message" onCancel={(event) => { event.preventDefault(); finish("cancel"); }}>
    <h2 id="command-confirm-title">{request.title ?? "确认操作"}</h2>
    <p id="command-confirm-message">{request.message}</p>
    <div className="dl-confirmation-actions">
      <button type="button" className="secondary" autoFocus onClick={() => finish("cancel")}>取消</button>
      {request.alternativeLabel && <button type="button" className="secondary" onClick={() => finish("alternative")}>{request.alternativeLabel}</button>}
      <button type="button" className={request.danger === false ? "primary" : "primary danger-action"} onClick={() => finish("confirm")}>{request.confirmLabel ?? "确认操作"}</button>
    </div>
  </dialog>}</Context.Provider>;
}

export function useConfirmation() {
  const service = useContext(Context);
  if (!service) throw new Error("ConfirmationProvider is required");
  return service;
}
