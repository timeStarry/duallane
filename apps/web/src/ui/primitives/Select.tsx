import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { measurePopup, trackPopupScroll } from "./popup";
import { SelectPage } from "./SelectPage";

export type SelectOption = { value: string; label: string; description?: string; disabled?: boolean };
export type SelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  label: string;
  name?: string;
  id?: string;
  disabled?: boolean;
  error?: string;
  description?: string;
  placeholder?: string;
  loading?: boolean;
  className?: string;
};

// A select-only combobox keeps DOM focus on its trigger. Highlighting never commits
// a value: Escape, outside interaction and scrolling can safely cancel a choice.
export function Select({ value, onValueChange, options, label, name, id, disabled, error, description, placeholder = "请选择", loading = false, className = "" }: SelectProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [pagePresentation, setPagePresentation] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const selected = options.find((option) => option.value === value);
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
  const blocked = disabled || loading || !enabled.length;
  const show = (last = false) => {
    if (blocked) return;
    // Safari does not focus buttons on pointer activation; the combobox owns
    // keyboard navigation and must establish its active descendant's focus.
    triggerRef.current?.focus({ preventScroll: true });
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
    setActive(selectedIndex >= 0 ? selectedIndex : last ? enabled.at(-1) ?? -1 : enabled[0]);
    setPagePresentation(options.length > 10 && window.matchMedia("(max-width: 760px)").matches);
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled || disabled || loading) return;
    onValueChange(option.value);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  useEffect(() => { if (disabled || (blocked && !pagePresentation)) setOpen(false); }, [blocked, disabled, pagePresentation]);
  useLayoutEffect(() => {
    if (!open || pagePresentation || !triggerRef.current || !popupRef.current) return;
    const update = () => {
      if (triggerRef.current && popupRef.current) setPosition(measurePopup(triggerRef.current, popupRef.current, true));
    };
    update();
    const resize = new ResizeObserver(update);
    resize.observe(triggerRef.current);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => { resize.disconnect(); window.removeEventListener("resize", update); window.visualViewport?.removeEventListener("resize", update); window.visualViewport?.removeEventListener("scroll", update); };
  }, [open, options.length, pagePresentation]);
  useEffect(() => {
    if (!open || pagePresentation) return;
    const dismissForScroll = trackPopupScroll(triggerRef.current);
    const closeOutside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (!path.includes(triggerRef.current as EventTarget) && !path.includes(popupRef.current as EventTarget)) setOpen(false);
    };
    const closeScroll = (event: Event) => {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return;
      if (dismissForScroll(event)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("scroll", closeScroll, true);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("scroll", closeScroll, true); };
  }, [open, pagePresentation]);
  useEffect(() => {
    if (!open || pagePresentation) return;
    if (!options[active] || options[active].disabled) setActive(enabled[0] ?? -1);
    popupRef.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, options, enabled, pagePresentation]);

  return <div className={`dl-select-field ${className}`}>
    <label id={`${controlId}-label`} htmlFor={controlId}>{label}</label>
    {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
    <button ref={triggerRef} id={controlId} type="button" role="combobox" className="dl-select-trigger" aria-labelledby={`${controlId}-label ${controlId}-value`} aria-expanded={open} aria-controls={open ? `${controlId}-${pagePresentation ? "page" : "listbox"}` : undefined} aria-haspopup={open && pagePresentation ? "dialog" : "listbox"} aria-activedescendant={open && !pagePresentation && active >= 0 ? `${controlId}-option-${active}` : undefined} aria-invalid={Boolean(error)} aria-describedby={error ? `${controlId}-error` : description ? `${controlId}-description` : undefined} disabled={blocked} onClick={() => open ? setOpen(false) : show()} onBlur={(event) => { if (!pagePresentation && (!(event.relatedTarget instanceof Node) || !popupRef.current?.contains(event.relatedTarget))) setOpen(false); }} onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
      if (event.key === "Tab") { setOpen(false); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (!open) { show(event.key === "ArrowUp" || event.key === "End"); return; }
        const current = enabled.indexOf(active);
        setActive(event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1) ?? -1 : enabled[(current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length]);
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && open) { event.preventDefault(); choose(active); return; }
      if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing && event.key !== " ") {
        event.preventDefault();
        const now = Date.now();
        const search = searchRef.current;
        const text = now - search.time > 700 ? event.key : search.text + event.key;
        searchRef.current = { text, time: now };
        const index = options.findIndex((option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(text.toLocaleLowerCase()));
        if (index >= 0) { if (!open) show(); setActive(index); }
      }
    }}>
      <span id={`${controlId}-value`}>{selected?.label ?? placeholder}</span>{loading ? <LoaderCircle size={16} className="dl-spinner" aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
    </button>
    {description && <p id={`${controlId}-description`} className="dl-field-description">{description}</p>}
    {error && <p id={`${controlId}-error`} className="dl-field-error" role="alert">{error}</p>}
    {!loading && !options.length && <p className="dl-field-description" role="status">暂无可选项</p>}
    {open && pagePresentation && createPortal(<SelectPage id={`${controlId}-page`} label={label} value={value} options={options} loading={loading} error={error} onSelect={(nextValue) => choose(options.findIndex((option) => option.value === nextValue))} onClose={() => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); }} />, triggerRef.current?.closest("dialog[open]") ?? document.body)}
    {open && !pagePresentation && createPortal(<div ref={popupRef} id={`${controlId}-listbox`} role="listbox" aria-labelledby={`${controlId}-label`} className="dl-select-popup dl-scroll-area" style={position} onPointerDown={(event) => event.preventDefault()}>
      {options.map((option, index) => <div id={`${controlId}-option-${index}`} key={option.value} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-option-index={index} data-active={index === active} className="dl-select-option" onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(index)}>
        <span><span className="dl-select-option-label">{option.label}</span>{option.description && <span className="dl-field-description">{option.description}</span>}</span><Check size={16} aria-hidden="true" style={{ visibility: option.value === value ? "visible" : "hidden" }} />
      </div>)}
    </div>, triggerRef.current?.closest("dialog[open]") ?? document.body)}
  </div>;
}
