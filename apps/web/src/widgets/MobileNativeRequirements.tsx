import { Input } from "@/shared/ui";

// Intent: an operator selects two different runtime boundaries. Keep the
// existing DL admin card, density, labels and semantic warning hierarchy.
export function MobileNativeRequirements({ otaFloor, supportedFloor, apkCode, disabled, otaAvailable, onOtaFloorChange, onSupportedFloorChange }: {
  otaFloor: number; supportedFloor: number; apkCode: number; disabled: boolean; otaAvailable: boolean;
  onOtaFloorChange: (code: number) => void; onSupportedFloorChange: (code: number) => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-dl-border-hairline bg-dl-surface-card/70 p-3">
      <div className="text-xs font-semibold text-dl-text-primary">原生版本兼容与强制更新</div>
      <div className="grid grid-cols-2 max-compact:grid-cols-1 gap-3">
        <div className="space-y-1">
          <label htmlFor="mobile-ota-native-floor" className="text-xs text-dl-text-secondary">热更所需原生版本号</label>
          <Input id="mobile-ota-native-floor" type="number" min={1} max={apkCode || undefined} value={otaFloor || ""} disabled={disabled || !otaAvailable} onChange={(e) => onOtaFloorChange(Number(e.target.value) || 0)} />
          <p className="text-[11px] leading-5 text-dl-text-tertiary">低于它只不能应用此热更，不会因此停止使用。</p>
        </div>
        <div className="space-y-1">
          <label htmlFor="mobile-supported-native-floor" className="text-xs text-dl-text-secondary">最低可用原生版本号</label>
          <Input id="mobile-supported-native-floor" type="number" min={0} max={apkCode || undefined} value={supportedFloor} disabled={disabled} onChange={(e) => onSupportedFloorChange(Number(e.target.value) || 0)} />
          <p className="text-[11px] leading-5 text-dl-text-tertiary">低于它必须安装新版 APK 后继续使用；填 0 关闭强制更新。</p>
        </div>
      </div>
      <p className="text-[11px] leading-5 text-dl-text-secondary">先验证兼容热更和可下载的签名 APK，再提高最低可用版本。版本号应使用真实安装包的 versionCode，不使用界面热更版本。</p>
    </div>
  );
}
