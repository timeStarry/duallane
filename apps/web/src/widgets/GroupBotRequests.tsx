import { Bot, Check, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  apiV1,
  type ConversationBotRequest,
  type ConversationBotRequestsResponse,
} from "@/shared/lib/api-v1";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui";
import { useWorkspaceStore } from "@/entities/workspace/store";

export interface GroupBotRequestsProps {
  conversationId: string;
  previewMode?: boolean;
}

type LoadState = {
  conversationId: string;
  reloadRevision: number;
  status: "loading" | "ready" | "error";
  canManage: boolean;
  requests: ConversationBotRequest[];
  hasMore: boolean;
  error: string;
};

const initialLoadState: LoadState = {
  conversationId: "",
  reloadRevision: -1,
  status: "loading",
  canManage: false,
  requests: [],
  hasMore: false,
  error: "",
};

/** Prevent a deferred response for a previous group from entering the new group view. */
export function shouldApplyGroupBotRequests(
  requestConversationId: string,
  activeConversationId: string,
  requestRevision: number,
  activeRevision: number
): boolean {
  return (
    requestConversationId !== "" &&
    requestConversationId === activeConversationId &&
    requestRevision === activeRevision
  );
}

function normalizeResponse(response: ConversationBotRequestsResponse): Pick<
  LoadState,
  "canManage" | "requests" | "hasMore"
> {
  return {
    canManage: response.canManage === true,
    requests: Array.isArray(response.requests)
      ? response.requests.filter((request) => request.status === "pending")
      : [],
    hasMore: response.hasMore === true,
  };
}

export function applyGroupBotRequestsResponse(
  response: ConversationBotRequestsResponse,
  requestConversationId: string,
  activeConversationId: string,
  requestRevision: number,
  activeRevision: number,
  reloadRevision = 0
): LoadState | null {
  if (
    !shouldApplyGroupBotRequests(
      requestConversationId,
      activeConversationId,
      requestRevision,
      activeRevision
    )
  ) {
    return null;
  }
  return {
    conversationId: requestConversationId,
    reloadRevision,
    status: "ready",
    ...normalizeResponse(response),
    error: "",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "暂时无法加载机器人入群请求";
}

function contextSummary(request: ConversationBotRequest): string {
  if (!request.allowContext) return "仅读取触发消息";
  return request.maxMessages === null
    ? "可请求读取本群历史（上限沿用 Bot 设置）"
    : `可请求读取本群最近 ${request.maxMessages} 条历史`;
}

function decisionNotice(request: ConversationBotRequest, status: string): string {
  if (status === "active") return `已批准「${request.name}」加入当前群聊`;
  if (status === "rejected") return `已拒绝「${request.name}」的入群请求`;
  if (status === "pending") return `「${request.name}」仍在等待群管理员批准`;
  return `「${request.name}」的请求状态已更新`;
}

export function GroupBotRequests({ conversationId, previewMode = false }: GroupBotRequestsProps) {
  const bootstrapWorkspace = useWorkspaceStore((state) => state.bootstrapWorkspace);
  const [reloadRevision, setReloadRevision] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>(initialLoadState);
  const [busyState, setBusyState] = useState({ conversationId: "", key: "" });
  const [noticeState, setNoticeState] = useState({ conversationId: "", message: "" });
  const [actionErrorState, setActionErrorState] = useState({ conversationId: "", message: "" });
  const requestRevisionRef = useRef(0);
  const activeConversationRef = useRef(conversationId);
  const busyKey = busyState.conversationId === conversationId ? busyState.key : "";
  const notice = noticeState.conversationId === conversationId ? noticeState.message : "";
  const actionError =
    actionErrorState.conversationId === conversationId ? actionErrorState.message : "";

  useEffect(() => {
    const requestRevision = requestRevisionRef.current + 1;
    requestRevisionRef.current = requestRevision;
    activeConversationRef.current = conversationId;
    let cancelled = false;

    if (previewMode || !conversationId) {
      return () => {
        cancelled = true;
      };
    }

    void apiV1
      .listConversationBotRequests(conversationId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        const nextState = applyGroupBotRequestsResponse(
          response,
          conversationId,
          activeConversationRef.current,
          requestRevision,
          requestRevisionRef.current,
          reloadRevision
        );
        if (nextState) setLoadState(nextState);
      })
      .catch((error: unknown) => {
        if (
          cancelled ||
          !shouldApplyGroupBotRequests(
            conversationId,
            activeConversationRef.current,
            requestRevision,
            requestRevisionRef.current
          )
        ) {
          return;
        }
        setLoadState({
          conversationId,
          reloadRevision,
          status: "error",
          canManage: false,
          requests: [],
          hasMore: false,
          error: errorMessage(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, previewMode, reloadRevision]);

  if (previewMode) return null;
  const currentLoad =
    loadState.conversationId === conversationId && loadState.reloadRevision === reloadRevision;
  if (!currentLoad || loadState.status === "loading") {
    return (
      <section
        aria-label="机器人入群请求"
        aria-busy="true"
        data-testid="group-bot-requests-loading"
        className="space-y-2 border-t border-dl-border-hairline pt-3"
      >
        <div className="h-3 w-32 animate-pulse rounded bg-dl-surface-subtle" />
        <div className="h-9 animate-pulse rounded-xl bg-dl-surface-subtle/70" />
      </section>
    );
  }
  if (loadState.status === "error") {
    return (
      <section
        aria-label="机器人入群请求"
        data-testid="group-bot-requests-error"
        className="space-y-2 border-t border-dl-border-hairline pt-3"
      >
        <p role="alert" className="text-xs leading-5 text-dl-danger">
          {loadState.error}
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="gap-1.5 text-xs"
          onClick={() => setReloadRevision((revision) => revision + 1)}
        >
          <RefreshCw className="size-3.5" strokeWidth={1.9} />
          重试加载
        </Button>
      </section>
    );
  }
  if (!loadState.canManage) return null;

  const handleDecision = async (request: ConversationBotRequest, status: "active" | "rejected") => {
    const key = `${request.botId}:${status}`;
    if (busyKey) return;
    const requestRevision = requestRevisionRef.current;
    setBusyState({ conversationId, key });
    setNoticeState({ conversationId: "", message: "" });
    setActionErrorState({ conversationId: "", message: "" });
    try {
      const response = await apiV1.updateBotGroupPolicy(request.botId, conversationId, { status });
      if (
        !shouldApplyGroupBotRequests(
          conversationId,
          activeConversationRef.current,
          requestRevision,
          requestRevisionRef.current
        )
      ) {
        return;
      }
      const returnedStatus = response.policy?.status || "";
      if (!["active", "rejected", "pending"].includes(returnedStatus)) {
        throw new Error("审批响应无效，请重试");
      }
      setNoticeState({ conversationId, message: decisionNotice(request, returnedStatus) });
      await bootstrapWorkspace().catch(() => undefined);
      if (
        shouldApplyGroupBotRequests(
          conversationId,
          activeConversationRef.current,
          requestRevision,
          requestRevisionRef.current
        )
      ) {
        setReloadRevision((revision) => revision + 1);
      }
    } catch (error: unknown) {
      if (
        shouldApplyGroupBotRequests(
          conversationId,
          activeConversationRef.current,
          requestRevision,
          requestRevisionRef.current
        )
      ) {
        setActionErrorState({ conversationId, message: errorMessage(error) });
      }
    } finally {
      if (
        shouldApplyGroupBotRequests(
          conversationId,
          activeConversationRef.current,
          requestRevision,
          requestRevisionRef.current
        )
      ) {
        setBusyState({ conversationId: "", key: "" });
      }
    }
  };

  return (
    <section
      aria-labelledby="group-bot-requests-heading"
      data-testid="group-bot-requests"
      className="space-y-3 border-t border-dl-border-hairline pt-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="size-3.5 shrink-0 text-dl-lane-shared" strokeWidth={1.9} />
            <h3 id="group-bot-requests-heading" className="text-xs font-semibold text-dl-text-primary">
              机器人入群请求
            </h3>
          </div>
          <p className="text-[11px] leading-5 text-dl-text-tertiary">
            批准后仅能在当前群内使用，不会授予机器人私聊权限。
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-dl-lane-shared/12 px-1.5 py-0.5 text-[10px] font-medium text-dl-lane-shared">
          群内管理
        </span>
      </div>

      {loadState.requests.length === 0 ? (
        <div className="rounded-xl border border-dashed border-dl-border-hairline px-3 py-3 text-center text-xs text-dl-text-tertiary">
          暂无待处理的机器人入群请求
        </div>
      ) : (
        <div className="space-y-2" role="list" aria-label="待处理的机器人入群请求">
          {loadState.requests.map((request) => {
            const activeKey = `${request.botId}:active`;
            const rejectedKey = `${request.botId}:rejected`;
            return (
              <div
                key={`${request.botId}:${request.status}`}
                role="listitem"
                className="space-y-2 rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/45 p-3"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-dl-lane-shared/14 text-dl-lane-shared">
                    <Bot className="size-4" strokeWidth={1.8} aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-dl-text-primary">
                      {request.name || "未命名机器人"}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-5 text-dl-text-tertiary">
                      {contextSummary(request)}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className={cn("gap-1.5 text-xs text-dl-text-secondary", busyKey === rejectedKey && "text-dl-danger")}
                    busy={busyKey === rejectedKey}
                    disabled={Boolean(busyKey)}
                    onClick={() => void handleDecision(request, "rejected")}
                  >
                    <X className="size-3.5" strokeWidth={1.9} />
                    拒绝
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    className="gap-1.5 text-xs"
                    busy={busyKey === activeKey}
                    disabled={Boolean(busyKey)}
                    onClick={() => void handleDecision(request, "active")}
                  >
                    <Check className="size-3.5" strokeWidth={2} />
                    批准
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {loadState.hasMore && (
        <p className="text-[11px] leading-5 text-dl-text-tertiary">还有更多请求，刷新后继续查看。</p>
      )}
      {notice && (
        <p role="status" aria-live="polite" className="text-xs text-dl-success">
          {notice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-xs leading-5 text-dl-danger">
          {actionError}
        </p>
      )}
    </section>
  );
}
