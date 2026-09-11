import { ArrowLeft, Copy, Ellipsis, MessageCircle, RotateCcw, Send, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button, IconButton, ObjectActionMenu, SegmentedControl, Select, SelectionItem, Slider, Switch, Tabs, useObjectActions } from "../primitives";
import { THEMES, isThemeId, useAppearance } from "../theme";
import { LongSelectExample } from "./LongSelectExample";
import "./workbench.css";

export function Workbench() {
  const appearance = useAppearance();
  const [notifications, setNotifications] = useState(true);
  const [tab, setTab] = useState("messages");
  const [category, setCategory] = useState("appearance");
  const [delivery, setDelivery] = useState("mentions");
  const [fontSize, setFontSize] = useState(15);
  const [status, setStatus] = useState("尚未执行操作");
  const [messageVisible, setMessageVisible] = useState(true);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const confirmation = useRef<HTMLDialogElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const message = useRef<HTMLElement>(null);
  const objectActions = useObjectActions("workbench-message-1");
  const actions = [
    { id: "reply", label: "回复", icon: <MessageCircle />, onSelect: () => { setDraft("回复林澈："); composer.current?.focus(); setStatus("已建立本页回复草稿"); } },
    { id: "copy", label: "复制消息", icon: <Copy />, onSelect: () => {
      void navigator.clipboard.writeText("明天下午一起把新版的设置流程走一遍，重点检查保存失败后是否保留输入。").then(() => setStatus("已复制样例消息"), () => setStatus("复制失败，请选择正文后复制"));
    } },
    { id: "pin", label: "常驻消息", disabled: true, disabledReason: "此样例没有常驻权限", onSelect: () => undefined },
    { id: "hide", label: "从我的视图隐藏", icon: <Trash2 />, danger: true, onSelect: () => { setConfirming(true); confirmation.current?.showModal(); } }
  ];
  const cancelConfirm = () => { confirmation.current?.close(); setConfirming(false); message.current?.focus({ preventScroll: true }); };

  return <main className="dl-workbench">
    <header className="dl-workbench-header"><a href="/" className="dl-workbench-back"><ArrowLeft size={18} aria-hidden="true" />返回应用</a><div><p className="dl-workbench-eyebrow">DualLane · 内部组件工作台</p><h1>同一份组件，从规则到实际操作</h1><p>这里直接使用正式组件源码。消息、权限和保存状态均为合成场景，不连接账号或业务服务。</p></div></header>
    <section aria-label="工作台外观"><div className="dl-workbench-control-grid"><Select label="工作台主题" value={appearance.preferences.themeId} options={Object.entries(THEMES).map(([value, theme]) => ({ value, label: theme.name }))} onValueChange={(themeId) => { if (isThemeId(themeId)) appearance.setPreferences({ themeId }); }} /><SegmentedControl label="工作台明暗模式" value={appearance.preferences.mode} options={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }, { value: "system", label: "跟随系统" }]} onValueChange={(mode) => { if (mode === "light" || mode === "dark" || mode === "system") appearance.setPreferences({ mode }); }} /></div></section>
    <section aria-labelledby="wb-actions"><div className="dl-workbench-section-title"><h2 id="wb-actions">按钮与反馈</h2><p>操作保留稳定尺寸。等待状态、禁用与失败都有可查的呈现。</p></div><div className="dl-workbench-row"><Button variant="primary" leadingIcon={<Send size={18} />} onClick={() => setStatus("已触发本页主要操作")}>发送消息</Button><Button variant="primary" lane="direct">私密直连</Button><Button>次要操作</Button><Button variant="quiet">稍后处理</Button><Button disabled>暂不可用</Button><Button busy>正在保存</Button><IconButton label="更多示例操作"><Ellipsis size={18} /></IconButton></div><div className="dl-workbench-row"><Button busy={saving} onClick={() => { setSaving(true); setSaveError(false); }}>模拟保存请求</Button>{saving && <><Button onClick={() => { setSaving(false); setStatus("样例保存成功"); }}>返回成功</Button><Button onClick={() => { setSaving(false); setSaveError(true); }}>返回失败</Button></>}{saveError && <span className="dl-workbench-inline-error" role="alert">保存失败，输入仍保留。<Button variant="quiet" leadingIcon={<RotateCcw size={16} />} onClick={() => { setSaveError(false); setSaving(true); }}>重试</Button></span>}</div></section>
    <section aria-labelledby="wb-controls"><div className="dl-workbench-section-title"><h2 id="wb-controls">偏好控件</h2><p>自有选择面板支持键盘定位与取消；数值输入不会静默修正越界值。</p></div><form id="wb-preferences" className="dl-workbench-control-grid" onSubmit={(event) => event.preventDefault()}><div className="dl-workbench-setting"><div><strong>接收会话通知</strong><p>只演示当前控件的选中状态。</p></div><Switch label="接收会话通知" name="notifications" checked={notifications} onCheckedChange={setNotifications} /></div><div className="dl-workbench-setting"><div><strong>受限开关</strong><p>不可用状态仍可理解。</p></div><Switch label="受限开关" checked disabled onCheckedChange={() => undefined} /></div><SegmentedControl label="通知范围" name="delivery" value={delivery} onValueChange={setDelivery} options={[{ value: "all", label: "所有消息", description: "接收会话内所有新消息" }, { value: "mentions", label: "仅回复和提及", description: "让重要回应优先出现" }, { value: "digest", label: "每日摘要", disabled: true, description: "此合成场景暂不可用" }, { value: "off", label: "关闭通知" }]} /><Select label="长名称与失败" value="long" onValueChange={() => undefined} options={[{ value: "long", label: "用于验证长中文名称与连续字符的可访问选项 Workspace-configuration-with-a-long-name" }]} error="同步失败，当前展示的是保留的选择" /><Slider label="消息字号样例" value={fontSize} onValueChange={setFontSize} min={12} max={24} unit="px" /><p className="dl-workbench-message-preview" style={{ fontSize }}>长文字要保持清楚、平稳的阅读节奏。调整控件不会重置其他输入。</p></form></section>
    <section aria-labelledby="wb-selection"><div className="dl-workbench-section-title"><h2 id="wb-selection">选中与导航</h2><p>独立 2px 指示条和圆角底面共享尺度；导航与页内 Tab 保留各自语义。</p></div><div className="dl-workbench-selection-grid"><nav aria-label="设置分类样例">{[{ value: "profile", label: "个人资料" }, { value: "appearance", label: "外观与显示" }, { value: "privacy", label: "隐私" }].map((item) => <SelectionItem key={item.value} selected={category === item.value} aria-current={category === item.value ? "page" : undefined} onClick={() => setCategory(item.value)}>{item.label}</SelectionItem>)}</nav><Tabs label="内容分类样例" value={tab} onValueChange={setTab} items={[{ value: "messages", label: "消息", content: <p>这是消息面板。切换标签后，下面的回复草稿会保留。</p> }, { value: "files", label: "文件", content: <p>没有附件时，明确说明当前状态与下一步入口。</p> }, { value: "members", label: "成员", content: <p>成员名称和权限信息使用文字表达，颜色只是辅助。</p> }, { value: "restricted", label: "暂不可用", disabled: true, content: null }]} /></div></section>
    <section aria-labelledby="wb-context"><div className="dl-workbench-section-title"><h2 id="wb-context">对象动作</h2><p>右键、Shift+F10、更多和手机长按共用动作。正文可原生选择，移动会取消长按。</p></div>{messageVisible ? <article ref={message} className="dl-workbench-object" tabIndex={0} aria-label="林澈的消息" {...objectActions.bind}><header><span className="dl-workbench-avatar" aria-hidden="true">林</span><span><strong>林澈</strong><small>合成消息 · 14:32</small></span><IconButton label="更多消息操作" onClick={(event) => objectActions.openFromTrigger(event.currentTarget)}><Ellipsis size={18} /></IconButton></header><p data-native-context>明天下午一起把新版的设置流程走一遍，重点检查保存失败后是否保留输入。</p><footer>消息操作区域</footer></article> : <div className="dl-workbench-setting"><span>此样例已从本页隐藏。</span><Button onClick={() => { setMessageVisible(true); setStatus("样例消息已恢复"); }}>恢复消息</Button></div>}<label className="dl-workbench-draft-label" htmlFor="wb-draft">回复草稿</label><textarea ref={composer} id="wb-draft" className="dl-workbench-draft" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} placeholder="切换控件后回来，草稿仍在这里" /><ObjectActionMenu {...objectActions.menuProps} label="消息操作" summary="林澈 · 明天下午一起把新版的设置流程走一遍…" actions={actions} /></section>
    <LongSelectExample />
    <p role="status" className="dl-workbench-status">{status}</p>
    <dialog ref={confirmation} className="dl-workbench-confirm" aria-labelledby="wb-confirm-title" onCancel={(event) => { event.preventDefault(); cancelConfirm(); }}><h2 id="wb-confirm-title">隐藏这条样例消息？</h2><p>只改变工作台中的显示，可以恢复。</p><div className="dl-workbench-row"><Button onClick={cancelConfirm}>取消</Button><Button variant="danger" disabled={!confirming} onClick={() => { confirmation.current?.close(); setConfirming(false); setMessageVisible(false); setStatus("已隐藏样例消息，其他人的视图不受影响"); composer.current?.focus(); }}>确认隐藏</Button></div></dialog>
  </main>;
}
