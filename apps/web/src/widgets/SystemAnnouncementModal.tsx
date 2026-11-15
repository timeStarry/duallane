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
          <div className="whitespace-pre-line text-[14px] leading-[1.68] text-dl-text-secondary">
            {systemAnnouncement.content}
          </div>
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
