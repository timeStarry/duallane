import { ArrowLeft, BellRing, Bot, ChevronRight, Images, LockKeyhole, LogOut, MessageSquare, Palette, UserRound } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Button, SelectionItem } from "../../ui/primitives";
import { WorkspaceAvatar } from "../../WorkspaceAvatar";
import type { AccountSettingsSection, SettingsUser } from "./contracts";
import "./settings.css";

const categories = [
  { id: "profile", label: "个人资料", description: "头像、公开昵称与账号", icon: UserRound },
  { id: "appearance", label: "外观", description: "主题、显示模式与手感", icon: Palette },
  { id: "chat", label: "聊天", description: "消息显示与发送偏好", icon: MessageSquare },
  { id: "notifications", label: "通知", description: "邮件与移动推送", icon: BellRing },
  { id: "privacy", label: "隐私", description: "成员发现与可见范围", icon: LockKeyhole },
  { id: "emotes", label: "表情", description: "收藏、合集与订阅", icon: Images },
  { id: "bot", label: "Bot 与连接", description: "个人 Bot、连接与授权", icon: Bot }
] as const;

export function settingsParent(section: AccountSettingsSection): AccountSettingsSection {
  return section === "email" || section === "push" ? "notifications" : "";
}
export function settingsCategory(section: AccountSettingsSection): AccountSettingsSection {
  return section === "email" || section === "push" ? "notifications" : section;
}
export function SettingsLayout({ section, currentUser, onNavigate, onBack, onLogout, children }: {
  section: AccountSettingsSection;
  currentUser: Pick<SettingsUser, "displayName" | "avatarUrl" | "githubLogin">;
  onNavigate: (section: AccountSettingsSection) => void;
  onBack: () => void;
  onLogout?: () => void;
  children?: ReactNode;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollPositions = useRef(new Map<AccountSettingsSection, number>());
  const previousSection = useRef(section);
  const category = settingsCategory(section);
  const title = section === "email" ? "邮件通知" : section === "push" ? "移动推送" : categories.find((item) => item.id === section)?.label ?? "个人设置";
  const description = section === "email" ? "管理接收频率与通知邮箱。" : section === "push" ? "设置移动提醒，连接你的 ntfy 客户端。" : categories.find((item) => item.id === section)?.description;
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element) return;
    element.scrollTop = scrollPositions.current.get(section) ?? 0;
    if (previousSection.current !== section) {
      if (section) titleRef.current?.focus({ preventScroll: true });
      else navigation.current?.querySelector<HTMLButtonElement>(`[data-settings-category="${settingsCategory(previousSection.current)}"]`)?.focus({ preventScroll: true });
    }
    previousSection.current = section;
    return () => { scrollPositions.current.set(section, element.scrollTop); };
  }, [section]);
  const navigate = (next: AccountSettingsSection) => {
    if (pane.current) scrollPositions.current.set(section, pane.current.scrollTop);
    onNavigate(next);
  };
  return <div className="workspace-content-panel dl-personal-settings" data-settings-section={section || "home"}>
    <nav ref={navigation} className="dl-settings-navigation" aria-label="个人设置分类">
      <div className="dl-settings-identity"><WorkspaceAvatar name={currentUser.displayName} avatarUrl={currentUser.avatarUrl} decorative /><span><strong>{currentUser.displayName}</strong><small>{currentUser.githubLogin ? `@${currentUser.githubLogin}` : "个人设置"}</small></span></div>
      <h2 className="dl-settings-mobile-title">个人设置</h2>
      <div className="dl-settings-categories">{categories.map(({ id, label, description, icon: Icon }) => <SelectionItem key={id} selected={category === id} aria-current={category === id ? "page" : undefined} data-settings-category={id} className="dl-settings-category" onClick={() => navigate(id)}><Icon size={18} aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span><ChevronRight size={16} aria-hidden="true" /></SelectionItem>)}</div>
      {onLogout && <div className="dl-settings-account-actions"><Button variant="danger" className="dl-settings-logout" leadingIcon={<LogOut size={17} aria-hidden="true" />} onClick={onLogout}>退出登录</Button><small>退出当前设备上的共享空间</small></div>}
    </nav>
    <div className="dl-settings-pane" ref={pane} onScroll={(event) => scrollPositions.current.set(section, event.currentTarget.scrollTop)}>
      <header className="dl-settings-page-header"><button type="button" className="icon-button dl-settings-back" aria-label={section ? settingsParent(section) ? "返回通知" : "返回个人设置" : "返回会话列表"} title={section ? "返回上一级" : "返回会话列表"} onClick={() => section ? navigate(settingsParent(section)) : onBack()}><ArrowLeft size={18} /></button><div><p className="eyebrow">个人设置{section === "email" || section === "push" ? " / 通知" : ""}</p><h2 tabIndex={-1} ref={titleRef}>{title}</h2>{description && <p className="dl-settings-page-description">{description}</p>}</div></header>
      <div className="dl-settings-page-body">{section ? children : <div className="dl-settings-home-summary"><UserRound size={30} aria-hidden="true" /><h3>属于你的使用习惯</h3><p>从左侧选择类别。个人设置不会改变空间权限或私密直连的保存方式。</p></div>}</div>
    </div>
  </div>;
}
