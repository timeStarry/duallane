import { ArrowLeft, Check, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { IconButton } from "./Button";
import type { SelectOption } from "./Select";

type SelectPageProps = {
  id: string;
  label: string;
  value: string;
  options: SelectOption[];
  loading: boolean;
  error?: string;
  onSelect: (value: string) => void;
  onClose: () => void;
};

/** The presentation is chosen once per opening. Filtering or live option updates
 * must not exchange the user's active dialog for a different kind of surface. */
export function SelectPage({ id: dialogId, label, value, options, loading, error, onSelect, onClose }: SelectPageProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string | null>(value);
  const [viewportStyle, setViewportStyle] = useState<CSSProperties>();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = options.filter((option) => `${option.label} ${option.description ?? ""}`.toLocaleLowerCase().includes(normalizedQuery));
  const enabledOptions = visibleOptions.filter((option) => !option.disabled);
  const active = enabledOptions.find((option) => option.value === activeValue) ?? enabledOptions[0];
  const activeIndex = active ? visibleOptions.indexOf(active) : -1;
  const activeId = !loading && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined;

  const close = () => {
    dialogRef.current?.close();
    onClose();
  };
  const select = (optionValue: string) => {
    const option = options.find((candidate) => candidate.value === optionValue);
    if (!option || option.disabled || loading) return;
    dialogRef.current?.close();
    onSelect(option.value);
  };
  const navigate = (event: KeyboardEvent<HTMLElement>, editing: boolean) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Enter" || (!editing && event.key === " ")) {
      event.preventDefault();
      if (active) select(active.value);
      return;
    }
    const navigationKeys = editing ? ["ArrowDown", "ArrowUp"] : ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!navigationKeys.includes(event.key) || loading) return;
    event.preventDefault();
    if (!enabledOptions.length) return;
    const current = enabledOptions.findIndex((option) => option.value === active?.value);
    const next = event.key === "Home" ? 0 : event.key === "End" ? enabledOptions.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + enabledOptions.length) % enabledOptions.length;
    setActiveValue(enabledOptions[next].value);
  };

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const update = () => {
      const viewport = window.visualViewport;
      setViewportStyle({ top: viewport?.offsetTop ?? 0, left: viewport?.offsetLeft ?? 0, width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight });
    };
    update();
    dialog.showModal();
    // Focus the title initially so opening a long list does not summon a keyboard.
    headingRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      dialog.close();
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);
  useEffect(() => {
    const row = activeId ? document.getElementById(activeId) : null;
    const list = listRef.current;
    if (!row || !list) return;
    // Scroll only the option pane; browser scrollIntoView can move the page behind
    // a modal on mobile when the virtual keyboard changes the visual viewport.
    const rowRect = row.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (rowRect.top < listRect.top) list.scrollTop -= listRect.top - rowRect.top;
    else if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom;
  }, [activeId, active?.value]);

  return <dialog ref={dialogRef} id={dialogId} className="dl-select-page" style={viewportStyle} aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className="dl-select-page-header">
      <IconButton label={`返回，取消选择${label}`} onClick={close}><ArrowLeft size={20} aria-hidden="true" /></IconButton>
      <h2 ref={headingRef} id={`${id}-title`} tabIndex={-1} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); listRef.current?.focus(); }
      }}>选择{label}</h2>
    </header>
    <div className="dl-select-page-search">
      <Search size={18} aria-hidden="true" />
      <input ref={searchRef} type="search" role="combobox" aria-label={`搜索${label}`} aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-listbox`} aria-activedescendant={activeId} autoComplete="off" value={query} placeholder="搜索名称或说明" onChange={(event) => { setQuery(event.currentTarget.value); setActiveValue(null); }} onKeyDown={(event) => navigate(event, true)} />
      {query && <IconButton label="清除搜索" onClick={() => { setQuery(""); setActiveValue(value); searchRef.current?.focus(); }}><X size={18} aria-hidden="true" /></IconButton>}
    </div>
    {error && <p className="dl-select-page-error" role="alert">{error}</p>}
    <p className="dl-select-page-result-count" role="status">{loading ? "正在更新选项…" : visibleOptions.length ? `${visibleOptions.length} 个选项` : normalizedQuery ? "没有匹配的选项，请换个关键词" : "暂无可选项"}</p>
    <div ref={listRef} id={`${id}-listbox`} className="dl-select-page-options dl-scroll-area" role="listbox" aria-label={label} aria-activedescendant={activeId} aria-busy={loading} tabIndex={0} onKeyDown={(event) => navigate(event, false)}>
      {loading && <div className="dl-select-page-loading"><LoaderCircle size={18} className="dl-spinner" aria-hidden="true" />正在更新</div>}
      {!loading && visibleOptions.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-active={option.value === active?.value} className="dl-select-option" onPointerMove={(event) => { if (event.pointerType === "mouse" && !option.disabled) setActiveValue(option.value); }} onClick={() => select(option.value)}>
        <span><span className="dl-select-option-label">{option.label}</span>{option.description && <span className="dl-field-description">{option.description}</span>}</span><Check size={18} aria-hidden="true" style={{ visibility: option.value === value ? "visible" : "hidden" }} />
      </div>)}
    </div>
  </dialog>;
}
