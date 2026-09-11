import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Select } from "./Select";
import "./segmented-control.css";

export type SegmentedOption = { value: string; label: string; accessibleLabel?: string; icon?: ReactNode; disabled?: boolean; description?: string };
export type SegmentedControlProps = {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SegmentedOption[];
  disabled?: boolean;
  description?: string;
  name?: string;
  id?: string;
  className?: string;
  hideLabel?: boolean;
};

/** Fixed, short option sets; measured space decides whether one row remains readable. */
export function SegmentedControl({ label, value, onValueChange, options, disabled = false, description, name, id, className = "", hideLabel = false }: SegmentedControlProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const field = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocus = useRef(false);
  const [compact, setCompact] = useState(false);
  const useSelect = compact || options.length > 4;
  const measurementKey = JSON.stringify(options.map((option) => [option.label, Boolean(option.icon)]));
  useLayoutEffect(() => {
    const container = field.current;
    const row = measure.current;
    if (!container || !row) return;
    const update = () => {
      if (!container.clientWidth) return;
      const widths = [...row.children].map((child) => child.getBoundingClientRect().width);
      const needed = Math.max(44, ...widths) * widths.length + 4 * Math.max(0, widths.length - 1) + 10;
      const next = needed > container.clientWidth + 0.5;
      setCompact((previous) => {
        if (next !== previous) {
          const active = document.activeElement;
          restoreFocus.current = container.contains(active) || Boolean(document.getElementById(`${controlId}-page`)?.contains(active));
        }
        return next;
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(row);
    return () => observer.disconnect();
  }, [measurementKey, controlId]);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    field.current?.querySelector<HTMLButtonElement>('button[tabindex="0"], button[role="combobox"]')?.focus({ preventScroll: true });
  }, [useSelect]);
  const enabled = options.filter((option) => !option.disabled);
  const entry = enabled.find((option) => option.value === value)?.value ?? enabled[0]?.value;
  const choose = (option: SegmentedOption) => {
    if (!disabled && !option.disabled && option.value !== value) onValueChange(option.value);
  };
  const content = (option: SegmentedOption) => <>{option.icon && <span className="dl-segmented-icon" aria-hidden="true">{option.icon}</span>}<span>{option.label}</span></>;
  return <div ref={field} className={`dl-segmented-field ${className}`} data-hide-label={hideLabel || undefined}>
    <div className="dl-segmented-measure-clip" aria-hidden="true"><div ref={measure} className="dl-segmented-measure">{options.map((option) => <span className="dl-segmented-option" key={option.value}>{content(option)}</span>)}</div></div>
    {useSelect ? <Select id={controlId} label={label} name={name} value={value} onValueChange={onValueChange} options={options.map((option) => ({ ...option, label: option.accessibleLabel ?? option.label }))} disabled={disabled} description={description} /> : <>
      <span id={`${controlId}-label`} className={hideLabel ? "sr-only" : "dl-segmented-label"}>{label}</span>
      <div id={controlId} className="dl-segmented" role="radiogroup" aria-labelledby={`${controlId}-label`} aria-describedby={description ? `${controlId}-description` : undefined} aria-disabled={disabled || undefined} style={{ "--segment-count": Math.max(1, options.length) } as CSSProperties} onKeyDown={(event) => {
        if (disabled || !enabled.length || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = enabled.findIndex((option) => refs.current.get(option.value) === document.activeElement);
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        const direction = event.key === "ArrowRight" ? (rtl ? -1 : 1) : event.key === "ArrowLeft" ? (rtl ? 1 : -1) : event.key === "ArrowDown" ? 1 : -1;
        const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 : (Math.max(0, current) + direction + enabled.length) % enabled.length;
        const option = enabled[next];
        refs.current.get(option.value)?.focus({ preventScroll: true });
        choose(option);
      }}>
        {options.map((option) => <button key={option.value} ref={(element) => { if (element) refs.current.set(option.value, element); else refs.current.delete(option.value); }} className="dl-segmented-option" type="button" role="radio" aria-label={option.accessibleLabel} title={option.accessibleLabel ?? option.description} aria-checked={value === option.value} disabled={disabled || option.disabled} tabIndex={!disabled && entry === option.value ? 0 : -1} onClick={() => choose(option)}>{content(option)}</button>)}
      </div>
      {description && <small id={`${controlId}-description`} className="dl-segmented-description">{description}</small>}
      {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
    </>}
  </div>;
}
