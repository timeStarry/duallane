import React, { useEffect, useRef, useState } from "react";
import { Download, Heart, Minus, Plus } from "lucide-react";
import { useEmoteStore } from "@/entities/emote/store";
import { useLaneStore } from "@/entities/lane/store";
import { useWorkspaceStore } from "@/entities/workspace/store";
import { cn } from "@/shared/lib/cn";
import { triggerBrowserDownload } from "@/shared/lib/download";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, IconButton } from "@/shared/ui";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

function clampZoom(val: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(val * 100) / 100));
}

export function MediaLightbox() {
  const {
    lightboxOpen,
    lightboxItems,
    lightboxIndex,
    closeLightbox,
    setLightboxIndex,
  } = useLaneStore();
  const { jumpToMessage, isPreviewMode } = useWorkspaceStore();

  const current = lightboxItems[lightboxIndex];
  const itemKey = `${lightboxOpen ? "open" : "closed"}:${lightboxIndex}:${current?.id || ""}`;

  const [zoomState, setZoomState] = useState<{
    key: string;
    zoom: number;
    pan: { x: number; y: number };
    dragging: boolean;
  }>({
    key: itemKey,
    zoom: 1,
    pan: { x: 0, y: 0 },
    dragging: false,
  });

  // Reset zoom & pan cleanly whenever item changes without useEffect cascading render
  const effectiveZoom = zoomState.key === itemKey ? zoomState.zoom : 1;
  const effectivePan = zoomState.key === itemKey ? zoomState.pan : { x: 0, y: 0 };
  const isDragging = zoomState.key === itemKey ? zoomState.dragging : false;

  const dragOriginRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originPanX: number;
    originPanY: number;
  } | null>(null);

  const applyZoom = (nextZoomRaw: number) => {
    const nextZoom = clampZoom(nextZoomRaw);
    setZoomState((prev) => ({
      key: itemKey,
      zoom: nextZoom,
      pan: nextZoom <= 1 ? { x: 0, y: 0 } : prev.key === itemKey ? prev.pan : { x: 0, y: 0 },
      dragging: false,
    }));
  };

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && lightboxIndex > 0) {
        setLightboxIndex(lightboxIndex - 1);
      } else if (e.key === "ArrowRight" && lightboxIndex < lightboxItems.length - 1) {
        setLightboxIndex(lightboxIndex + 1);
      } else if (e.key === "+" || e.key === "=") {
        applyZoom(effectiveZoom + 0.25);
      } else if (e.key === "-") {
        applyZoom(effectiveZoom - 0.25);
      } else if (e.key === "0") {
        setZoomState({ key: itemKey, zoom: 1, pan: { x: 0, y: 0 }, dragging: false });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <Dialog
      open={lightboxOpen && Boolean(current)}
      onOpenChange={(open) => {
        if (!open) closeLightbox();
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <span className="truncate">{current?.fileName || "媒体预览"}</span>
          </DialogTitle>
        </DialogHeader>
        {current && (
          <div className="space-y-3.5 p-6 max-narrow:p-3.5 pt-3.5">
            <div
              data-testid="lightbox-viewport"
              onWheel={(e) => {
                e.preventDefault();
                const step = e.deltaY < 0 ? 0.25 : -0.25;
                applyZoom(effectiveZoom + step);
              }}
              onDoubleClick={() => {
                if (Math.abs(effectiveZoom - 1) < 0.05) {
                  setZoomState({ key: itemKey, zoom: 2, pan: { x: 0, y: 0 }, dragging: false });
                } else {
                  setZoomState({ key: itemKey, zoom: 1, pan: { x: 0, y: 0 }, dragging: false });
                }
              }}
              onPointerDown={(e) => {
                if (effectiveZoom <= 1 || e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture?.(e.pointerId);
                dragOriginRef.current = {
                  pointerId: e.pointerId,
                  startX: e.clientX,
                  startY: e.clientY,
                  originPanX: effectivePan.x,
                  originPanY: effectivePan.y,
                };
                setZoomState({
                  key: itemKey,
                  zoom: effectiveZoom,
                  pan: effectivePan,
                  dragging: true,
                });
              }}
              onPointerMove={(e) => {
                const orig = dragOriginRef.current;
                if (!orig || orig.pointerId !== e.pointerId || effectiveZoom <= 1) return;
                const nextPan = {
                  x: orig.originPanX + (e.clientX - orig.startX),
                  y: orig.originPanY + (e.clientY - orig.startY),
                };
                setZoomState({
                  key: itemKey,
                  zoom: effectiveZoom,
                  pan: nextPan,
                  dragging: true,
                });
              }}
              onPointerUp={(e) => {
                if (dragOriginRef.current?.pointerId === e.pointerId) {
                  dragOriginRef.current = null;
                  setZoomState((prev) => ({ ...prev, dragging: false }));
                }
              }}
              onPointerCancel={() => {
                dragOriginRef.current = null;
                setZoomState((prev) => ({ ...prev, dragging: false }));
              }}
              className={cn(
                "relative flex h-[58vh] max-h-[62vh] items-center justify-center overflow-hidden rounded-2xl bg-black/25 p-2 select-none",
                effectiveZoom > 1
                  ? isDragging
                    ? "cursor-grabbing"
                    : "cursor-grab"
                  : "cursor-zoom-in"
              )}
            >
              <img
                src={current.url}
                alt={current.fileName}
                draggable={false}
                style={{
                  transform: `translate3d(${effectivePan.x}px, ${effectivePan.y}px, 0) scale(${effectiveZoom})`,
                  transition: isDragging ? "none" : "transform 140ms ease-out",
                }}
                className="max-h-[54vh] max-w-full rounded-xl object-contain will-change-transform"
              />

              {/* Floating Glass Zoom Controls */}
              <div className="dl-glass-pill absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full border border-dl-border-hairline px-2 py-1 shadow-md">
                <IconButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  label="缩小图片"
                  disabled={effectiveZoom <= MIN_ZOOM}
                  className="size-6 rounded-full"
                  onClick={() => applyZoom(effectiveZoom - 0.25)}
                >
                  <Minus className="size-3.5" strokeWidth={2} />
                </IconButton>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="重置 1:1 比例"
                  className="h-6 rounded-full px-2 font-mono text-[11px] font-semibold tabular-nums"
                  onClick={() =>
                    setZoomState({ key: itemKey, zoom: 1, pan: { x: 0, y: 0 }, dragging: false })
                  }
                >
                  {effectiveZoom === 1 ? "1:1" : `${Math.round(effectiveZoom * 100)}%`}
                </Button>
                <IconButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  label="放大图片"
                  disabled={effectiveZoom >= MAX_ZOOM}
                  className="size-6 rounded-full"
                  onClick={() => applyZoom(effectiveZoom + 0.25)}
                >
                  <Plus className="size-3.5" strokeWidth={2} />
                </IconButton>
              </div>
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
                {current.sourceMessageId && current.id && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="gap-1.5"
                    onClick={() =>
                      void useEmoteStore
                        .getState()
                        .favoriteFromMessage(
                          { messageId: current.sourceMessageId!, attachmentId: current.id },
                          undefined,
                          isPreviewMode
                        )
                    }
                  >
                    <Heart className="size-3.5" strokeWidth={1.9} />
                    收藏为贴纸
                  </Button>
                )}
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
