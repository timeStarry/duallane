import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { SegmentedControl } from "../../ui/primitives";
import { useAppearance } from "../../ui/theme";
import { WorkspaceSwitch } from "./SettingsControls";
import { ThemePicker } from "./ThemePicker";
import "./appearance-mode.css";

const modes = [
  { value: "system", label: "系统", accessibleLabel: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", accessibleLabel: "浅色", icon: Sun },
  { value: "dark", label: "深色", accessibleLabel: "深色", icon: Moon }
] as const;
type AppearanceMode = typeof modes[number]["value"];

export function AppearanceModeSelector({ value, onValueChange }: { value: AppearanceMode; onValueChange: (mode: AppearanceMode) => void }) {
  return <SegmentedControl className="dl-appearance-mode-field" label="显示模式" value={value} options={modes.map(({ icon: Icon, ...option }) => ({ ...option, icon: <Icon /> }))} onValueChange={(mode) => { if (mode === "system" || mode === "light" || mode === "dark") onValueChange(mode); }} />;
}

export function AppearanceSettings() {
  const { preferences, resolved, setPreferences, storageAvailable, retryStorage } = useAppearance();
  const [changed, setChanged] = useState(false);
  const update: typeof setPreferences = (patch) => { setChanged(true); return setPreferences(patch); };
  return <div className="dl-appearance-settings">
    <ThemePicker value={preferences.themeId} mode={resolved.mode} onValueChange={(themeId) => update({ themeId })} />
    <section className="workspace-settings-detail"><div className="workspace-settings-detail-intro"><h3>显示</h3><p>明暗与内容密度独立于主题配色。</p></div><div className="dl-appearance-selects">
      <AppearanceModeSelector value={preferences.mode} onValueChange={(mode) => update({ mode })} />
      <SegmentedControl label="内容密度" value={preferences.density} options={[{ value: "comfortable", label: "舒适" }, { value: "compact", label: "紧凑" }]} onValueChange={(density) => { if (density === "comfortable" || density === "compact") update({ density }); }} />
    </div></section>
    <section className="workspace-settings-detail"><div className="workspace-settings-detail-intro"><h3>动态与材质</h3><p>调节界面反馈，保留一致的操作与焦点。</p></div>
      <WorkspaceSwitch checked={preferences.motion === "reduced"} label="减少动态效果" description={resolved.motion === "reduced" && preferences.motion !== "reduced" ? "系统正在要求减少动态效果。" : "关闭后跟随系统偏好；不改变操作结果和焦点。"} onChange={(checked) => update({ motion: checked ? "reduced" : "system" })} />
      <WorkspaceSwitch checked={preferences.transparency === "auto"} label="透明材质" description="关闭后使用实色背景，文字和控件保持清晰。" onChange={(checked) => update({ transparency: checked ? "auto" : "opaque" })} />
    </section>
    <div className="dl-settings-save-feedback" role="status">{!storageAvailable ? <><span>外观已应用，仅在本次页面生效。浏览器暂时无法保存。</span><button type="button" onClick={() => { setChanged(true); retryStorage(); }}>重试保存外观</button></> : changed ? "已保存到这台设备" : "外观偏好保存在这台设备，不与其他设备同步。"}</div>
  </div>;
}
