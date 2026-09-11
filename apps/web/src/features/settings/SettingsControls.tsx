import { ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Switch } from "../../ui/primitives";

export function WorkspaceSwitch({ checked, disabled = false, label, description, onChange }: { checked: boolean; disabled?: boolean; label: string; description?: string; onChange: (checked: boolean) => void }) {
  const descriptionId = useId();
  return <div className="dl-settings-switch-row"><div><strong>{label}</strong>{description && <p id={descriptionId}>{description}</p>}</div><Switch checked={checked} disabled={disabled} label={label} aria-describedby={description ? descriptionId : undefined} onCheckedChange={onChange} /></div>;
}

export function WorkspaceSettingsRow({ icon, title, description, value, onClick, danger = false }: { icon: ReactNode; title: string; description?: string; value?: string; onClick: () => void; danger?: boolean }) {
  return <button className={`dl-settings-link${danger ? " danger-action" : ""}`} type="button" onClick={onClick}>
    <span aria-hidden="true">{icon}</span><span><strong>{title}</strong>{description && <small>{description}</small>}</span>{value && <span className="dl-settings-link-value">{value}</span>}<ChevronRight size={17} aria-hidden="true" />
  </button>;
}

export function SettingsLoading({ count = 2 }: { count?: number }) {
  return <div className="dl-settings-loading" role="status"><span className="sr-only">正在读取设置</span>{Array.from({ length: count }, (_, index) => <span key={index} aria-hidden="true" />)}</div>;
}
