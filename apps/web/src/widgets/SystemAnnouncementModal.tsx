import React from "react";
import { ArrowUpRight, Megaphone } from "lucide-react";
import { useWorkspaceStore } from "@/entities/workspace/store";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui";

function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}_b_${idx++}`} className="font-semibold text-dl-text-primary">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code
          key={`${keyPrefix}_c_${idx++}`}
          className="rounded bg-dl-surface-subtle px-1.5 py-0.5 font-mono text-[12.5px] text-dl-text-primary"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("[")) {
      const m = token.match(/^\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)]+)\)$/);
      if (m) {
        nodes.push(
          <a
            key={`${keyPrefix}_a_${idx++}`}
            href={m[2]}
            target={m[2].startsWith("http") ? "_blank" : undefined}
            rel={m[2].startsWith("http") ? "noopener noreferrer" : undefined}
            className="font-medium text-dl-lane-shared underline underline-offset-2"
          >
            {m[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function AnnouncementBodyMarkdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const elements: React.ReactNode[] = [];
  let listBuffer: string[] = [];

  const flushList = (keyIdx: number) => {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];
    elements.push(
      <ul key={`ul_${keyIdx}`} className="space-y-1.5 pl-1">
        {items.map((item, i) => (
          <li key={`li_${i}`} className="flex items-start gap-2 text-[13.5px] leading-[1.65] text-dl-text-secondary">
            <span className="mt-[8px] size-1.5 shrink-0 rounded-full bg-dl-lane-shared/75" />
            <span className="min-w-0 flex-1">{renderInlineMarkdown(item, `li_${keyIdx}_${i}`)}</span>
          </li>
        ))}
      </ul>
    );
  };

  lines.forEach((rawLine, i) => {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushList(i);
      return;
    }
    const bulletMatch = trimmed.match(/^(?:[-*•])\s+(.+)$/);
    if (bulletMatch) {
      listBuffer.push(bulletMatch[1]);
      return;
    }
    flushList(i);
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      elements.push(
        <div
          key={`h_${i}`}
          className="pt-1 text-[14px] font-bold tracking-tight text-dl-text-primary"
        >
          {renderInlineMarkdown(headingMatch[2], `h_${i}`)}
        </div>
      );
      return;
    }
    elements.push(
      <p key={`p_${i}`} className="text-[14px] leading-[1.68] text-dl-text-secondary">
        {renderInlineMarkdown(trimmed, `p_${i}`)}
      </p>
    );
  });
  flushList(lines.length);

  return <div className="space-y-2.5">{elements}</div>;
}

export function SystemAnnouncementModal() {
  const {
    authStatus,
    systemAnnouncement,
    dismissedAnnouncementKey,
    dismissSystemAnnouncement,
  } = useWorkspaceStore();

  if (authStatus !== "authenticated" || !systemAnnouncement) {
    return null;
  }

  const currentKey = `${systemAnnouncement.id}:${systemAnnouncement.updatedAt || ""}`;
  const isOpen =
    Boolean(systemAnnouncement.enabled) &&
    systemAnnouncement.shouldShow !== false &&
    dismissedAnnouncementKey !== currentKey;

  if (!isOpen) {
    return null;
  }

  const ctaLabel = systemAnnouncement.ctaLabel?.trim() || "";
  const ctaUrl = systemAnnouncement.ctaUrl?.trim() || "";
  const hasCta = Boolean(ctaLabel && ctaUrl);

  const handleCtaClick = () => {
    if (ctaUrl) {
      if (ctaUrl.startsWith("/")) {
        window.location.assign(ctaUrl);
      } else {
        window.open(ctaUrl, "_blank", "noopener,noreferrer");
      }
    }
    void dismissSystemAnnouncement();
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          void dismissSystemAnnouncement();
        }
      }}
    >
      <DialogContent
        size="sm"
        data-testid="system-announcement-modal"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-b-0 pb-2 pt-5">
          <div className="mb-2.5 flex items-center gap-2">
            <span className="inline-flex size-8 items-center justify-center rounded-xl bg-dl-lane-shared/12 text-dl-lane-shared">
              <Megaphone className="size-4" strokeWidth={2} />
            </span>
            {systemAnnouncement.badge ? (
              <span className="inline-flex items-center rounded-full bg-dl-lane-shared/12 px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.01em] text-dl-lane-shared">
                {systemAnnouncement.badge}
              </span>
            ) : (
              <span className="text-[11px] font-semibold tracking-[0.02em] text-dl-text-tertiary">
                空间通告
              </span>
            )}
          </div>
          <DialogTitle className="text-[19px] font-bold leading-snug tracking-[-0.02em] text-dl-text-primary">
            {systemAnnouncement.title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            空间系统通告
          </DialogDescription>
        </DialogHeader>

        <div className="dl-scroll max-h-[52vh] overflow-y-auto px-6 max-narrow:px-4 pb-5 pt-1">
          <AnnouncementBodyMarkdown content={systemAnnouncement.content} />
        </div>

        <DialogFooter className="bg-dl-surface-subtle/40 px-6 max-narrow:px-4 py-3.5">
          <Button
            type="button"
            variant={hasCta ? "secondary" : "primary"}
            size="sm"
            onClick={() => void dismissSystemAnnouncement()}
          >
            我知道了
          </Button>
          {hasCta && (
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="gap-1.5"
              onClick={handleCtaClick}
            >
              <span>{ctaLabel}</span>
              <ArrowUpRight className="size-3.5 shrink-0" strokeWidth={2} />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
