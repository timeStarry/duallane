import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemberPickerDialog, type MemberPickerCandidate, type MemberPickerSubmission } from "./MemberPickerDialog";
import { initializeAppearance } from "../../ui/theme";
import "../../styles.css";

const initialCandidates: MemberPickerCandidate[] = [
  { id: "a", displayName: "安宁", secondaryText: "产品设计 · anning" },
  { id: "b", displayName: "林予", secondaryText: "前端开发 · linyu" },
  { id: "long", displayName: "这是一位姓名很长需要完整换行展示的协作成员 LongMemberWithoutSpaces1234567890", secondaryText: "研究与体验" },
  { id: "existing", displayName: "已有成员" },
  { id: "disabled", displayName: "服务助手", disabledReason: "此成员暂不支持加入群聊" },
  ...Array.from({ length: 24 }, (_, index) => ({ id: `member-${index}`, displayName: `协作成员 ${index + 1}`, secondaryText: `member${index + 1}` }))
];

type Control = { action: "scope" | "remove" | "disable" | "existing" | "resolve" | "reject" | "close"; id?: string };

function Harness() {
  const [open, setOpen] = useState(false);
  const [scopeKey, setScopeKey] = useState("actor:1/group:a");
  const [candidates, setCandidates] = useState(initialCandidates);
  const [existing, setExisting] = useState(["existing"]);
  const [calls, setCalls] = useState<readonly string[][]>([]);
  const [writes, setWrites] = useState<readonly string[]>([]);
  const [closeReason, setCloseReason] = useState("");
  const [consumed, setConsumed] = useState(0);
  const [aborted, setAborted] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef<{ resolve: () => void; reject: (error: Error) => void; context: MemberPickerSubmission } | null>(null);

  useEffect(() => {
    const control = (event: Event) => {
      const detail = (event as CustomEvent<Control>).detail;
      if (detail.action === "scope") setScopeKey("actor:1/group:b");
      if (detail.action === "close") setOpen(false);
      if (detail.action === "remove") setCandidates((current) => current.filter((member) => member.id !== detail.id));
      if (detail.action === "disable") setCandidates((current) => current.map((member) => member.id === detail.id ? { ...member, disabledReason: "成员权限已更新" } : member));
      if (detail.action === "existing" && detail.id) setExisting((current) => [...current, detail.id!]);
      if (detail.action === "resolve") request.current?.resolve();
      if (detail.action === "reject") request.current?.reject(new Error("林予邀请失败，保留其余选择后重试。"));
    };
    window.addEventListener("test:member-picker", control);
    return () => window.removeEventListener("test:member-picker", control);
  }, []);

  return <main style={{ padding: 24 }}>
    <h1>成员邀请交互验证</h1>
    <button ref={trigger} className="dl-button" onClick={() => { setOpen(true); setCloseReason(""); }}>打开成员选择</button>
    <output id="picker-test-state">{JSON.stringify({ calls, writes, closeReason, consumed, aborted, scopeKey })}</output>
    <MemberPickerDialog open={open} scopeKey={scopeKey} groupName="设计与协作小组" candidates={candidates} existingMemberIds={existing} returnFocus={trigger.current} onClose={(reason) => { setOpen(false); setCloseReason(reason); }} onConfirm={async (ids, context) => {
      setCalls((current) => [...current, [...ids]]);
      context.signal.addEventListener("abort", () => setAborted(true), { once: true });
      try {
        await new Promise<void>((resolve, reject) => { request.current = { resolve, reject, context }; });
        if (context.isCurrent()) setWrites((current) => [...current, ...ids.filter(context.isAvailable)]);
      } finally {
        setConsumed((current) => current + 1);
      }
    }} />
  </main>;
}

initializeAppearance();
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
