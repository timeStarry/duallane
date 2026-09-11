import { useEffect, useRef, useState } from "react";
import { Button, Select, type SelectOption } from "../primitives";

const FULL_OPTIONS: SelectOption[] = Array.from({ length: 18 }, (_, index) => ({
  value: `group-${index + 1}`,
  label: `设计讨论组 ${String(index + 1).padStart(2, "0")}${index === 17 ? " · 用于验证长中文名称与连续字符跨行显示 Workspace-configuration-with-a-very-long-name" : ""}`,
  description: index === 4 ? "暂未获得此讨论组的访问权限" : `合成项目 ${index + 1} 的讨论空间`,
  disabled: index === 4
}));

export function LongSelectExample() {
  const [value, setValue] = useState("group-1");
  const [options, setOptions] = useState(FULL_OPTIONS);
  const [pending, setPending] = useState(false);
  const [changes, setChanges] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <section aria-labelledby="wb-long-select">
    <div className="dl-workbench-section-title"><h2 id="wb-long-select">长列表与移动选择</h2><p>手机上以完整选择层浏览和搜索，返回保留原值。可以模拟选项在打开期间变更，观察焦点和搜索内容是否保持。</p></div>
    <div className="dl-workbench-control-grid">
      <Select label="目标讨论组" value={value} onValueChange={(nextValue) => { setValue(nextValue); setChanges((current) => current + 1); }} options={options} />
      <div><p role="status" aria-label="选择记录">当前值：{value} · 已提交 {changes} 次</p><p className="dl-field-description">{pending ? "3 秒后模拟选项更新，请打开选择层" : options.length < 10 ? "选项已更新，仅保留前 6 项" : "目前有 18 个合成选项，其中一项禁用"}</p></div>
    </div>
    <div className="dl-workbench-row"><Button disabled={pending} onClick={() => {
      setPending(true);
      timer.current = setTimeout(() => { setOptions(FULL_OPTIONS.slice(0, 6)); setPending(false); timer.current = null; }, 3000);
    }}>模拟选项更新</Button><Button disabled={pending || options.length === FULL_OPTIONS.length} onClick={() => setOptions(FULL_OPTIONS)}>恢复完整列表</Button></div>
  </section>;
}
