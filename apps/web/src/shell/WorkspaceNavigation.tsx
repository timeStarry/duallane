import { Files, Hash, MessageSquare, PanelLeftClose, PanelLeftOpen, Settings2, UserRound, UsersRound } from "lucide-react";
import type { WorkspaceRouteView } from "../app-route";
import { SelectionItem } from "../ui/primitives";

const destinations = [
  { id: "chat", label: "聊天", icon: MessageSquare },
  { id: "topics", label: "话题", icon: Hash },
  { id: "files", label: "文件", icon: Files },
  { id: "members", label: "成员", icon: UsersRound },
  { id: "account", label: "个人", icon: UserRound },
  { id: "space", label: "空间", icon: Settings2 }
] as const;

export function WorkspaceNavigation({ view, onNavigate, canManageSpace, railCollapsed, onToggleRail }: {
  view: WorkspaceRouteView;
  onNavigate: (view: Exclude<WorkspaceRouteView, "new">) => void;
  canManageSpace: boolean;
  railCollapsed: boolean;
  onToggleRail: () => void;
}) {
  const hasObjectList = view === "chat" || view === "topics";
  const toggleLabel = hasObjectList ? railCollapsed ? "展开中栏" : "收起中栏" : "当前视图没有中栏";
  return <nav className="workspace-primary-navigation" aria-label="共享空间视图">
    <button type="button" className="icon-button desktop-only workspace-rail-toggle" aria-label={toggleLabel} title={toggleLabel} disabled={!hasObjectList} aria-expanded={hasObjectList ? !railCollapsed : undefined} aria-controls={hasObjectList ? "workspace-object-list" : undefined} onClick={onToggleRail}>
      {railCollapsed ? <PanelLeftOpen size={19} aria-hidden="true" /> : <PanelLeftClose size={19} aria-hidden="true" />}
    </button>
    {destinations.filter(({ id }) => id !== "space" || canManageSpace).map(({ id, label, icon: Icon }) => <SelectionItem
      key={id}
      className={id === "account" ? "workspace-nav-account" : undefined}
      selected={view === id}
      placement="side"
      aria-current={view === id ? "page" : undefined}
      aria-controls="workspace-main-panel"
      onClick={() => onNavigate(id)}
    ><Icon size={19} aria-hidden="true" /><span>{label}</span></SelectionItem>)}
  </nav>;
}
