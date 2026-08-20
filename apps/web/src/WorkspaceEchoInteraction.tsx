import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  CircleX,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  Send,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceInteractiveCard, type WorkspaceCardBlock } from "./WorkspaceInteractiveCard";
import { createWorkspaceJsonHeaders } from "./workspace-http";

export const ECHO_BOT_USER_ID = "usr_system_echo";

export const WORKSPACE_ECHO_COMMAND_NAMES = Object.freeze([
  "help",
  "cancel",
  "publish",
  "release",
  "need",
  "feedback",
  "list",
  "view",
  "collect",
  "implement",
  "reject"
] as const);

const WORKSPACE_ECHO_COMMAND_SET = new Set<string>(WORKSPACE_ECHO_COMMAND_NAMES);

type EchoComposerBlock =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string; label: string }
  | { type: "emote"; token: string };

export type WorkspaceEchoCommandMatch = {
  commandName: string;
  source: string;
  mentionedBotIds: string[];
};

export type WorkspaceEchoCommandRequest = WorkspaceEchoCommandMatch & {
  conversationId: string;
  botUserId: string;
  clientInvocationId: string;
  draftSignature: string;
};

export type WorkspaceEchoInteractionSlot = {
  request: WorkspaceEchoCommandRequest;
  activeWorkflowId?: string;
  accepted?: boolean;
};

type EchoCommandContext = {
  conversationType: "direct" | "group";
  echoIsParticipant: boolean;
  source: string;
  blocks: EchoComposerBlock[];
};

type EchoCommandOutcome = {
  ok?: boolean;
  replayed?: boolean;
  result?: Record<string, unknown>;
  resultCardId?: string | null;
};

type EchoWorkflow = {
  id: string;
  conversationId?: string | null;
  botUserId?: string | null;
  type: "echo.publish" | "echo.requirement" | string;
  version: number;
  status: "active" | "completed" | "cancelled" | "expired" | "conflicted";
  revision: number;
  expiresAt: string;
  state: {
    step?: string;
    fields?: Record<string, unknown>;
  };
};

type EchoWorkflowResponse = {
  workflow: EchoWorkflow;
  result?: Record<string, unknown> | null;
};

type EchoDraft = Record<string, unknown>;

type EchoStepDescriptor = {
  title: string;
  description: string;
  field?: string;
  label?: string;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
};

type EchoApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    workflowId?: string;
    activeWorkflowId?: string;
    workflow?: { id?: string };
    activeWorkflow?: { id?: string };
    details?: { activeWorkflowId?: string };
  };
  workflowId?: string;
  activeWorkflowId?: string;
  workflow?: { id?: string };
  activeWorkflow?: { id?: string };
};

class EchoInteractionError extends Error {
  code: string;
  payload: EchoApiErrorPayload;

  constructor(code: string, message: string, payload: EchoApiErrorPayload = {}) {
    super(message);
    this.name = "EchoInteractionError";
    this.code = code;
    this.payload = payload;
  }
}

export function recognizeWorkspaceEchoCommand(context: EchoCommandContext): WorkspaceEchoCommandMatch | null {
  if (!context.echoIsParticipant) return null;
  const mentioned = context.blocks.some(
    (block) => block.type === "mention" && block.userId === ECHO_BOT_USER_ID
  );
  if (context.conversationType === "group" && !mentioned) return null;

  const source = context.conversationType === "group"
    ? context.blocks.map((block) => {
      if (block.type === "mention" && block.userId === ECHO_BOT_USER_ID) return "";
      if (block.type === "mention") return `@${block.label}`;
      if (block.type === "emote") return block.token;
      return block.text;
    }).join("").trim()
    : context.source.trim();
  const match = /^\/([A-Za-z][A-Za-z0-9_-]{0,31})(?:\s+[\s\S]*)?$/u.exec(source);
  if (!match || !WORKSPACE_ECHO_COMMAND_SET.has(match[1].toLowerCase())) return null;
  return {
    commandName: match[1].toLowerCase(),
    source,
    mentionedBotIds: mentioned ? [ECHO_BOT_USER_ID] : []
  };
}

export function echoWorkflowStartInvocationId(clientInvocationId: string) {
  return `${clientInvocationId}:workflow`;
}

export function reusableWorkspaceEchoCommandRequest(
  slot: WorkspaceEchoInteractionSlot | undefined,
  draftSignature: string
) {
  return slot && !slot.accepted && slot.request.draftSignature === draftSignature ? slot.request : null;
}

export function clearStoredWorkspaceEchoWorkflowDrafts() {
  if (typeof sessionStorage === "undefined") return;
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(ECHO_WORKFLOW_DRAFT_STORAGE_PREFIX)));
    keys.forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // A disabled session store is already effectively cleared for the app.
  }
}

export function getEchoWorkflowStepDescriptor(workflow: Pick<EchoWorkflow, "type" | "state">): EchoStepDescriptor {
  const step = workflow.state.step || "confirm";
  if (workflow.type === "echo.publish") {
    const descriptors: Record<string, EchoStepDescriptor> = {
      title: { title: "征集标题", description: "用一句话说明本次征集的主题。", field: "title", label: "标题", placeholder: "例如：下一版本最需要改进什么", maxLength: 120 },
      description: { title: "补充说明", description: "说明征集背景和成员需要了解的范围。", field: "description", label: "说明", placeholder: "说明背景、范围与注意事项", multiline: true, maxLength: 10_000 },
      question: { title: "投票问题", description: "成员将在卡片上看到这个问题。", field: "question", label: "问题", placeholder: "例如：你最希望优先处理哪一项？", multiline: true, maxLength: 2_000 },
      options: { title: "选项与规则", description: "每行一个选项，并设置投票规则。", field: "options", label: "投票选项", placeholder: "选项一\n选项二", multiline: true, maxLength: 5_000 },
      confirm: { title: "确认发布", description: "确认后会创建征集并投递给符合条件的成员。" }
    };
    return descriptors[step] ?? descriptors.confirm;
  }
  const descriptors: Record<string, EchoStepDescriptor> = {
    type: { title: "反馈类型", description: "选择这次提交的内容类型。", field: "type", label: "类型" },
    title: { title: "简短标题", description: "用一句话概括你希望解决的问题。", field: "title", label: "标题", placeholder: "例如：支持按文件类型筛选", maxLength: 120 },
    detail: { title: "详细描述", description: "补充现状、问题和必要信息。", field: "detail", label: "详细描述", placeholder: "请描述需求或问题", multiline: true, maxLength: 10_000 },
    scenario: { title: "使用场景", description: "说明在什么情况下会用到它。", field: "scenario", label: "使用场景", placeholder: "例如：在手机上查找历史图片时", multiline: true, maxLength: 4_000 },
    expectedResult: { title: "期望结果", description: "说明完成后你希望看到的行为，可同时附上相关链接。", field: "expectedResult", label: "期望结果", placeholder: "描述理想结果", multiline: true, maxLength: 4_000 },
    confirm: { title: "确认提交", description: "提交后只有你和有处理权限的空间主人可以查看完整内容。" }
  };
  return descriptors[step] ?? descriptors.confirm;
}

export function WorkspaceEchoInteraction({
  slot,
  onCommandAccepted,
  onWorkflowIdChange,
  onDismiss,
  onRestoreFocus
}: {
  slot: WorkspaceEchoInteractionSlot;
  onCommandAccepted: (request: WorkspaceEchoCommandRequest) => void;
  onWorkflowIdChange: (workflowId: string | null) => void;
  onDismiss: () => void;
  onRestoreFocus: () => void;
}) {
  const [commandState, setCommandState] = useState<"loading" | "ready" | "error">("loading");
  const [commandError, setCommandError] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [resultCardId, setResultCardId] = useState("");
  const [workflow, setWorkflow] = useState<EchoWorkflow | null>(null);
  const [workflowDraft, setWorkflowDraft] = useState<EchoDraft>({});
  const [workflowBusy, setWorkflowBusy] = useState<"restore" | "start" | "continue" | "cancel" | "">("");
  const [workflowError, setWorkflowError] = useState("");
  const [workflowConflict, setWorkflowConflict] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const lastExecutedInvocationRef = useRef("");
  const callbacksRef = useRef({ onCommandAccepted, onWorkflowIdChange, onRestoreFocus });
  callbacksRef.current = { onCommandAccepted, onWorkflowIdChange, onRestoreFocus };

  useEffect(() => {
    if (!slot.activeWorkflowId || workflow?.id === slot.activeWorkflowId) return;
    let cancelled = false;
    setWorkflowBusy("restore");
    setWorkflowError("");
    void loadEchoWorkflow(slot.activeWorkflowId)
      .then((restored) => {
        if (!cancelled) {
          setWorkflow(restored);
          setWorkflowDraft(readStoredWorkflowDraft(restored.id));
        }
      })
      .catch((caught) => {
        if (!cancelled) setWorkflowError(echoInteractionErrorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setWorkflowBusy("");
      });
    return () => { cancelled = true; };
  }, [slot.activeWorkflowId, workflow?.id]);

  useEffect(() => {
    const invocationId = slot.request.clientInvocationId;
    const executionKey = `${invocationId}:${retryVersion}`;
    if (lastExecutedInvocationRef.current === executionKey) return;
    lastExecutedInvocationRef.current = executionKey;
    const controller = new AbortController();
    setCommandState("loading");
    setCommandError("");
    setResult(null);
    setResultCardId("");
    setWorkflowError("");
    setWorkflowConflict(false);

    void executeEchoCommand(slot.request, controller.signal)
      .then(async (outcome) => {
        if (controller.signal.aborted) return;
        const nextResult = outcome.result ?? {};
        if (nextResult.type === "workflow.start") {
          await startEchoWorkflow(slot.request, nextResult, controller.signal, {
            onWorkflow: (nextWorkflow, conflicted) => {
              setWorkflow(nextWorkflow);
              setWorkflowDraft({
                ...initialWorkflowDraft(slot.request.commandName, nextResult),
                ...readStoredWorkflowDraft(nextWorkflow.id)
              });
              setWorkflowConflict(conflicted);
              callbacksRef.current.onWorkflowIdChange(nextWorkflow.id);
              callbacksRef.current.onCommandAccepted(slot.request);
            },
            onBusy: setWorkflowBusy
          });
          return;
        }
        setResult(nextResult);
        setResultCardId(outcome.resultCardId ?? "");
        if (nextResult.type === "workflow.cancelled") {
          setWorkflow(null);
          callbacksRef.current.onWorkflowIdChange(null);
        }
        callbacksRef.current.onCommandAccepted(slot.request);
      })
      .then(() => {
        if (!controller.signal.aborted) setCommandState("ready");
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setCommandError(echoInteractionErrorMessage(caught));
        setCommandState("error");
      });
    return () => {
      controller.abort();
      if (lastExecutedInvocationRef.current === executionKey) {
        lastExecutedInvocationRef.current = "";
      }
    };
  }, [retryVersion, slot.request]);

  const step = workflow ? getEchoWorkflowStepDescriptor(workflow) : null;
  const visibleFields = useMemo(
    () => ({ ...(workflow?.state.fields ?? {}), ...workflowDraft }),
    [workflow?.state.fields, workflowDraft]
  );

  useEffect(() => {
    if (!workflow?.id) return;
    if (workflow.status !== "active") {
      removeStoredWorkflowDraft(workflow.id);
      return;
    }
    storeWorkflowDraft(workflow.id, workflowDraft);
  }, [workflow?.id, workflow?.status, workflowDraft]);

  async function continueWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workflow || workflow.status !== "active" || workflowBusy) return;
    const form = new FormData(event.currentTarget);
    let input: Record<string, unknown>;
    try {
      input = buildWorkflowStepInput(workflow, form);
    } catch (caught) {
      setWorkflowError(echoInteractionErrorMessage(caught));
      return;
    }
    setWorkflowBusy("continue");
    setWorkflowError("");
    try {
      const response = await echoJson<EchoWorkflowResponse>(
        `/api/workspace/workflows/${encodeURIComponent(workflow.id)}/continue`,
        {
          method: "POST",
          body: JSON.stringify({ expectedRevision: workflow.revision, input })
        }
      );
      setWorkflow(response.workflow);
      setWorkflowDraft((current) => ({ ...current, ...input }));
      if (response.result && response.result.type !== "workflow-step") setResult(response.result);
      if (response.workflow.status !== "active") {
        callbacksRef.current.onWorkflowIdChange(null);
        callbacksRef.current.onRestoreFocus();
      }
    } catch (caught) {
      if (caught instanceof EchoInteractionError && [
        "workflow.stale_revision",
        "workflow.race_conflict",
        "workflow.not_active",
        "workflow.expired"
      ].includes(caught.code)) {
        try {
          const latest = await loadEchoWorkflow(workflow.id);
          setWorkflow(latest);
          if (latest.status === "active") {
            setWorkflowError("流程已在别处更新，已载入最新步骤。");
          } else {
            setWorkflowError("");
            callbacksRef.current.onWorkflowIdChange(null);
            callbacksRef.current.onRestoreFocus();
          }
        } catch (reloadError) {
          setWorkflowError(echoInteractionErrorMessage(reloadError));
        }
      } else {
        setWorkflowError(echoInteractionErrorMessage(caught));
      }
    } finally {
      setWorkflowBusy("");
    }
  }

  async function cancelWorkflow() {
    if (!workflow || workflowBusy) return;
    setWorkflowBusy("cancel");
    setWorkflowError("");
    try {
      const response = await echoJson<{ workflow: EchoWorkflow }>(
        `/api/workspace/workflows/${encodeURIComponent(workflow.id)}/cancel`,
        { method: "POST" }
      );
      setWorkflow(response.workflow);
      setResult({ type: "workflow.cancelled", workflowId: workflow.id, cancelled: true });
      removeStoredWorkflowDraft(workflow.id);
      callbacksRef.current.onWorkflowIdChange(null);
      callbacksRef.current.onRestoreFocus();
    } catch (caught) {
      if (caught instanceof EchoInteractionError && ["workflow.race_conflict", "workflow.not_active"].includes(caught.code)) {
        try {
          const latest = await loadEchoWorkflow(workflow.id);
          setWorkflow(latest);
          if (latest.status !== "active") {
            removeStoredWorkflowDraft(workflow.id);
            callbacksRef.current.onWorkflowIdChange(null);
            callbacksRef.current.onRestoreFocus();
          } else {
            setWorkflowError("流程已在别处更新，请再次确认是否取消。");
          }
        } catch (reloadError) {
          setWorkflowError(echoInteractionErrorMessage(reloadError));
        }
      } else {
        setWorkflowError(echoInteractionErrorMessage(caught));
      }
    } finally {
      setWorkflowBusy("");
    }
  }

  function dismiss() {
    onDismiss();
    onRestoreFocus();
  }

  return (
    <section
      className={`workspace-echo-interaction${workflowConflict ? " conflicted" : ""}`}
      aria-label="回声交互"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (workflow?.status === "active") void cancelWorkflow();
        else dismiss();
      }}
    >
      <header className="workspace-echo-interaction-header">
        <span className="workspace-echo-interaction-icon" aria-hidden="true"><Bot size={18} /></span>
        <span>
          <strong>回声</strong>
          <small>{workflow ? workflowTitle(workflow.type) : `正在处理 /${slot.request.commandName}`}</small>
        </span>
        {workflow?.status === "active" ? (
          <button className="workspace-echo-interaction-close" type="button" disabled={Boolean(workflowBusy)} title="取消引导" onClick={() => void cancelWorkflow()}>
            <X size={17} />
          </button>
        ) : (
          <button className="workspace-echo-interaction-close" type="button" title="关闭" onClick={dismiss}>
            <X size={17} />
          </button>
        )}
      </header>

      <div className="workspace-echo-interaction-status" aria-live="polite">
        {commandState === "loading" && (
          <p className="workspace-echo-interaction-loading"><LoaderCircle size={16} className="spin" />正在执行命令</p>
        )}
        {commandState === "error" && (
          <div className="workspace-echo-interaction-error" role="alert">
            <AlertCircle size={17} />
            <span><strong>命令未执行</strong><small>{commandError}</small></span>
            <button className="secondary compact" type="button" onClick={() => setRetryVersion((version) => version + 1)}>
              <RefreshCw size={14} />重试
            </button>
          </div>
        )}
        {workflowBusy === "restore" && (
          <p className="workspace-echo-interaction-loading"><LoaderCircle size={16} className="spin" />正在恢复引导</p>
        )}
      </div>

      {workflow && (
        <EchoWorkflowPanel
          workflow={workflow}
          step={step!}
          fields={visibleFields}
          busy={workflowBusy}
          error={workflowError}
          conflicted={workflowConflict}
          onSubmit={continueWorkflow}
          onDraftField={(field, value) => setWorkflowDraft((current) => ({ ...current, [field]: value }))}
          onRetry={() => void loadEchoWorkflow(workflow.id).then(setWorkflow).catch((caught) => setWorkflowError(echoInteractionErrorMessage(caught)))}
          onDismiss={dismiss}
        />
      )}

      {commandState === "ready" && result && (
        <EchoCommandResult
          result={result}
          onDismiss={workflow?.status === "active" ? () => setResult(null) : dismiss}
        />
      )}
      {commandState === "ready" && resultCardId && (
        <EchoCommandResultCard cardId={resultCardId} />
      )}
    </section>
  );
}

function EchoWorkflowPanel({
  workflow,
  step,
  fields,
  busy,
  error,
  conflicted,
  onSubmit,
  onDraftField,
  onRetry,
  onDismiss
}: {
  workflow: EchoWorkflow;
  step: EchoStepDescriptor;
  fields: EchoDraft;
  busy: "restore" | "start" | "continue" | "cancel" | "";
  error: string;
  conflicted: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDraftField: (field: string, value: unknown) => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  if (workflow.status !== "active") {
    const presentation = workflowTerminalPresentation(workflow.status);
    return (
      <div className={`workspace-echo-workflow-terminal ${workflow.status}`} role="status">
        {workflow.status === "completed" ? <Check size={18} /> : <CircleX size={18} />}
        <span><strong>{presentation.title}</strong><small>{presentation.description}</small></span>
        <button className="secondary compact" type="button" onClick={onDismiss}>关闭</button>
      </div>
    );
  }

  const isConfirm = (workflow.state.step || "confirm") === "confirm";
  return (
    <form className="workspace-echo-workflow" onSubmit={onSubmit}>
      {conflicted && <p className="workspace-echo-workflow-conflict" role="status">已有未完成的引导，已恢复到当前步骤。</p>}
      <div className="workspace-echo-workflow-copy">
        <span className="workspace-echo-workflow-step">{workflowStepLabel(workflow)}</span>
        <strong>{step.title}</strong>
        <p>{step.description}</p>
      </div>
      {isConfirm ? (
        <EchoWorkflowSummary workflow={workflow} fields={fields} />
      ) : (
        <EchoWorkflowFields workflow={workflow} step={step} fields={fields} onDraftField={onDraftField} />
      )}
      {error && (
        <div className="workspace-echo-workflow-error" role="alert">
          <AlertCircle size={15} /><span>{error}</span>
          <button className="workspace-echo-workflow-reload" type="button" aria-label="重新载入当前步骤" title="重新载入当前步骤" onClick={onRetry}><RefreshCw size={14} /></button>
        </div>
      )}
      <div className="workspace-echo-workflow-actions">
        <span>{formatWorkflowExpiry(workflow.expiresAt)}</span>
        <button className="primary" type="submit" disabled={Boolean(busy)}>
          {busy === "continue" ? <><LoaderCircle size={15} className="spin" />正在提交</> : isConfirm ? <><Send size={15} />确认</> : <>继续<ChevronRight size={15} /></>}
        </button>
      </div>
    </form>
  );
}

function EchoWorkflowFields({
  workflow,
  step,
  fields,
  onDraftField
}: {
  workflow: EchoWorkflow;
  step: EchoStepDescriptor;
  fields: EchoDraft;
  onDraftField: (field: string, value: unknown) => void;
}) {
  const field = step.field ?? "";
  if (workflow.type === "echo.requirement" && field === "type") {
    return (
      <div className="workspace-echo-workflow-segments" role="group" aria-label="反馈类型">
        {[
          ["requirement", "需求"],
          ["suggestion", "建议"],
          ["problem", "问题反馈"]
        ].map(([value, label]) => (
          <label key={value}><input type="radio" name="type" value={value} checked={(fields.type ?? "requirement") === value} onChange={() => onDraftField("type", value)} /><span>{label}</span></label>
        ))}
      </div>
    );
  }
  if (workflow.type === "echo.publish" && field === "options") {
    return (
      <div className="workspace-echo-workflow-publish-fields">
        <label>
          <span>{step.label}</span>
          <textarea name="options" required maxLength={step.maxLength} value={stringArrayValue(fields.options).join("\n")} onChange={(event) => onDraftField("options", event.target.value.split(/\r?\n/u))} placeholder={step.placeholder} />
        </label>
        <div className="workspace-echo-workflow-policy">
          <label><span>投票方式</span><select name="choiceMode" value={stringField(fields.choiceMode) || "single"} onChange={(event) => onDraftField("choiceMode", event.target.value)}><option value="single">单选</option><option value="multiple">多选</option></select></label>
          <label><span>多选上限</span><input name="maxSelections" type="number" min="1" max="20" value={numberField(fields.maxSelections) || 2} onChange={(event) => onDraftField("maxSelections", Number(event.target.value))} /></label>
          <label><span>截止时间</span><input name="deadline" type="datetime-local" value={dateTimeLocalValue(fields.deadline)} onChange={(event) => onDraftField("deadline", event.target.value)} /></label>
          <label className="workspace-echo-workflow-check"><input name="allowVoteChange" type="checkbox" checked={fields.allowVoteChange !== false} onChange={(event) => onDraftField("allowVoteChange", event.target.checked)} /><span>允许改票</span></label>
          <label className="workspace-echo-workflow-check"><input name="showAggregate" type="checkbox" checked={fields.resultVisibility !== "owner"} onChange={(event) => onDraftField("resultVisibility", event.target.checked ? "aggregate" : "owner")} /><span>展示汇总</span></label>
        </div>
      </div>
    );
  }
  const value = stringField(fields[field]);
  return (
    <div className="workspace-echo-workflow-inputs">
      {workflow.type === "echo.requirement" && field === "title" && (
        <label>
          <span>类型</span>
          <select name="type" value={stringField(fields.type) || "requirement"} onChange={(event) => onDraftField("type", event.target.value)}>
            <option value="requirement">需求</option>
            <option value="suggestion">建议</option>
            <option value="problem">问题反馈</option>
          </select>
        </label>
      )}
      <label>
        <span>{step.label}</span>
        {step.multiline ? (
          <textarea name={field} required maxLength={step.maxLength} value={value} onChange={(event) => onDraftField(field, event.target.value)} placeholder={step.placeholder} autoFocus />
        ) : (
          <input name={field} required maxLength={step.maxLength} value={value} onChange={(event) => onDraftField(field, event.target.value)} placeholder={step.placeholder} autoFocus />
        )}
      </label>
      {workflow.type === "echo.requirement" && field === "expectedResult" && (
        <label><span>相关链接（可选）</span><input name="relatedLink" type="url" maxLength={2_000} value={stringField(fields.relatedLink)} onChange={(event) => onDraftField("relatedLink", event.target.value)} placeholder="https://" /></label>
      )}
    </div>
  );
}

function EchoWorkflowSummary({ workflow, fields }: { workflow: EchoWorkflow; fields: EchoDraft }) {
  const items = workflow.type === "echo.publish"
    ? [
        ["标题", stringField(fields.title)],
        ["说明", stringField(fields.description)],
        ["问题", stringField(fields.question)],
        ["选项", stringArrayValue(fields.options).join("、")]
      ]
    : [
        ["类型", requirementTypeLabel(stringField(fields.type))],
        ["标题", stringField(fields.title)],
        ["详细描述", stringField(fields.detail)],
        ["使用场景", stringField(fields.scenario)],
        ["期望结果", stringField(fields.expectedResult)]
      ];
  return (
    <dl className="workspace-echo-workflow-summary">
      {items.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{isRedactedField(value) ? "已安全保存到当前引导" : value || "已填写"}</dd></div>
      ))}
    </dl>
  );
}

function EchoCommandResult({ result, onDismiss }: { result: Record<string, unknown>; onDismiss: () => void }) {
  const type = stringField(result.type);
  const presentation = commandResultPresentation(result);
  const commands = Array.isArray(result.commands) ? result.commands.filter((item): item is string => typeof item === "string") : [];
  const items = Array.isArray(result.items) ? result.items.filter(isRecord) : [];
  return (
    <div className="workspace-echo-command-result" role="status">
      <span className="workspace-echo-command-result-icon"><ListChecks size={18} /></span>
      <div>
        <strong>{presentation.title}</strong>
        <p>{presentation.description}</p>
        {type === "help" && <div className="workspace-echo-command-list" aria-label="可用命令">{commands.map((command) => <code key={command}>{command}</code>)}</div>}
        {items.length > 0 && (
          <ul className="workspace-echo-command-items">
            {items.slice(0, 20).map((item, index) => <li key={`${stringField(item.publicId)}-${index}`}><strong>{stringField(item.publicId) || `记录 ${index + 1}`}</strong><span>{echoRequirementStateLabel(item)}</span></li>)}
          </ul>
        )}
      </div>
      <button className="secondary compact" type="button" onClick={onDismiss}>完成</button>
    </div>
  );
}

function EchoCommandResultCard({ cardId }: { cardId: string }) {
  const [block, setBlock] = useState<WorkspaceCardBlock | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError("");
    void echoJson<{ card: { block?: WorkspaceCardBlock } }>(`/api/workspace/cards/${encodeURIComponent(cardId)}`)
      .then((response) => {
        if (!cancelled && response.card.block) setBlock(response.card.block);
      })
      .catch((caught) => {
        if (!cancelled) setError(echoInteractionErrorMessage(caught));
      });
    return () => { cancelled = true; };
  }, [cardId, retry]);
  if (block) return <WorkspaceInteractiveCard block={block} />;
  if (error) return <button className="workspace-echo-result-card-error" type="button" onClick={() => setRetry((value) => value + 1)}><AlertCircle size={15} />结果卡片加载失败，点此重试</button>;
  return <p className="workspace-echo-interaction-loading"><LoaderCircle size={16} className="spin" />正在加载结果卡片</p>;
}

async function executeEchoCommand(request: WorkspaceEchoCommandRequest, signal: AbortSignal) {
  const response = await echoJson<{ command: EchoCommandOutcome }>("/api/workspace/interactions/commands", {
    method: "POST",
    signal,
    body: JSON.stringify({
      conversationId: request.conversationId,
      botUserId: request.botUserId,
      source: request.source,
      mentionedBotIds: request.mentionedBotIds,
      clientInvocationId: request.clientInvocationId
    })
  });
  return response.command;
}

async function startEchoWorkflow(
  request: WorkspaceEchoCommandRequest,
  result: Record<string, unknown>,
  signal: AbortSignal,
  callbacks: {
    onWorkflow: (workflow: EchoWorkflow, conflicted: boolean) => void;
    onBusy: (busy: "start" | "") => void;
  }
) {
  callbacks.onBusy("start");
  try {
    const response = await echoJson<{ workflow: EchoWorkflow }>("/api/workspace/workflows", {
      method: "POST",
      signal,
      body: JSON.stringify({
        conversationId: request.conversationId,
        botUserId: request.botUserId,
        type: stringField(result.workflowType),
        version: numberField(result.version) || 1,
        input: isRecord(result.input) ? result.input : {},
        clientInvocationId: echoWorkflowStartInvocationId(request.clientInvocationId)
      })
    });
    callbacks.onWorkflow(response.workflow, false);
  } catch (caught) {
    if (!(caught instanceof EchoInteractionError) || caught.code !== "workflow.active_conflict") throw caught;
    const activeWorkflowId = findActiveWorkflowId(caught.payload);
    if (!activeWorkflowId) throw caught;
    const active = await loadEchoWorkflow(activeWorkflowId, signal);
    callbacks.onWorkflow(active, true);
  } finally {
    callbacks.onBusy("");
  }
}

async function loadEchoWorkflow(workflowId: string, signal?: AbortSignal) {
  const response = await echoJson<{ workflow: EchoWorkflow }>(
    `/api/workspace/workflows/${encodeURIComponent(workflowId)}`,
    signal ? { signal } : undefined
  );
  return response.workflow;
}

function buildWorkflowStepInput(workflow: EchoWorkflow, form: FormData): Record<string, unknown> {
  const step = workflow.state.step || "confirm";
  if (step === "confirm") return {
    confirm: true,
    idempotencyKey: `workflow-${workflow.id}-${workflow.revision}`
  };
  if (workflow.type === "echo.publish" && step === "options") {
    const options = String(form.get("options") ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
    if (options.length < 2) throw new EchoInteractionError("workflow.options_invalid", "至少填写两个投票选项");
    const choiceMode = form.get("choiceMode") === "multiple" ? "multiple" : "single";
    const maxSelections = choiceMode === "multiple" ? Number(form.get("maxSelections") ?? 2) : 1;
    const rawDeadline = String(form.get("deadline") ?? "").trim();
    return {
      options,
      choiceMode,
      minSelections: 1,
      maxSelections: Number.isSafeInteger(maxSelections) && maxSelections > 0 ? Math.min(maxSelections, options.length) : 1,
      allowVoteChange: form.get("allowVoteChange") === "on",
      resultVisibility: form.get("showAggregate") === "on" ? "aggregate" : "owner",
      deliveryPolicy: "all_active_members",
      ...(rawDeadline ? { deadline: new Date(rawDeadline).toISOString() } : {})
    };
  }
  const descriptor = getEchoWorkflowStepDescriptor(workflow);
  const field = descriptor.field ?? step;
  const value = String(form.get(field) ?? "").trim();
  if (!value) throw new EchoInteractionError("workflow.input_required", "请填写当前步骤后继续");
  return {
    [field]: value,
    ...(workflow.type === "echo.requirement" && step === "title" && form.get("type")
      ? { type: String(form.get("type")) }
      : {}),
    ...(workflow.type === "echo.requirement" && step === "expectedResult" && String(form.get("relatedLink") ?? "").trim()
      ? { relatedLink: String(form.get("relatedLink")).trim() }
      : {})
  };
}

async function echoJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, headers: createWorkspaceJsonHeaders(options) });
  const payload = await response.json().catch(() => ({})) as EchoApiErrorPayload & T;
  if (!response.ok) {
    const code = payload.error?.code || `http.${response.status}`;
    throw new EchoInteractionError(code, payload.error?.message || echoErrorCodeMessage(code), payload);
  }
  return payload;
}

function initialWorkflowDraft(commandName: string, result: Record<string, unknown>): EchoDraft {
  const input = isRecord(result.input) ? result.input : {};
  return {
    ...input,
    ...(commandName === "feedback" ? { type: "problem" } : commandName === "need" ? { type: "requirement" } : {})
  };
}

const ECHO_WORKFLOW_DRAFT_STORAGE_PREFIX = "duallane.workspace.echo-workflow-draft:";
const ECHO_WORKFLOW_DRAFT_FIELDS = new Set([
  "type", "title", "detail", "scenario", "expectedResult", "relatedLink",
  "description", "question", "options", "choiceMode", "minSelections", "maxSelections",
  "allowVoteChange", "deadline", "resultVisibility", "deliveryPolicy"
]);

function workflowDraftStorageKey(workflowId: string) {
  return `${ECHO_WORKFLOW_DRAFT_STORAGE_PREFIX}${workflowId}`;
}

function readStoredWorkflowDraft(workflowId: string): EchoDraft {
  if (typeof sessionStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(sessionStorage.getItem(workflowDraftStorageKey(workflowId)) || "{}");
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
      ECHO_WORKFLOW_DRAFT_FIELDS.has(key) && (
        typeof value === "string" || typeof value === "number" || typeof value === "boolean" ||
        (Array.isArray(value) && value.every((item) => typeof item === "string"))
      )
    ));
  } catch {
    return {};
  }
}

function storeWorkflowDraft(workflowId: string, draft: EchoDraft) {
  if (typeof sessionStorage === "undefined") return;
  try {
    const safe = Object.fromEntries(Object.entries(draft).filter(([key, value]) =>
      ECHO_WORKFLOW_DRAFT_FIELDS.has(key) && (
        typeof value === "string" || typeof value === "number" || typeof value === "boolean" ||
        (Array.isArray(value) && value.every((item) => typeof item === "string"))
      )
    ));
    sessionStorage.setItem(workflowDraftStorageKey(workflowId), JSON.stringify(safe));
  } catch {
    // A full or disabled session store must not block the workflow itself.
  }
}

function removeStoredWorkflowDraft(workflowId: string) {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(workflowDraftStorageKey(workflowId));
  } catch {
    // Storage cleanup is best-effort after the server workflow has ended.
  }
}

function findActiveWorkflowId(payload: EchoApiErrorPayload) {
  return payload.error?.details?.activeWorkflowId || payload.error?.activeWorkflowId || payload.error?.workflowId || payload.error?.activeWorkflow?.id || payload.error?.workflow?.id ||
    payload.activeWorkflowId || payload.workflowId || payload.activeWorkflow?.id || payload.workflow?.id || "";
}

function echoInteractionErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
  if (error instanceof EchoInteractionError) return echoErrorCodeMessage(error.code, error.message);
  return error instanceof Error ? error.message : "操作未完成，请稍后重试";
}

function echoErrorCodeMessage(code: string, fallback = "") {
  const messages: Record<string, string> = {
    "permission.denied": "你当前不能执行这个命令。",
    "command.arguments_invalid": "命令参数不完整，请检查后重试。",
    "command.in_progress": "命令仍在处理中，请稍后重试。",
    "command.rate_limited": "操作过于频繁，请稍后再试。",
    "interaction.rate_limited": "操作过于频繁，请稍后再试。",
    "workflow.active_conflict": "已有未完成的引导。",
    "workflow.expired": "这个引导已过期，请重新发起命令。",
    "workflow.not_active": "这个引导已经结束。",
    "workflow.stale_revision": "流程状态已变化，请重新载入。",
    "echo.release_guide_not_found": "该版本还没有可发布的使用指南。",
    "echo.release_version_invalid": "版本号无效，请使用类似 0.15.1 的格式。",
    "echo.release_permission_denied": "只有空间主人可以发布版本更新。",
    "network.error": "网络连接失败，请稍后重试。"
  };
  return messages[code] || fallback || "操作未完成，请稍后重试";
}

function commandResultPresentation(result: Record<string, unknown>) {
  const type = stringField(result.type);
  if (type === "help") return { title: "可用命令", description: "在回声会话中输入以下命令。" };
  if (type === "requirement-list") return { title: "需求列表", description: `找到 ${numberField(result.total)} 条可查看记录。` };
  if (type === "requirement") return { title: stringField(isRecord(result.requirement) ? result.requirement.publicId : "") || "需求详情", description: "已读取当前可查看的需求信息。" };
  if (type === "requirement-transition") return { title: `${stringField(result.publicId)} 已更新`, description: echoRequirementStateLabel(result) };
  if (type === "workflow.cancelled") return { title: "引导已取消", description: "未完成的内容不会提交。" };
  if (type === "cancel") return { title: "没有可取消的引导", description: "发起 /need、/feedback 或 /publish 可以开始新的引导。" };
  if (type === "requirement-submitted") return { title: `${stringField(result.publicId)} 已提交`, description: "回声会在状态变化时通知你。" };
  if (type === "solicitation-published") return { title: `${stringField(result.publicId)} 已发布`, description: "征集正在投递给符合条件的成员。" };
  if (type === "release-published") {
    const version = stringField(result.version);
    const sent = numberField(result.sentCount);
    const recipients = numberField(result.recipientCount);
    const remaining = Math.max(0, recipients - sent - numberField(result.skippedCount));
    return {
      title: `v${version || "?"} 更新已发布`,
      description: remaining > 0
        ? `已投递 ${sent}/${recipients} 位成员，其余将在后台重试。`
        : `已向 ${recipients} 位空间成员播发使用指南。`
    };
  }
  return { title: "命令已完成", description: "回声已处理这次请求。" };
}

function echoRequirementStateLabel(value: Record<string, unknown>) {
  const phase = stringField(value.phase);
  const status = stringField(value.status);
  if (phase === "proposal" && status === "pending_review") return "待处理";
  if (phase === "formal" && status === "planned") return "已采集";
  if (phase === "formal" && status === "in_progress") return "处理中";
  if (phase === "formal" && status === "delivered") return "已实现";
  if (phase === "archived") return stringField(value.archiveOutcome) === "rejected" ? "已驳回" : "已归档";
  return status || phase || "状态已更新";
}

function workflowTerminalPresentation(status: EchoWorkflow["status"]) {
  if (status === "completed") return { title: "引导已完成", description: "内容已经提交给回声。" };
  if (status === "cancelled") return { title: "引导已取消", description: "未完成的内容没有提交。" };
  if (status === "expired") return { title: "引导已过期", description: "请重新输入命令开始新的引导。" };
  return { title: "引导发生冲突", description: "请重新载入或开始新的引导。" };
}

function workflowTitle(type: string) {
  return type === "echo.publish" ? "发布公开征集" : "提交需求与反馈";
}

function workflowStepLabel(workflow: EchoWorkflow) {
  const order = workflow.type === "echo.publish"
    ? ["title", "description", "question", "options", "confirm"]
    : ["type", "title", "detail", "scenario", "expectedResult", "confirm"];
  const index = Math.max(0, order.indexOf(workflow.state.step || "confirm"));
  return `第 ${index + 1} 步，共 ${order.length} 步`;
}

function formatWorkflowExpiry(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "临时引导";
  return `有效至 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date)}`;
}

function dateTimeLocalValue(value: unknown) {
  const date = new Date(stringField(value));
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function requirementTypeLabel(type: string) {
  return type === "problem" ? "问题反馈" : type === "suggestion" ? "建议" : "需求";
}

function isRedactedField(value: string) {
  return value.length === 2 && value.endsWith("…");
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
