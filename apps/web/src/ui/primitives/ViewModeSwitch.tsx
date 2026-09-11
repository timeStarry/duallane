import { LayoutGrid, List } from "lucide-react";
import { SegmentedControl } from "./SegmentedControl";
import "./view-mode-switch.css";

export type ViewMode = "list" | "grid";
export type ViewModeSwitchProps = {
  value: ViewMode;
  onValueChange: (value: ViewMode) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
};

/** Local presentation controls, not navigation tabs or a change to the file scope. */
export function ViewModeSwitch({ value, onValueChange, label = "展示方式", disabled = false, className = "" }: ViewModeSwitchProps) {
  return <SegmentedControl className={`dl-view-mode-switch ${className}`} label={label} hideLabel value={value} disabled={disabled} onValueChange={(next) => { if (next === "list" || next === "grid") onValueChange(next); }} options={[
    { value: "list", label: "列表", accessibleLabel: "列表视图", icon: <List /> },
    { value: "grid", label: "卡片", accessibleLabel: "卡片视图", icon: <LayoutGrid /> }
  ]} />;
}
