import { Mail } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SegmentedControl, Switch } from "../../ui/primitives";
import { userFacingErrorMessage } from "../../user-facing-error";
import type { SettingsNotice, SettingsServices } from "./contracts";
import "./settings.css";

type WorkspaceEmailSettings = {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  encryption: "starttls" | "tls" | "none";
  username: string;
  fromAddress: string;
  fromName: string;
  passwordConfigured: boolean;
  activeFrom?: string | null;
  lastTestedAt: string | null;
  lastTestStatus: "success" | "failure" | null;
  lastTestErrorCode: string | null;
  lastDeliveryAt?: string | null;
  failedJobCount: number;
};

export function WorkspaceEmailSettingsPanel({ onNotice, services }: { onNotice: SettingsNotice; services: Pick<SettingsServices, "json"> }) {
  const workspaceJson = services.json;
  const activeRef = useRef(true);
  const [loadRevision, setLoadRevision] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [operationError, setOperationError] = useState("");
  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false; }; }, []);
  const [settings, setSettings] = useState<WorkspaceEmailSettings | null>(null);
  const [draft, setDraft] = useState({
    enabled: false,
    smtpHost: "",
    smtpPort: 587,
    encryption: "starttls" as WorkspaceEmailSettings["encryption"],
    username: "",
    password: "",
    fromAddress: "",
    fromName: "DualLane"
  });
  const [testProof, setTestProof] = useState("");
  const [testedRecipient, setTestedRecipient] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"" | "test" | "save">("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    void workspaceJson<{ settings: WorkspaceEmailSettings }>("/api/workspace/settings/email")
      .then((data) => {
        if (cancelled) return;
        setSettings(data.settings);
        setDraft({
          enabled: data.settings.enabled,
          smtpHost: data.settings.smtpHost,
          smtpPort: data.settings.smtpPort,
          encryption: data.settings.encryption,
          username: data.settings.username,
          password: "",
          fromAddress: data.settings.fromAddress,
          fromName: data.settings.fromName
        });
      })
      .catch((error) => {
        if (!cancelled) setLoadError(userFacingErrorMessage(error, "邮件配置暂时无法加载"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadRevision]);

  function updateDraft<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setTestProof("");
    setTestedRecipient("");
  }

  async function testSettings() {
    setBusy("test");
    setOperationError("");
    try {
      const data = await workspaceJson<{ testProof: string; recipient: string; testedAt: string }>("/api/workspace/settings/email/test", {
        method: "POST",
        body: JSON.stringify(draft)
      });
      if (!activeRef.current) return;
      setTestProof(data.testProof);
      setTestedRecipient(data.recipient);
      setSettings((current) => current ? { ...current, lastTestedAt: data.testedAt, lastTestStatus: "success", lastTestErrorCode: null } : current);
      onNotice("success", "测试邮件发送成功，当前配置可保存");
    } catch (error) {
      if (!activeRef.current) return;
      setTestProof("");
      setOperationError(userFacingErrorMessage(error, "测试邮件发送失败，当前配置已保留，请重试"));
    } finally {
      if (activeRef.current) setBusy("");
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save");
    setOperationError("");
    try {
      const data = await workspaceJson<{ settings: WorkspaceEmailSettings }>("/api/workspace/settings/email", {
        method: "PUT",
        body: JSON.stringify({ ...draft, testProof })
      });
      if (!activeRef.current) return;
      setSettings(data.settings);
      setDraft((current) => ({ ...current, password: "" }));
      setTestProof("");
      setTestedRecipient("");
      onNotice("success", data.settings.enabled ? "空间邮件通知已启用" : "邮件配置已保存并停用");
    } catch (error) {
      if (activeRef.current) setOperationError(userFacingErrorMessage(error, "邮件配置保存失败，输入已保留，请重试"));
    } finally {
      if (activeRef.current) setBusy("");
    }
  }

  if (loading) {
    return <section className="workspace-settings-section" aria-busy="true"><p className="workspace-form-status">正在读取邮件配置...</p></section>;
  }

  if (loadError || !settings) return <section className="workspace-settings-section"><p role="alert">{loadError || "邮件配置暂时无法读取。"}</p><button type="button" onClick={() => setLoadRevision((value) => value + 1)}>重新加载邮件配置</button></section>;

  return (
    <form className="workspace-settings-section workspace-email-settings" onSubmit={saveSettings}>
      <div className="workspace-section-header">
        <div>
          <h3>邮件服务</h3>
          <p>SMTP 凭据加密保存。启用配置前必须先发送测试邮件。</p>
        </div>
        <Switch checked={draft.enabled} disabled={Boolean(busy)} label="启用邮件服务" onCheckedChange={(enabled) => updateDraft("enabled", enabled)} />
      </div>
      <fieldset className="workspace-settings-grid three-columns dl-email-settings-fields" disabled={Boolean(busy)} aria-label="邮件服务配置">
        <label><span>SMTP 服务器</span><input value={draft.smtpHost} onChange={(event) => updateDraft("smtpHost", event.target.value)} placeholder="smtp.example.com" required /></label>
        <label><span>端口</span><input type="number" min={1} max={65535} value={draft.smtpPort} onChange={(event) => updateDraft("smtpPort", Number(event.target.value))} required /></label>
        <SegmentedControl label="加密方式" value={draft.encryption} disabled={Boolean(busy)} options={[{ value: "starttls", label: "STARTTLS" }, { value: "tls", label: "TLS" }, { value: "none", label: "不加密" }]} onValueChange={(value) => { if (value === "starttls" || value === "tls" || value === "none") updateDraft("encryption", value); }} />
        <label><span>用户名</span><input value={draft.username} onChange={(event) => updateDraft("username", event.target.value)} autoComplete="username" /></label>
        <label><span>密码</span><input type="password" value={draft.password} onChange={(event) => updateDraft("password", event.target.value)} autoComplete="new-password" placeholder={settings?.passwordConfigured ? "留空以保留现有密码" : "SMTP 密码"} /></label>
        <label><span>发信地址</span><input type="email" value={draft.fromAddress} onChange={(event) => updateDraft("fromAddress", event.target.value)} placeholder="可留空并使用邮箱格式用户名" /></label>
        <label><span>显示名称</span><input value={draft.fromName} onChange={(event) => updateDraft("fromName", event.target.value)} required /></label>
      </fieldset>
      {operationError && <p className="dl-settings-save-feedback" data-state="error" role="alert">{operationError}</p>}
      <div className="workspace-email-health" aria-label="邮件发送状态">
        <span>最近测试 <strong>{settings?.lastTestedAt ? new Date(settings.lastTestedAt).toLocaleString("zh-CN") : "暂无"}</strong></span>
        <span>最后发送 <strong>{settings?.lastDeliveryAt ? new Date(settings.lastDeliveryAt).toLocaleString("zh-CN") : "暂无"}</strong></span>
        <span>失败任务 <strong>{settings?.failedJobCount ?? 0}</strong></span>
      </div>
      {testProof && <p className="workspace-form-status success">已通过测试，将发送至 {testedRecipient}。证明 10 分钟内有效。</p>}
      <div className="workspace-form-actions">
        <button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => void testSettings()}>
          <Mail size={16} />
          {busy === "test" ? "测试中" : "发送测试邮件"}
        </button>
        <button className="primary" type="submit" disabled={Boolean(busy) || (draft.enabled && !testProof)}>
          {busy === "save" ? "保存中" : draft.enabled ? "保存并启用" : "保存配置"}
        </button>
      </div>
    </form>
  );
}
