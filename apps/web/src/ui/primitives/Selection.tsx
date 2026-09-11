import { useId, useRef, type ComponentPropsWithRef, type ReactNode } from "react";

export type SelectionItemProps = ComponentPropsWithRef<"button"> & {
  selected: boolean;
  placement?: "side" | "bottom";
};

export function SelectionItem({ selected, placement = "side", className = "", children, type = "button", ...props }: SelectionItemProps) {
  return <button {...props} type={type} className={`dl-selection ${className}`} data-selected={selected} data-placement={placement}>
    <span className="dl-selection-surface">{children}</span>
  </button>;
}

export type TabItem = { value: string; label: ReactNode; content: ReactNode; disabled?: boolean };
export type TabsProps = { value: string; onValueChange: (value: string) => void; label: string; items: TabItem[]; orientation?: "horizontal" | "vertical"; className?: string };

export function Tabs({ value, onValueChange, label, items, orientation = "horizontal", className = "" }: TabsProps) {
  const id = useId();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedIndex = items.findIndex((item) => item.value === value);
  const hasSelectedEnabled = selectedIndex >= 0 && !items[selectedIndex].disabled;
  return <div className={`dl-tabs ${className}`} data-orientation={orientation}>
    <div role="tablist" aria-label={label} aria-orientation={orientation} className="dl-tab-list" onKeyDown={(event) => {
      const forward = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
      const backward = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
      if (![forward, backward, "Home", "End"].includes(event.key)) return;
      const enabled = items.filter((item) => !item.disabled);
      if (!enabled.length) return;
      event.preventDefault();
      const current = enabled.findIndex((item) => tabRefs.current.get(item.value) === document.activeElement);
      const direction = orientation === "horizontal" && getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 : (current + (event.key === forward ? direction : -direction) + enabled.length) % enabled.length;
      const item = enabled[next];
      onValueChange(item.value);
      tabRefs.current.get(item.value)?.focus();
    }}>
      {items.map((item, index) => <SelectionItem key={item.value} ref={(element) => { if (element) tabRefs.current.set(item.value, element); else tabRefs.current.delete(item.value); }} role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={value === item.value} selected={value === item.value} disabled={item.disabled} tabIndex={(hasSelectedEnabled && value === item.value) || (!hasSelectedEnabled && index === items.findIndex((entry) => !entry.disabled)) ? 0 : -1} placement={orientation === "horizontal" ? "bottom" : "side"} onClick={() => onValueChange(item.value)}>{item.label}</SelectionItem>)}
    </div>
    {items.map((item, index) => <div key={item.value} id={`${id}-panel-${index}`} role="tabpanel" aria-labelledby={`${id}-tab-${index}`} tabIndex={0} hidden={item.value !== value} className="dl-tab-panel">{item.content}</div>)}
  </div>;
}
