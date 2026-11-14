import React, { useEffect } from "react";
import { Download } from "lucide-react";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { triggerBrowserDownload } from "@/shared/lib/download";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@/shared/ui";

export function MediaLightbox() {
  const {
    lightboxOpen,
    lightboxItems,
    lightboxIndex,
    closeLightbox,
    setLightboxIndex,
  } = useLaneStore();
  const { jumpToMessage } = useWorkspaceStore();

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && lightboxIndex > 0) {
        setLightboxIndex(lightboxIndex - 1);
      } else if (e.key === "ArrowRight" && lightboxIndex < lightboxItems.length - 1) {
        setLightboxIndex(lightboxIndex + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightboxOpen, lightboxIndex, lightboxItems.length, setLightboxIndex]);

  const current = lightboxItems[lightboxIndex];

  return (
    <Dialog
      open={lightboxOpen && Boolean(current)}
      onOpenChange={(open) => {
        if (!open) closeLightbox();
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{current?.fileName || "媒体预览"}</DialogTitle>
        </DialogHeader>
        {current && (
          <div className="space-y-4 p-6 max-narrow:p-3.5 pt-4">
            <div className="flex max-h-[60vh] items-center justify-center overflow-hidden rounded-2xl bg-black/20 p-2">
              <img
                src={current.url}
                alt={current.fileName}
                className="max-h-[56vh] max-w-full rounded-xl object-contain"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={lightboxIndex <= 0}
                  onClick={() => setLightboxIndex(lightboxIndex - 1)}
                >
                  ← 上一张
                </Button>
                <span className="text-xs text-dl-text-secondary tabular-nums">
                  {lightboxIndex + 1} / {lightboxItems.length}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={lightboxIndex >= lightboxItems.length - 1}
                  onClick={() => setLightboxIndex(lightboxIndex + 1)}
                >
                  下一张 →
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="gap-1.5"
                  onClick={() =>
                    triggerBrowserDownload(current.downloadUrl || current.url, current.fileName)
                  }
                >
                  <Download className="size-3.5" strokeWidth={1.9} />
                  下载文件
                </Button>
                {current.conversationId && current.sourceMessageId && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      jumpToMessage(current.conversationId!, current.sourceMessageId!);
                      closeLightbox();
                    }}
                  >
                    在对话中定位
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
