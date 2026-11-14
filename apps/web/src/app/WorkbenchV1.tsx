import { ACCENT_IDS, DESIGN_TOKENS, type AccentId, type ThemePreference } from "@duallane/design-tokens";
import {
  Copy,
  Forward,
  Lock,
  MoreHorizontal,
  Paperclip,
  Pin,
  Reply,
  Search,
  Send,
  Settings,
  Shield,
  Smile,
  Sparkles,
  Trash2
} from "lucide-react";
import { useState } from "react";
import { initializeV1Theme, useThemeStore } from "@/shared/theme/vibrancy";
import {
  Avatar,
  BrandLogo,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Select,
  Switch,
  Tooltip,
  TooltipProvider
} from "@/shared/ui";

initializeV1Theme();

const SAMPLE_MESSAGES = [
  { id: "1", author: "星辰", kind: "human" as const, text: "把群聊的回复串和话题合二为一后，右侧栏并列展开真的清爽太多了。", time: "10:12", self: false },
  { id: "2", author: "我", kind: "human" as const, text: "是的，而且消息列表可以从毛玻璃顶栏和悬浮输入框底下透过去，滚动顺滑很多。", time: "10:13", self: true },
  { id: "3", author: "回声", kind: "bot" as const, text: "已收到 v1.0 设计语言切换提案，点击右键可体验 Telegram 级快捷表情回应菜单。", time: "10:14", self: false },
  { id: "4", author: "星辰", kind: "human" as const, text: "试着右键这条消息，或者切一下浅色/深色与毛玻璃开关。", time: "10:15", self: false }
];

export function WorkbenchV1() {
  const { preference, resolvedMode, accent, transparency, reducedMotion, setPreference, setAccent, setTransparency, setReducedMotion } = useThemeStore();
  const [selectValue, setSelectValue] = useState("at_only");
  const [switchValue, setSwitchValue] = useState(true);
  const [busyButton, setBusyButton] = useState(false);
  const [lastReaction, setLastReaction] = useState<string>("👍");

  return (
    <TooltipProvider>
      <div className="dl-canvas-ambient min-h-dvh text-text antialiased selection:bg-accent-soft selection:text-accent">
        <div className="mx-auto flex max-w-[1160px] flex-col gap-6 px-4 py-6 compact:px-8 compact:py-8">
          {/* Header */}
          <header className="dl-glass-chrome sticky top-4 z-sticky flex flex-wrap items-center justify-between gap-4 rounded-panel border border-line px-5 py-3.5">
            <div className="flex items-center gap-3">
              <BrandLogo size={38} withTile animated />
              <div>
                <h1 className="text-[16px] font-bold tracking-[-0.032em]">DualLane · v1.0 组件工作台</h1>
                <p className="text-[12px] text-muted">
                  Two Trust Lanes. Crystal Clear. · 当前解析模式：{resolvedMode === "dark" ? "深色 Vibrancy" : "浅色 Vibrancy"}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl<ThemePreference>
                label="外观模式"
                value={preference}
                onValueChange={setPreference}
                options={[
                  { value: "system", label: "系统" },
                  { value: "light", label: "浅色" },
                  { value: "dark", label: "深色" }
                ]}
              />
              <Select
                label="主题强调色"
                value={accent}
                onValueChange={(v) => setAccent(v as AccentId)}
                className="w-32"
                options={ACCENT_IDS.map((id) => ({
                  value: id,
                  label: DESIGN_TOKENS.accents[id].label
                }))}
              />
            </div>
          </header>

          {/* Vibrancy Live Preview Card */}
          <section className="grid gap-6 wide:grid-cols-[1.25fr_0.9fr]">
            <div className="relative flex h-[440px] flex-col overflow-hidden rounded-dialog border border-line bg-surface/40 shadow-menu">
              {/* Translucent Top Bar */}
              <div className="dl-glass-chrome absolute inset-x-0 top-0 z-sticky flex items-center justify-between border-b border-line px-4 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Avatar name="DualLane 设计组" kind="group" size="sm" />
                  <div>
                    <div className="text-[14px] font-semibold leading-tight">DualLane v1.0 核心架构组</div>
                    <div className="text-[11.5px] text-muted">6 位成员 · 2 条常驻消息</div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Tooltip content="全库搜索 (Cmd+K)" side="bottom">
                    <IconButton label="搜索" size="sm">
                      <Search className="size-4" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip content="常驻消息" side="bottom">
                    <IconButton label="常驻" size="sm">
                      <Pin className="size-4" />
                    </IconButton>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton label="更多操作" size="sm">
                        <MoreHorizontal className="size-4" />
                      </IconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem icon={<Shield className="size-4" />}>会话权限与隐私</DropdownMenuItem>
                      <DropdownMenuItem icon={<Settings className="size-4" />}>群组设置</DropdownMenuItem>
                      <DropdownMenuItem icon={<Trash2 className="size-4" />} tone="danger">退出群聊</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Scrollable Timeline sliding under translucent top/bottom chrome */}
              <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-20 pt-16">
                {SAMPLE_MESSAGES.concat(SAMPLE_MESSAGES).map((msg, idx) => (
                  <ContextMenu key={`${msg.id}-${idx}`}>
                    <ContextMenuTrigger asChild>
                      <div
                        className={`group flex items-end gap-2.5 ${msg.self ? "flex-row-reverse" : "flex-row"}`}
                      >
                        {!msg.self && <Avatar name={msg.author} kind={msg.kind} size="sm" />}
                        <div
                          className={`max-w-[78%] rounded-panel border px-3.5 py-2 text-[14px] leading-relaxed transition-colors ${
                            msg.self
                              ? "border-accent/25 bg-accent-soft text-text"
                              : "border-line bg-surface/85 text-text"
                          }`}
                        >
                          {!msg.self && (
                            <div className="mb-0.5 flex items-center gap-1.5 text-[11.5px] font-medium text-muted">
                              <span>{msg.author}</span>
                              {msg.kind === "bot" && (
                                <span className="rounded-tag bg-accent-soft px-1.5 py-px text-[10px] font-semibold text-accent">
                                  BOT
                                </span>
                              )}
                            </div>
                          )}
                          <p>{msg.text}</p>
                          <div className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-muted">
                            <span>{msg.time}</span>
                            {msg.self && <span className="text-accent">✓✓</span>}
                          </div>
                        </div>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent onQuickReaction={(emoji) => setLastReaction(emoji)}>
                      <ContextMenuItem icon={<Reply className="size-4" />}>回复并展开讨论串</ContextMenuItem>
                      <ContextMenuItem icon={<Forward className="size-4" />}>转发消息</ContextMenuItem>
                      <ContextMenuItem icon={<Copy className="size-4" />}>复制文本</ContextMenuItem>
                      <ContextMenuItem icon={<Pin className="size-4" />}>设为群常驻</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem icon={<Trash2 className="size-4" />} tone="danger">撤回消息</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>

              {/* Floating Glass Composer Pill */}
              <div className="pointer-events-none absolute inset-x-3 bottom-3 z-sticky">
                <div className="dl-glass-pill pointer-events-auto flex items-center gap-1.5 rounded-dialog border border-line px-2 py-1.5">
                  <IconButton label="添加附件" size="sm" className="rounded-full">
                    <Paperclip className="size-4" />
                  </IconButton>
                  <input
                    type="text"
                    readOnly
                    value={`最近快捷回应：${lastReaction} · 试试右键消息或滚动上方列表`}
                    className="h-8 flex-1 bg-transparent px-1.5 text-[13.5px] text-text focus:outline-none"
                  />
                  <Popover>
                    <PopoverTrigger asChild>
                      <IconButton label="选择表情" size="sm" className="rounded-full">
                        <Smile className="size-4" />
                      </IconButton>
                    </PopoverTrigger>
                    <PopoverContent side="top" align="end" className="w-64 p-3">
                      <p className="mb-2 text-[12px] font-medium text-muted">毛玻璃 Popover（自动视口防碰撞）</p>
                      <div className="grid grid-cols-6 gap-1">
                        {["👍", "❤️", "😂", "🔥", "🎉", "👀", "🚀", "✨", "🫡", "💡", "🎯", "⚡"].map((e) => (
                          <Button key={e} variant="ghost" size="sm" className="h-8 px-0 text-[16px]" onClick={() => setLastReaction(e)}>
                            {e}
                          </Button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                  <IconButton label="发送" variant="primary" size="sm" className="rounded-full">
                    <Send className="size-3.5" />
                  </IconButton>
                </div>
              </div>
            </div>

            {/* Right Column: Controls & Primitives */}
            <div className="flex flex-col gap-4">
              <div className="dl-glass-chrome rounded-panel border border-line p-5">
                <h2 className="mb-3 text-[15px] font-semibold">材质与交互开关</h2>
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[14px] font-medium">毛玻璃透明材质</div>
                      <div className="text-[12px] text-muted">关闭后立即切换高对比度实色表面</div>
                    </div>
                    <Switch
                      label="毛玻璃透明材质"
                      checked={transparency === "glass"}
                      onCheckedChange={(checked) => setTransparency(checked ? "glass" : "solid")}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[14px] font-medium">减弱动态效果</div>
                      <div className="text-[12px] text-muted">同步禁用浮层入场/退场与弹簧过渡</div>
                    </div>
                    <Switch
                      label="减弱动态效果"
                      checked={reducedMotion}
                      onCheckedChange={setReducedMotion}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[14px] font-medium">自定义开关示例</div>
                      <div className="text-[12px] text-muted">44×44px 触控热区 · 弹簧圆点</div>
                    </div>
                    <Switch label="示例开关" checked={switchValue} onCheckedChange={setSwitchValue} />
                  </div>
                </div>
              </div>

              <div className="dl-glass-chrome rounded-panel border border-line p-5">
                <h2 className="mb-3 text-[15px] font-semibold">受控原语组件</h2>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" busy={busyButton} onClick={() => setBusyButton((v) => !v)}>
                    <Sparkles className="size-4" />
                    {busyButton ? "加载中 (点击恢复)" : "主要操作"}
                  </Button>
                  <Button variant="secondary">次要操作</Button>
                  <Button variant="glass">毛玻璃按钮</Button>
                  <Button variant="ghost">幽灵按钮</Button>
                  <Button variant="danger">危险操作</Button>
                </div>

                <div className="mt-4 grid gap-3 compact:grid-cols-2">
                  <Select
                    label="Bot 群聊隐私策略"
                    value={selectValue}
                    onValueChange={setSelectValue}
                    options={[
                      { value: "at_only", label: "仅 @ 与斜杠命令触发", description: "默认隐私模式" },
                      { value: "context_20", label: "开放最近 20 条群上下文", description: "群内透明公示" }
                    ]}
                  />
                  <Input placeholder="语义焦点输入（1px 边框 + 焦点光环）" />
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
                  <div className="flex items-center gap-2">
                    <Avatar name="个人空间" kind="saved" size="sm" />
                    <Avatar name="Alice" kind="human" size="sm" online />
                    <Avatar name="产品群" kind="group" size="sm" />
                    <Avatar name="回声" kind="bot" size="sm" />
                  </div>

                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="primary" size="sm">
                        <Lock className="size-3.5" />
                        打开毛玻璃 Modal
                      </Button>
                    </DialogTrigger>
                    <DialogContent size="sm">
                      <DialogHeader>
                        <DialogTitle>统一毛玻璃设置弹窗</DialogTitle>
                        <DialogDescription>
                          基于 Radix Dialog + Portal + 深色物理遮罩，自动锁定背景并支持丝滑出入场动画。
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-3 px-6 py-4 text-[13.5px] text-muted">
                        <p>不会再出现旧版 CSS Container Query 劫持 fixed 弹窗、或暗色模式下遮罩惨白发光的问题。</p>
                        <Input placeholder="试试按下 Tab 键测试焦点陷阱…" />
                      </div>
                      <DialogFooter>
                        <DialogClose asChild>
                          <Button variant="ghost">取消</Button>
                        </DialogClose>
                        <DialogClose asChild>
                          <Button variant="primary">确认</Button>
                        </DialogClose>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </TooltipProvider>
  );
}
