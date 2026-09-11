import { useEffect, useId, useState, type CSSProperties } from "react";

export type SliderProps = { label: string; value: number; onValueChange: (value: number) => void; min?: number; max?: number; step?: number; unit?: string; disabled?: boolean; id?: string; description?: string };

export function Slider({ label, value, onValueChange, min = 0, max = 100, step = 1, unit = "", disabled, id, description }: SliderProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState("");
  useEffect(() => { setDraft(String(value)); setError(""); }, [value]);
  const commit = () => {
    if (draft === String(value)) { setError(""); return; }
    const number = Number(draft);
    if (!draft.trim() || !Number.isFinite(number) || number < min || number > max || Math.abs((number - min) / step - Math.round((number - min) / step)) > 1e-7) {
      setError(`请输入 ${min}–${max} 范围内、步进为 ${step} 的数值`);
      return;
    }
    setError("");
    onValueChange(number);
  };
  return <div className="dl-slider-field">
    <label htmlFor={controlId}>{label}</label>
    <div className="dl-slider-controls">
      <input id={controlId} className="dl-slider" type="range" value={value} min={min} max={max} step={step} disabled={disabled} aria-valuetext={`${value}${unit}`} aria-describedby={description ? `${controlId}-help` : undefined} style={{ "--dl-range-progress": `${max > min ? Math.max(0, Math.min(100, (value - min) / (max - min) * 100)) : 0}%` } as CSSProperties} onChange={(event) => onValueChange(event.currentTarget.valueAsNumber)} />
      <div className="dl-slider-exact"><input type="number" aria-label={`${label}精确数值`} value={draft} min={min} max={max} step={step} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={error ? `${controlId}-error` : undefined} onChange={(event) => { setDraft(event.currentTarget.value); setError(""); }} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } if (event.key === "Escape") { setDraft(String(value)); setError(""); } }} />{unit && <span aria-hidden="true">{unit}</span>}</div>
    </div>
    {description && <p className="dl-field-description" id={`${controlId}-help`}>{description}</p>}
    <p id={`${controlId}-error`} className="dl-field-error" aria-live="polite">{error}</p>
  </div>;
}
