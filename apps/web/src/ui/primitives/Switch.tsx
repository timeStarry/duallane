import { useId, type ButtonHTMLAttributes } from "react";

export type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "onClick" | "children"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: string;
};

export function Switch({ checked, onCheckedChange, label, description, className = "", id, ...props }: SwitchProps) {
  const generatedId = useId();
  const descriptionId = `${id ?? generatedId}-description`;
  return <span className="dl-switch-field">
    {props.name && <input type="hidden" name={props.name} value={props.value ?? "on"} disabled={props.disabled || !checked} />}
    <button {...props} type="button" id={id} role="switch" aria-checked={checked} aria-label={label} aria-describedby={description ? descriptionId : props["aria-describedby"]} className={`dl-switch ${className}`} onClick={() => onCheckedChange(!checked)}>
      <span className="dl-switch-track" aria-hidden="true"><span className="dl-switch-thumb" /></span>
    </button>
    {description && <span id={descriptionId} className="dl-field-description">{description}</span>}
  </span>;
}
