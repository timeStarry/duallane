import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  FolderPlus,
  Heart,
  ImagePlus,
  Layers,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings2,
  Share2,
  Smile,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import {
  emotePacks,
  findFirstImageEmoteKey,
  getEmoteInsertText,
  getReactionEmote,
  isSingleImageEmoteText,
  ReactionEmoteGlyph,
  renderMessageParts,
  visibleEmotePacks,
  type EmoteItem,
  type EmotePack,
} from "@/emotes";
import { CachedEmoteImage } from "@/emote-image-cache";
import { getRecentEmojiIds, recordRecentEmojiUse } from "@/recent-emojis";
import {
  resolveCustomEmoteSrc,
  useEmoteStore,
  type StudioTab,
} from "@/entities/emote/store";
import {
  useWorkspaceStore,
  type V1Message,
  type V1MessageBlock,
} from "@/entities/workspace/store";
import type {
  CustomEmoteDTO,
  EmoteCollectionShareSummaryDTO,
} from "@/shared/lib/api-v1";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Select,
  Switch,
} from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

const CUSTOM_SHORTCODE_RE = /^custom:([a-f0-9-]{8,64})$/i;

const QUICK_REACTION_ITEMS: Array<{ key: string; glyph: string; label: string }> = [
  { key: "emoji:thumbsup", glyph: "👍", label: "赞" },
  { key: "emoji:heart", glyph: "❤️", label: "爱心" },
  { key: "emoji:joy", glyph: "😂", label: "笑哭" },
  { key: "emoji:tada", glyph: "🎉", label: "庆祝" },
  { key: "emoji:fire", glyph: "🔥", label: "火热" },
  { key: "emoji:eyes", glyph: "👀", label: "围观" },
];

const UNICODE_EMOJI_PACK = emotePacks.find((p) => p.id === "emoji");
const UNICODE_EMOJI_IDS = (UNICODE_EMOJI_PACK?.items || []).map((i) => i.id);

function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function copyShareUrlSafe(sharePath: string): Promise<boolean> {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://duallane.tsio.top";
  const url = sharePath.startsWith("http") ? sharePath : `${origin}${sharePath}`;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const el = document.createElement("textarea");
    el.value = url;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    return true;
  } catch {
    return false;
  }
}

export function extractFavoritableSource(msg: V1Message): {
  customEmoteId?: string;
  emoteKey?: string;
  attachmentId?: string;
} | null {
  if (msg.blocks && msg.blocks.length > 0) {
    for (const b of msg.blocks) {
      if (b.type === "emoji") {
        const m = CUSTOM_SHORTCODE_RE.exec(b.shortcode);
        if (m?.[1]) return { customEmoteId: m[1] };
      }
    }
    const textCombined = msg.blocks
      .filter((b): b is Extract<V1MessageBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const keyFromBlocks = findFirstImageEmoteKey(textCombined);
    if (keyFromBlocks) return { emoteKey: keyFromBlocks };
  }
  const keyFromPlain = findFirstImageEmoteKey(msg.plainText || "");
  if (keyFromPlain) return { emoteKey: keyFromPlain };

  const imgAtt = msg.attachments?.find(
    (a) =>
      a.id &&
      (a.mimeType === "image/png" ||
        a.mimeType === "image/jpeg" ||
        a.mimeType === "image/webp" ||
        a.mimeType === "image/gif" ||
        a.mimeType === "image/bmp")
  );
  if (imgAtt) return { attachmentId: imgAtt.id };
  return null;
}

export function isJumboStickerMessage(msg: V1Message): boolean {
  if (msg.replyToId || (msg.attachments && msg.attachments.length > 0) || msg.card) {
    return false;
  }
  if (msg.blocks && msg.blocks.length > 0) {
    if (msg.blocks.length === 1 && msg.blocks[0].type === "emoji") {
      return CUSTOM_SHORTCODE_RE.test(msg.blocks[0].shortcode);
    }
    if (msg.blocks.length === 1 && msg.blocks[0].type === "text") {
      return isSingleImageEmoteText(msg.blocks[0].text);
    }
    return false;
  }
  return isSingleImageEmoteText(msg.plainText || "");
}

export function isEmotePackShareOnlyMessage(msg: V1Message): boolean {
  if (msg.replyToId || (msg.attachments && msg.attachments.length > 0) || msg.card) {
    return false;
  }
  return Boolean(msg.blocks && msg.blocks.length === 1 && msg.blocks[0].type === "emote_collection");
}

export function ReactionKeyDisplay({ emoteKey }: { emoteKey: string }) {
  if (emoteKey.includes(":")) {
    const resolved = getReactionEmote(emoteKey);
    if (resolved) {
      return (
        <span className="dl-reaction-glyph inline-flex items-center justify-center">
          <ReactionEmoteGlyph emoteKey={emoteKey} />
        </span>
      );
    }
  }
  return <span className="leading-none">{emoteKey}</span>;
}

export function ReactionPickerPopoverContent({
  onSelectReaction,
}: {
  onSelectReaction: (emoteKey: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const settings = useEmoteStore((s) => s.settings);
  const [selectedPackId, setSelectedPackId] = useState<EmotePack["id"]>("bili");

  const enabledPacks = visibleEmotePacks.filter(
    (p) => settings.enabledPackIds.includes(p.id) || p.id === "emoji"
  );
  const activePack =
    enabledPacks.find((p) => p.id === selectedPackId) || enabledPacks[0] || visibleEmotePacks[0];

  return (
    <div className={cn("space-y-1.5", expanded ? "w-68" : "w-auto")}>
      <div className="flex items-center gap-0.5">
        {QUICK_REACTION_ITEMS.map((r) => (
          <Button
            key={r.key}
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`回应 ${r.label}`}
            className="h-7 w-7 rounded-full p-0 text-sm"
            onClick={() => onSelectReaction(r.key)}
          >
            {r.glyph}
          </Button>
        ))}
        <IconButton
          label={expanded ? "收起更多表情回应" : "更多表情包回应"}
          size="sm"
          variant="ghost"
          className="size-7 rounded-full"
          onClick={() => setExpanded((v) => !v)}
        >
          <Plus className={cn("size-3.5 transition-transform", expanded && "rotate-45")} />
        </IconButton>
      </div>

      {expanded && activePack && (
        <div className="border-t border-dl-border-hairline pt-1.5 space-y-1.5">
          <div className="dl-scroll flex items-center gap-1 overflow-x-auto pb-0.5">
            {enabledPacks.map((pack) => (
              <Button
                key={pack.id}
                type="button"
                size="sm"
                variant={pack.id === activePack.id ? "primary" : "ghost"}
                className="h-6 shrink-0 rounded-lg px-2 text-[11px]"
                onClick={() => setSelectedPackId(pack.id)}
              >
                {pack.label}
              </Button>
            ))}
          </div>
          <div className="dl-scroll grid max-h-44 grid-cols-7 gap-1 overflow-y-auto p-0.5">
            {activePack.items.map((item) => (
              <Button
                key={item.id}
                type="button"
                size="sm"
                variant="ghost"
                title={item.label}
                aria-label={`回应 ${item.label}`}
                className="h-8 w-8 rounded-lg p-0"
                onClick={() => onSelectReaction(`${activePack.id}:${item.id}`)}
              >
                {item.kind === "unicode" ? (
                  <span className="text-base leading-none">{item.value}</span>
                ) : (
                  <CachedEmoteImage
                    src={item.src}
                    alt={item.label}
                    className="size-5 object-contain"
                  />
                )}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmotePackShareCard({
  shareId,
  share,
}: {
  shareId: string;
  share?: EmoteCollectionShareSummaryDTO;
}) {
  const isPreviewMode = useWorkspaceStore((s) => s.isPreviewMode);
  const openSharedPack = useEmoteStore((s) => s.openSharedPack);

  if (share?.revokedAt) {
    return (
      <div className="flex items-center gap-2.5 rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/65 px-3.5 py-2.5 text-xs text-dl-text-tertiary">
        <Layers className="size-4 shrink-0" />
        <span>该表情包分享已被撤回</span>
      </div>
    );
  }

  const covers = share?.covers?.slice(0, 4) || [];

  return (
    <div
      data-testid="emote-pack-share-card"
      className="dl-glass-elevated w-64 max-w-full rounded-2xl border border-dl-border-hairline p-3 text-dl-text-primary shadow-xs space-y-2.5"
    >
      <div className="flex items-center gap-3">
        <div className="grid size-13 shrink-0 grid-cols-2 gap-1 rounded-xl bg-dl-surface-subtle/80 p-1.5">
          {covers.length > 0 ? (
            covers.map((c) => (
              <img
                key={c.id}
                src={c.src}
                alt={c.label}
                className="size-full object-contain"
                loading="lazy"
              />
            ))
          ) : (
            <div className="col-span-2 row-span-2 flex items-center justify-center text-dl-lane-shared">
              <Sparkles className="size-5" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-dl-text-primary">
            {share?.name || "分享的表情包"}
          </div>
          <div className="truncate text-[11px] text-dl-text-secondary">
            {share ? `共 ${share.itemCount} 张 · ${share.originalCreator.displayName}` : "点击预览整套贴纸"}
          </div>
          {share?.sharedBy?.displayName && (
            <div className="truncate text-[10px] text-dl-text-tertiary">
              由 {share.sharedBy.displayName} 分享
            </div>
          )}
        </div>
      </div>

      <Button
        type="button"
        size="sm"
        variant="primary"
        className="w-full gap-1.5 rounded-xl"
        onClick={() => void openSharedPack(share?.id || shareId, isPreviewMode)}
      >
        <Sparkles className="size-3.5" />
        查看并添加表情包
      </Button>
    </div>
  );
}

export function MessageRichContent({
  msg,
  jumbo = false,
}: {
  msg: V1Message;
  jumbo?: boolean;
}) {
  const isPreviewMode = useWorkspaceStore((s) => s.isPreviewMode);
  const { library, favoriteFromMessage, openStudio } = useEmoteStore();

  if (jumbo) {
    const firstBlock = msg.blocks?.[0];
    if (firstBlock?.type === "emoji") {
      const customId = CUSTOM_SHORTCODE_RE.exec(firstBlock.shortcode)?.[1];
      if (customId) {
        const previewKnown = library.emotes.find((e) => e.id === customId);
        const src = previewKnown
          ? resolveCustomEmoteSrc(previewKnown)
          : `/api/workspace/emotes/${encodeURIComponent(customId)}/content`;

        return (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label="查看或收藏贴纸"
                data-testid="jumbo-custom-sticker"
                className="h-auto w-auto rounded-2xl p-1 hover:bg-dl-surface-subtle/50"
              >
                <img
                  src={src}
                  alt={previewKnown?.label || "贴纸"}
                  className="h-32 w-32 object-contain select-none"
                  loading="lazy"
                />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="center" className="w-52 p-2 space-y-1.5">
              <div className="px-1.5 py-0.5 text-[11px] font-semibold text-dl-text-secondary">
                贴纸快捷操作
              </div>
              <Button
                type="button"
                size="sm"
                variant="primary"
                className="w-full justify-start gap-2"
                onClick={() =>
                  void favoriteFromMessage({ messageId: msg.id, customEmoteId: customId }, undefined, isPreviewMode)
                }
              >
                <Heart className="size-3.5" />
                收藏到我的贴纸
              </Button>
              {library.collections
                .filter((c) => !c.sourceSubscription?.readOnly)
                .slice(0, 4)
                .map((pack) => (
                  <Button
                    key={pack.id}
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-full justify-between text-xs"
                    onClick={() =>
                      void favoriteFromMessage(
                        { messageId: msg.id, customEmoteId: customId },
                        pack.id,
                        isPreviewMode
                      )
                    }
                  >
                    <span className="truncate">收入「{pack.name}」</span>
                    <Plus className="size-3 shrink-0" />
                  </Button>
                ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-full justify-start gap-2 text-xs text-dl-text-secondary"
                onClick={() => openStudio("create")}
              >
                <FolderPlus className="size-3.5" />
                新建表情包…
              </Button>
            </PopoverContent>
          </Popover>
        );
      }
    }

    const rawText =
      firstBlock?.type === "text" ? firstBlock.text : msg.plainText || "";
    return (
      <div className="dl-jumbo-sticker p-1" data-testid="jumbo-builtin-sticker">
        {renderMessageParts(rawText)}
      </div>
    );
  }

  if (msg.blocks && msg.blocks.length > 0) {
    return (
      <div className="whitespace-pre-wrap break-words">
        {msg.blocks.map((block, i) => {
          if (block.type === "text") {
            return <React.Fragment key={i}>{renderMessageParts(block.text)}</React.Fragment>;
          }
          if (block.type === "mention") {
            return (
              <span
                key={i}
                className="mx-0.5 inline-flex items-center rounded-md bg-black/10 px-1.5 py-0.5 text-[13px] font-semibold"
              >
                @{block.label}
              </span>
            );
          }
          if (block.type === "link") {
            return (
              <a
                key={i}
                href={block.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 break-all"
              >
                {block.label || block.url}
              </a>
            );
          }
          if (block.type === "emoji") {
            const customId = CUSTOM_SHORTCODE_RE.exec(block.shortcode)?.[1];
            if (customId) {
              const previewKnown = library.emotes.find((e) => e.id === customId);
              const src = previewKnown
                ? resolveCustomEmoteSrc(previewKnown)
                : `/api/workspace/emotes/${encodeURIComponent(customId)}/content`;
              return (
                <img
                  key={i}
                  src={src}
                  alt="贴纸"
                  className="mx-0.5 inline-block size-8 align-middle object-contain"
                  loading="lazy"
                />
              );
            }
            return <span key={i}>{renderMessageParts(block.shortcode)}</span>;
          }
          if (block.type === "emote_collection") {
            return (
              <div key={i} className="my-1">
                <EmotePackShareCard shareId={block.shareId} share={block.share} />
              </div>
            );
          }
          return null;
        })}
      </div>
    );
  }

  return <div className="whitespace-pre-wrap break-words">{renderMessageParts(msg.plainText)}</div>;
}

type PickerTabKey =
  | "favorites"
  | `pack:${string}`
  | EmotePack["id"];

export function EmoteStickerPopover({
  lane,
  conversationId,
  replyToId,
  disabled = false,
  onInsertText,
}: {
  lane: "workspace" | "p2p";
  conversationId?: string;
  replyToId?: string;
  disabled?: boolean;
  onInsertText: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<PickerTabKey>(() =>
    lane === "workspace" ? "favorites" : "emoji"
  );
  const [recentIds, setRecentIds] = useState<string[]>(() =>
    getRecentEmojiIds(UNICODE_EMOJI_IDS, 8)
  );
  const [uploading, setUploading] = useState(false);
  const [sharingBusy, setSharingBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const {
    isPreviewMode,
    sendWorkspaceMessage,
    sendCustomSticker,
    sendStickerPackShare,
  } = useWorkspaceStore();
  const {
    hydrated,
    library,
    settings,
    loadEmoteState,
    uploadStickers,
    updateSettingsPatch,
    createPackShare,
    openStudio,
    showToast,
  } = useEmoteStore();

  useEffect(() => {
    if (open && lane === "workspace" && !hydrated) {
      void loadEmoteState(isPreviewMode);
    }
  }, [hydrated, isPreviewMode, lane, loadEmoteState, open]);

  const enabledBuiltinPacks =
    lane === "p2p"
      ? visibleEmotePacks
      : visibleEmotePacks.filter(
          (p) => settings.enabledPackIds.includes(p.id) || p.id === "emoji"
        );

  const selectedCollection =
    lane === "workspace" && activeTab.startsWith("pack:")
      ? library.collections.find((c) => `pack:${c.id}` === activeTab) || null
      : null;

  const handleUploadFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    setUploading(true);
    try {
      const targetPackId =
        selectedCollection && !selectedCollection.sourceSubscription?.readOnly
          ? selectedCollection.id
          : undefined;
      const { uploaded, failed } = await uploadStickers(
        files,
        targetPackId ? { collectionId: targetPackId, addToLibrary: false } : undefined,
        isPreviewMode
      );
      if (failed.length > 0) {
        showToast(failed[0]);
      } else if (uploaded.length > 0) {
        showToast(
          targetPackId
            ? `已添加 ${uploaded.length} 张贴纸到「${selectedCollection?.name}」`
            : `已上传 ${uploaded.length} 张贴纸`
        );
      }
    } finally {
      setUploading(false);
    }
  };

  const handleSelectBuiltin = (item: EmoteItem, packId: EmotePack["id"], shiftKey = false) => {
    if (packId === "emoji" && item.kind === "unicode") {
      setRecentIds(recordRecentEmojiUse(item.id, UNICODE_EMOJI_IDS));
      onInsertText(item.value);
      return;
    }
    const directSend =
      lane === "workspace" &&
      Boolean(conversationId) &&
      item.kind === "image" &&
      (shiftKey ? !settings.clickImageEmoteToSend : settings.clickImageEmoteToSend);

    if (directSend && conversationId) {
      void sendWorkspaceMessage(conversationId, getEmoteInsertText(item), replyToId);
      setOpen(false);
      return;
    }
    onInsertText(getEmoteInsertText(item));
    setOpen(false);
  };

  const handleSelectCustom = (emote: CustomEmoteDTO) => {
    if (lane === "workspace" && conversationId) {
      void sendCustomSticker(conversationId, emote.id, replyToId);
      setOpen(false);
    }
  };

  const handleSharePackToChat = async (collectionId: string) => {
    if (!conversationId) return;
    setSharingBusy(true);
    try {
      const share = await createPackShare(collectionId, isPreviewMode);
      if (share) {
        await sendStickerPackShare(conversationId, share);
        showToast(`已将「${share.name}」发送到当前会话`);
        setOpen(false);
      }
    } finally {
      setSharingBusy(false);
    }
  };

  const handleCopyPackLink = async (collectionId: string) => {
    setSharingBusy(true);
    try {
      const share = await createPackShare(collectionId, isPreviewMode);
      if (share) {
        const ok = await copyShareUrlSafe(share.sharePath);
        showToast(ok ? "表情包分享链接已复制" : share.sharePath);
      }
    } finally {
      setSharingBusy(false);
    }
  };

  const trimmedQuery = query.trim().toLowerCase();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          className="rounded-xl shrink-0 text-dl-text-secondary hover:text-dl-lane-shared"
          label="表情与贴纸"
        >
          <Smile className="size-4" strokeWidth={1.85} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[348px] max-w-[92vw] p-0 overflow-hidden">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
          multiple
          className="hidden"
          aria-label="上传自定义贴纸图片"
          onChange={(e) => void handleUploadFiles(e)}
        />

        {/* Top Search & Quick Pack Actions */}
        <div className="flex items-center gap-1.5 border-b border-dl-border-hairline px-2.5 py-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-dl-text-tertiary" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索表情、贴纸或关键词…"
              aria-label="搜索表情与贴纸"
              className="h-8 pl-8 text-xs"
            />
          </div>
          {lane === "workspace" && (
            <>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-8 shrink-0 gap-1 px-2.5 text-xs"
                onClick={() => {
                  setOpen(false);
                  openStudio("create");
                }}
              >
                <FolderPlus className="size-3.5" />
                建包
              </Button>
              <IconButton
                label="管理表情与贴纸包"
                size="sm"
                variant="ghost"
                className="size-8 shrink-0"
                onClick={() => {
                  setOpen(false);
                  openStudio("packs");
                }}
              >
                <Settings2 className="size-3.5" />
              </IconButton>
            </>
          )}
        </div>

        {/* Telegram-Style Pack Strip */}
        {!trimmedQuery && (
          <div className="dl-scroll flex items-center gap-1 overflow-x-auto border-b border-dl-border-hairline bg-dl-surface-subtle/45 px-2 py-1.5">
            {lane === "workspace" && (
              <Button
                type="button"
                size="sm"
                variant={activeTab === "favorites" ? "primary" : "ghost"}
                className="h-7 shrink-0 gap-1 rounded-lg px-2 text-xs"
                onClick={() => setActiveTab("favorites")}
              >
                <Heart className="size-3.5" />
                收藏
              </Button>
            )}

            {lane === "workspace" &&
              library.collections.map((col) => {
                const tabKey: PickerTabKey = `pack:${col.id}`;
                const cover = col.items[0];
                return (
                  <Button
                    key={col.id}
                    type="button"
                    size="sm"
                    variant={activeTab === tabKey ? "primary" : "ghost"}
                    className="h-7 shrink-0 gap-1.5 rounded-lg px-2 text-xs max-w-[128px]"
                    onClick={() => setActiveTab(tabKey)}
                  >
                    {cover ? (
                      <img
                        src={resolveCustomEmoteSrc(cover)}
                        alt=""
                        className="size-4 shrink-0 object-contain"
                      />
                    ) : (
                      <Layers className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{col.name}</span>
                  </Button>
                );
              })}

            {enabledBuiltinPacks.map((pack) => (
              <Button
                key={pack.id}
                type="button"
                size="sm"
                variant={activeTab === pack.id ? "primary" : "ghost"}
                className="h-7 shrink-0 rounded-lg px-2 text-xs"
                onClick={() => setActiveTab(pack.id)}
              >
                {pack.label}
              </Button>
            ))}
          </div>
        )}

        {/* Active Content Area */}
        <div className="dl-scroll h-68 overflow-y-auto p-2.5">
          {trimmedQuery ? (
            <div className="space-y-3">
              {lane === "workspace" && (
                <>
                  {(() => {
                    const matchedCustom = [
                      ...library.emotes,
                      ...library.collections.flatMap((c) => c.items),
                    ].filter(
                      (item, idx, arr) =>
                        arr.findIndex((x) => x.id === item.id) === idx &&
                        item.label.toLowerCase().includes(trimmedQuery)
                    );
                    if (matchedCustom.length === 0) return null;
                    return (
                      <div className="space-y-1.5">
                        <div className="text-[11px] font-semibold text-dl-text-tertiary">
                          自定义贴纸 ({matchedCustom.length})
                        </div>
                        <div className="grid grid-cols-4 gap-1.5">
                          {matchedCustom.map((emote) => (
                            <Button
                              key={emote.id}
                              type="button"
                              variant="ghost"
                              title={emote.label}
                              className="flex h-16 flex-col items-center justify-center gap-1 rounded-xl p-1"
                              onClick={() => handleSelectCustom(emote)}
                            >
                              <img
                                src={resolveCustomEmoteSrc(emote)}
                                alt={emote.label}
                                className="size-11 object-contain"
                                loading="lazy"
                              />
                            </Button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}

              {enabledBuiltinPacks.map((pack) => {
                const hits = pack.items.filter(
                  (item) =>
                    item.label.toLowerCase().includes(trimmedQuery) ||
                    item.id.toLowerCase().includes(trimmedQuery)
                );
                if (hits.length === 0) return null;
                return (
                  <div key={pack.id} className="space-y-1.5">
                    <div className="text-[11px] font-semibold text-dl-text-tertiary">
                      {pack.label} ({hits.length})
                    </div>
                    <div
                      className={cn(
                        "grid gap-1",
                        pack.id === "emoji" ? "grid-cols-8" : "grid-cols-5"
                      )}
                    >
                      {hits.map((item) => (
                        <Button
                          key={item.id}
                          type="button"
                          variant="ghost"
                          title={item.label}
                          className={cn(
                            "rounded-xl p-1",
                            pack.id === "emoji" ? "h-9 w-9" : "h-13 w-full"
                          )}
                          onClick={(e) => handleSelectBuiltin(item, pack.id, e.shiftKey)}
                        >
                          {item.kind === "unicode" ? (
                            <span className="text-lg leading-none">{item.value}</span>
                          ) : (
                            <CachedEmoteImage
                              src={item.src}
                              alt={item.label}
                              className="size-9 object-contain"
                            />
                          )}
                        </Button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : lane === "workspace" && activeTab === "favorites" ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-0.5">
                <span className="text-[11px] font-semibold text-dl-text-secondary">
                  收藏贴纸 ({library.emotes.length})
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-[11px] text-dl-lane-shared"
                  onClick={() => openStudio("create")}
                >
                  <Sparkles className="size-3" />
                  整理成表情包
                </Button>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                <Button
                  type="button"
                  variant="secondary"
                  busy={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-17 flex-col items-center justify-center gap-1 rounded-xl border-dashed p-1 text-[11px] text-dl-text-secondary"
                >
                  <ImagePlus className="size-5 text-dl-lane-shared" />
                  <span>上传贴纸</span>
                </Button>

                {library.emotes.map((emote) => (
                  <Button
                    key={emote.id}
                    type="button"
                    variant="ghost"
                    title={emote.label}
                    aria-label={`发送贴纸 ${emote.label}`}
                    className="flex h-17 flex-col items-center justify-center rounded-xl p-1 hover:bg-dl-surface-subtle"
                    onClick={() => handleSelectCustom(emote)}
                  >
                    <img
                      src={resolveCustomEmoteSrc(emote)}
                      alt={emote.label}
                      className="size-13 object-contain"
                      loading="lazy"
                    />
                  </Button>
                ))}
              </div>
              {library.emotes.length === 0 && (
                <div className="pt-4 text-center text-xs text-dl-text-tertiary">
                  支持直接上传 PNG / JPG / GIF / WebP 动图，或在聊天消息上点心形一键收藏。
                </div>
              )}
            </div>
          ) : selectedCollection ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-1.5 rounded-xl bg-dl-surface-subtle/70 px-2.5 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-dl-text-primary">
                    {selectedCollection.name}
                  </div>
                  <div className="truncate text-[10px] text-dl-text-tertiary">
                    {selectedCollection.itemCount} 张
                    {selectedCollection.sourceSubscription?.enabled ? " · 已订阅同步" : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {conversationId && selectedCollection.itemCount > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      busy={sharingBusy}
                      className="h-7 gap-1 px-2 text-[11px]"
                      onClick={() => void handleSharePackToChat(selectedCollection.id)}
                    >
                      <SendHorizontal className="size-3" />
                      发包分享
                    </Button>
                  )}
                  {selectedCollection.itemCount > 0 && (
                    <IconButton
                      label="复制表情包分享链接"
                      size="sm"
                      variant="ghost"
                      className="size-7"
                      onClick={() => void handleCopyPackLink(selectedCollection.id)}
                    >
                      <Link2 className="size-3.5" />
                    </IconButton>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-4 gap-1.5">
                {!selectedCollection.sourceSubscription?.readOnly && (
                  <Button
                    type="button"
                    variant="secondary"
                    busy={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    className="flex h-17 flex-col items-center justify-center gap-1 rounded-xl border-dashed p-1 text-[11px] text-dl-text-secondary"
                  >
                    <Plus className="size-4 text-dl-lane-shared" />
                    <span>加贴纸</span>
                  </Button>
                )}

                {selectedCollection.items.map((emote) => (
                  <Button
                    key={emote.id}
                    type="button"
                    variant="ghost"
                    title={emote.label}
                    aria-label={`发送贴纸 ${emote.label}`}
                    className="flex h-17 flex-col items-center justify-center rounded-xl p-1 hover:bg-dl-surface-subtle"
                    onClick={() => handleSelectCustom(emote)}
                  >
                    <img
                      src={resolveCustomEmoteSrc(emote)}
                      alt={emote.label}
                      className="size-13 object-contain"
                      loading="lazy"
                    />
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            (() => {
              const pack =
                enabledBuiltinPacks.find((p) => p.id === activeTab) ||
                enabledBuiltinPacks[0] ||
                visibleEmotePacks[0];
              if (!pack) return null;

              const recentItems =
                pack.id === "emoji"
                  ? recentIds
                      .map((id) => pack.items.find((x) => x.id === id))
                      .filter((x): x is EmoteItem => Boolean(x))
                  : [];

              return (
                <div className="space-y-2.5">
                  {recentItems.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold text-dl-text-tertiary">
                        最近常用
                      </div>
                      <div className="grid grid-cols-8 gap-1">
                        {recentItems.map((item) => (
                          <Button
                            key={`recent-${item.id}`}
                            type="button"
                            variant="ghost"
                            title={item.label}
                            className="h-9 w-9 rounded-xl p-0"
                            onClick={() => handleSelectBuiltin(item, "emoji")}
                          >
                            <span className="text-lg leading-none">
                              {item.kind === "unicode" ? item.value : item.label}
                            </span>
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div
                    className={cn(
                      "grid gap-1",
                      pack.id === "emoji" ? "grid-cols-8" : "grid-cols-5"
                    )}
                  >
                    {pack.items.map((item) => (
                      <Button
                        key={item.id}
                        type="button"
                        variant="ghost"
                        title={item.label}
                        aria-label={item.label}
                        className={cn(
                          "rounded-xl p-1",
                          pack.id === "emoji"
                            ? "h-9 w-9"
                            : "flex h-14 w-full flex-col items-center justify-center gap-0.5"
                        )}
                        onClick={(e) => handleSelectBuiltin(item, pack.id, e.shiftKey)}
                      >
                        {item.kind === "unicode" ? (
                          <span className="text-lg leading-none">{item.value}</span>
                        ) : (
                          <>
                            <CachedEmoteImage
                              src={item.src}
                              alt={item.label}
                              className="size-8 object-contain"
                            />
                            <span className="max-w-full truncate text-[9px] text-dl-text-tertiary">
                              {item.label}
                            </span>
                          </>
                        )}
                      </Button>
                    ))}
                  </div>
                </div>
              );
            })()
          )}
        </div>

        {/* Footer Mode Toggle */}
        {lane === "workspace" && (
          <div className="flex items-center justify-between border-t border-dl-border-hairline bg-dl-surface-subtle/35 px-3 py-1.5 text-[11px] text-dl-text-secondary">
            <span>点击图片表情直接作为贴纸发出</span>
            <Switch
              label="点击图片表情直接发送"
              checked={settings.clickImageEmoteToSend}
              onCheckedChange={(checked) =>
                void updateSettingsPatch({ clickImageEmoteToSend: checked }, isPreviewMode)
              }
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function EmoteStudioPanel() {
  const {
    isPreviewMode,
    activeConversationId,
    conversations,
    sendStickerPackShare,
  } = useWorkspaceStore();
  const {
    hydrated,
    library,
    settings,
    studioTab,
    studioSelectedPackId,
    setStudioTab,
    setStudioSelectedPackId,
    loadEmoteState,
    uploadStickers,
    createPackWithFiles,
    renamePack,
    deletePack,
    addStickersToPack,
    removeStickerFromPack,
    renameSticker,
    deleteSticker,
    togglePackSubscription,
    createPackShare,
    updateSettingsPatch,
    showToast,
    closeStudio,
  } = useEmoteStore();

  const [newPackName, setNewPackName] = useState("");
  const [stagedPackFiles, setStagedPackFiles] = useState<File[]>([]);
  const [selectedExistingIds, setSelectedExistingIds] = useState<string[]>([]);
  const [creatingPack, setCreatingPack] = useState(false);

  const [renamingPackId, setRenamingPackId] = useState("");
  const [renamePackDraft, setRenamePackDraft] = useState("");
  const [renamingStickerId, setRenamingStickerId] = useState("");
  const [renameStickerDraft, setRenameStickerDraft] = useState("");
  const [selectedFavIds, setSelectedFavIds] = useState<string[]>([]);
  const [targetMovePackId, setTargetMovePackId] = useState("");
  const [busyUpload, setBusyUpload] = useState(false);
  const [statusNote, setStatusNote] = useState("");
  const [errorNote, setErrorNote] = useState("");

  const createFilesRef = useRef<HTMLInputElement | null>(null);
  const packAddFilesRef = useRef<HTMLInputElement | null>(null);
  const favUploadRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!hydrated) {
      void loadEmoteState(isPreviewMode);
    }
  }, [hydrated, isPreviewMode, loadEmoteState]);

  const activePack =
    library.collections.find((c) => c.id === studioSelectedPackId) ||
    library.collections[0] ||
    null;
  const activeConv = activeConversationId ? conversations[activeConversationId] : null;
  const writablePacks = library.collections.filter((c) => !c.sourceSubscription?.readOnly);

  const handleCreatePackSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPackName.trim()) return;
    setErrorNote("");
    setCreatingPack(true);
    try {
      const created = await createPackWithFiles(
        newPackName,
        stagedPackFiles,
        selectedExistingIds,
        isPreviewMode
      );
      if (created) {
        setNewPackName("");
        setStagedPackFiles([]);
        setSelectedExistingIds([]);
        setStudioTab("packs");
        setStudioSelectedPackId(created.id);
        setStatusNote(`表情包「${created.name}」已创建，可一键发送到聊天或复制链接分享！`);
      }
    } catch (err) {
      setErrorNote(err instanceof Error ? err.message : "创建表情包失败");
    } finally {
      setCreatingPack(false);
    }
  };

  const handleShareCollectionToChat = async (collectionId: string) => {
    if (!activeConversationId) return;
    setErrorNote("");
    try {
      const share = await createPackShare(collectionId, isPreviewMode);
      if (share) {
        await sendStickerPackShare(activeConversationId, share);
        showToast(`已发送「${share.name}」到 ${activeConv?.title || "当前对话"}`);
        closeStudio();
      }
    } catch (err) {
      setErrorNote(err instanceof Error ? err.message : "分享表情包失败");
    }
  };

  const handleCopyCollectionLink = async (collectionId: string) => {
    setErrorNote("");
    try {
      const share = await createPackShare(collectionId, isPreviewMode);
      if (share) {
        const ok = await copyShareUrlSafe(share.sharePath);
        setStatusNote(
          ok ? `分享链接已复制：${share.sharePath}` : `分享路径：${share.sharePath}`
        );
      }
    } catch (err) {
      setErrorNote(err instanceof Error ? err.message : "生成分享链接失败");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          label="表情工坊栏目"
          value={studioTab}
          onValueChange={(v) => setStudioTab(v as StudioTab)}
          options={[
            { value: "packs", label: `表情包 (${library.collections.length})` },
            { value: "create", label: "新建表情包" },
            { value: "favorites", label: `收藏贴纸 (${library.emotes.length})` },
            { value: "builtin", label: "内置与偏好" },
          ]}
        />
        <div className="text-[11px] text-dl-text-tertiary">
          本地 {library.usage.itemCount} 张 · 订阅 {library.usage.subscribedItemCount ?? 0} 张 ·{" "}
          {formatBytesShort(library.usage.totalBytes)}
        </div>
      </div>

      {statusNote && (
        <div className="rounded-xl border border-dl-lane-shared/25 bg-dl-lane-shared/10 px-3 py-2 text-xs text-dl-lane-shared">
          {statusNote}
        </div>
      )}
      {errorNote && (
        <div className="rounded-xl border border-dl-danger/25 bg-dl-danger/10 px-3 py-2 text-xs text-dl-danger">
          {errorNote}
        </div>
      )}

      {/* TAB 1: CREATE STICKER PACK */}
      {studioTab === "create" && (
        <form
          onSubmit={handleCreatePackSubmit}
          className="space-y-4 rounded-2xl border border-dl-border-hairline p-4"
        >
          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-dl-text-primary">1. 表情包名称</div>
            <Input
              value={newPackName}
              onChange={(e) => setNewPackName(e.target.value)}
              placeholder="例如：团队日常名场面 / 猫猫动图合集"
              aria-label="新表情包名称"
              maxLength={32}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-dl-text-primary">
                2. 批量导入本地图片或 GIF 动图（可选，已选 {stagedPackFiles.length} 张）
              </span>
              <input
                ref={createFilesRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                multiple
                className="hidden"
                aria-label="批量选择表情包图片"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = "";
                  if (files.length > 0) {
                    setStagedPackFiles((prev) => [...prev, ...files].slice(0, 50));
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="gap-1.5"
                onClick={() => createFilesRef.current?.click()}
              >
                <Upload className="size-3.5" />
                多选图片 / GIF
              </Button>
            </div>
            {stagedPackFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 rounded-xl bg-dl-surface-subtle/60 p-2">
                {stagedPackFiles.map((f, idx) => (
                  <span
                    key={`${f.name}-${idx}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-dl-border-hairline bg-dl-surface-raised px-2 py-0.5 text-[11px]"
                  >
                    <span className="max-w-[120px] truncate">{f.name}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-4 w-4 p-0 text-dl-text-tertiary"
                      onClick={() =>
                        setStagedPackFiles((prev) => prev.filter((_, i) => i !== idx))
                      }
                    >
                      ×
                    </Button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {library.emotes.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-dl-text-primary">
                3. 或从已有收藏贴纸中勾选加入（已勾选 {selectedExistingIds.length} 张）
              </div>
              <div className="dl-scroll grid max-h-40 grid-cols-6 max-narrow:grid-cols-4 gap-1.5 overflow-y-auto rounded-xl border border-dl-border-hairline p-2">
                {library.emotes.map((emote) => {
                  const checked = selectedExistingIds.includes(emote.id);
                  return (
                    <Button
                      key={emote.id}
                      type="button"
                      variant="ghost"
                      className={cn(
                        "relative flex h-14 flex-col items-center justify-center rounded-xl border p-1",
                        checked
                          ? "border-dl-lane-shared bg-dl-lane-shared/12"
                          : "border-transparent"
                      )}
                      onClick={() =>
                        setSelectedExistingIds((prev) =>
                          checked
                            ? prev.filter((id) => id !== emote.id)
                            : [...prev, emote.id]
                        )
                      }
                    >
                      <img
                        src={resolveCustomEmoteSrc(emote)}
                        alt={emote.label}
                        className="size-10 object-contain"
                      />
                      {checked && (
                        <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-dl-lane-shared text-[10px] text-dl-on-shared">
                          ✓
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              busy={creatingPack}
              disabled={!newPackName.trim()}
              className="gap-1.5"
            >
              <Sparkles className="size-3.5" />
              创建表情包
            </Button>
          </div>
        </form>
      )}

      {/* TAB 2: MANAGE STICKER PACKS */}
      {studioTab === "packs" && (
        <div className="space-y-3">
          {library.collections.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-dl-border-hairline p-6 text-center space-y-2.5">
              <div className="text-sm font-semibold text-dl-text-primary">
                还没有表情包合集
              </div>
              <div className="text-xs text-dl-text-secondary">
                把常用贴纸打包成套，一键发到群聊，群友点一下就能整套收进自己的表情栏。
              </div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="gap-1.5"
                onClick={() => setStudioTab("create")}
              >
                <FolderPlus className="size-3.5" />
                立即创建第一个表情包
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {library.collections.map((col) => (
                  <Button
                    key={col.id}
                    type="button"
                    size="sm"
                    variant={activePack?.id === col.id ? "primary" : "secondary"}
                    className="gap-1.5"
                    onClick={() => setStudioSelectedPackId(col.id)}
                  >
                    <span>{col.name}</span>
                    <span className="opacity-75 text-[11px]">({col.itemCount})</span>
                  </Button>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="gap-1 text-dl-lane-shared"
                  onClick={() => setStudioTab("create")}
                >
                  <Plus className="size-3.5" />
                  新建包
                </Button>
              </div>

              {activePack && (
                <div className="space-y-3 rounded-2xl border border-dl-border-hairline p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {renamingPackId === activePack.id ? (
                      <div className="flex items-center gap-1.5 flex-1 min-w-[200px]">
                        <Input
                          value={renamePackDraft}
                          onChange={(e) => setRenamePackDraft(e.target.value)}
                          aria-label="修改表情包名称"
                          className="h-8 text-xs"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          onClick={() => {
                            void renamePack(activePack.id, renamePackDraft, isPreviewMode);
                            setRenamingPackId("");
                          }}
                        >
                          保存
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setRenamingPackId("")}
                        >
                          取消
                        </Button>
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold text-dl-text-primary">
                            {activePack.name}
                          </span>
                          {!activePack.sourceSubscription?.readOnly && (
                            <IconButton
                              label="重命名表情包"
                              size="sm"
                              variant="ghost"
                              className="size-6"
                              onClick={() => {
                                setRenamingPackId(activePack.id);
                                setRenamePackDraft(activePack.name);
                              }}
                            >
                              <Pencil className="size-3" />
                            </IconButton>
                          )}
                        </div>
                        <div className="text-[11px] text-dl-text-secondary">
                          共 {activePack.itemCount} 张 · 原作者{" "}
                          {activePack.originalCreator?.displayName || "我"}
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5">
                      {activeConv && activePack.itemCount > 0 && (
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          className="gap-1.5"
                          onClick={() => void handleShareCollectionToChat(activePack.id)}
                        >
                          <Share2 className="size-3.5" />
                          发到「{activeConv.title}」
                        </Button>
                      )}
                      {activePack.itemCount > 0 && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="gap-1.5"
                          onClick={() => void handleCopyCollectionLink(activePack.id)}
                        >
                          <Copy className="size-3.5" />
                          复制分享链接
                        </Button>
                      )}
                      {!activePack.sourceSubscription?.readOnly && (
                        <>
                          <input
                            ref={packAddFilesRef}
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                            multiple
                            className="hidden"
                            aria-label="向当前表情包上传贴纸"
                            onChange={(e) => {
                              const files = Array.from(e.target.files || []);
                              e.target.value = "";
                              if (files.length === 0) return;
                              setBusyUpload(true);
                              void uploadStickers(
                                files,
                                { collectionId: activePack.id, addToLibrary: false },
                                isPreviewMode
                              ).finally(() => setBusyUpload(false));
                            }}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            busy={busyUpload}
                            className="gap-1"
                            onClick={() => packAddFilesRef.current?.click()}
                          >
                            <ImagePlus className="size-3.5" />
                            添加图片
                          </Button>
                        </>
                      )}
                      <IconButton
                        label="删除此表情包"
                        size="sm"
                        variant="danger"
                        onClick={() => void deletePack(activePack.id, "keep", isPreviewMode)}
                      >
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    </div>
                  </div>

                  {(activePack.sourceSubscription?.eligible ||
                    activePack.sourceSubscription?.status === "detached") && (
                    <div className="flex items-center justify-between gap-3 rounded-xl bg-dl-surface-subtle/70 px-3 py-2 text-xs">
                      <div>
                        <div className="font-medium text-dl-text-primary">
                          同步原作者后续更新
                        </div>
                        <div className="text-[11px] text-dl-text-secondary">
                          {activePack.sourceSubscription.status === "detached"
                            ? "原合集已移除，当前内容作为本地快照永久保留。"
                            : activePack.sourceSubscription.readOnly
                            ? "开启期间自动同步作者新增贴纸；如需自行增删贴纸可先关闭同步。"
                            : "已暂停同步，你现在可以自由增删和修改该表情包。"}
                        </div>
                      </div>
                      {activePack.sourceSubscription.eligible && (
                        <Switch
                          label="同步原作者更新"
                          checked={activePack.sourceSubscription.enabled}
                          onCheckedChange={(enabled) =>
                            void togglePackSubscription(activePack.id, enabled, isPreviewMode)
                          }
                        />
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-5 max-narrow:grid-cols-3 gap-2">
                    {activePack.items.map((emote) => (
                      <div
                        key={emote.id}
                        className="group relative flex flex-col items-center justify-center gap-1 rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/40 p-2"
                      >
                        <img
                          src={resolveCustomEmoteSrc(emote)}
                          alt={emote.label}
                          className="size-14 object-contain"
                          loading="lazy"
                        />
                        <span className="max-w-full truncate text-[11px] text-dl-text-secondary">
                          {emote.label}
                        </span>
                        {!activePack.sourceSubscription?.readOnly && (
                          <IconButton
                            label={`从表情包移出 ${emote.label}`}
                            size="sm"
                            variant="danger"
                            className="absolute right-1 top-1 size-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
                            onClick={() =>
                              void removeStickerFromPack(activePack.id, emote.id, isPreviewMode)
                            }
                          >
                            <Trash2 className="size-3" />
                          </IconButton>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* TAB 3: STANDALONE FAVORITE STICKERS */}
      {studioTab === "favorites" && (
        <div className="space-y-3 rounded-2xl border border-dl-border-hairline p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <input
                ref={favUploadRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                multiple
                className="hidden"
                aria-label="上传收藏贴纸"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = "";
                  if (files.length === 0) return;
                  setBusyUpload(true);
                  void uploadStickers(files, undefined, isPreviewMode).finally(() =>
                    setBusyUpload(false)
                  );
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="primary"
                busy={busyUpload}
                className="gap-1.5"
                onClick={() => favUploadRef.current?.click()}
              >
                <Upload className="size-3.5" />
                上传贴纸（支持多选 / GIF）
              </Button>
            </div>

            {selectedFavIds.length > 0 && writablePacks.length > 0 && (
              <div className="flex items-center gap-1.5">
                <Select
                  value={targetMovePackId || writablePacks[0].id}
                  onValueChange={setTargetMovePackId}
                  options={writablePacks.map((p) => ({ value: p.id, label: p.name }))}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const dest = targetMovePackId || writablePacks[0]?.id;
                    if (!dest) return;
                    void addStickersToPack(dest, selectedFavIds, isPreviewMode).then(() => {
                      setSelectedFavIds([]);
                      setStatusNote("已将选中贴纸加入表情包");
                    });
                  }}
                >
                  加入表情包 ({selectedFavIds.length})
                </Button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-5 max-narrow:grid-cols-3 gap-2">
            {library.emotes.map((emote) => {
              const selected = selectedFavIds.includes(emote.id);
              return (
                <div
                  key={emote.id}
                  className={cn(
                    "group relative flex flex-col items-center gap-1 rounded-xl border p-2",
                    selected
                      ? "border-dl-lane-shared bg-dl-lane-shared/10"
                      : "border-dl-border-hairline bg-dl-surface-subtle/40"
                  )}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-15 w-full p-0"
                    onClick={() =>
                      setSelectedFavIds((prev) =>
                        selected ? prev.filter((id) => id !== emote.id) : [...prev, emote.id]
                      )
                    }
                  >
                    <img
                      src={resolveCustomEmoteSrc(emote)}
                      alt={emote.label}
                      className="size-13 object-contain"
                      loading="lazy"
                    />
                  </Button>

                  {renamingStickerId === emote.id ? (
                    <div className="flex w-full items-center gap-1">
                      <Input
                        value={renameStickerDraft}
                        onChange={(e) => setRenameStickerDraft(e.target.value)}
                        aria-label="贴纸名称"
                        className="h-6 px-1.5 text-[11px]"
                      />
                      <IconButton
                        label="保存贴纸名称"
                        size="sm"
                        variant="primary"
                        className="size-6"
                        onClick={() => {
                          void renameSticker(emote.id, renameStickerDraft, isPreviewMode);
                          setRenamingStickerId("");
                        }}
                      >
                        <Check className="size-3" />
                      </IconButton>
                    </div>
                  ) : (
                    <div className="flex w-full items-center justify-between gap-1">
                      <span className="truncate text-[11px] text-dl-text-secondary">
                        {emote.label}
                      </span>
                      <div className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <IconButton
                          label="修改贴纸关键词"
                          size="sm"
                          variant="ghost"
                          className="size-5"
                          onClick={() => {
                            setRenamingStickerId(emote.id);
                            setRenameStickerDraft(emote.label);
                          }}
                        >
                          <Pencil className="size-2.5" />
                        </IconButton>
                        <IconButton
                          label="删除贴纸"
                          size="sm"
                          variant="danger"
                          className="size-5"
                          onClick={() => void deleteSticker(emote.id, isPreviewMode)}
                        >
                          <Trash2 className="size-2.5" />
                        </IconButton>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 4: BUILT-IN PACKS & PREFERENCES */}
      {studioTab === "builtin" && (
        <div className="space-y-4 rounded-2xl border border-dl-border-hairline p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-dl-text-primary">
                点击图片表情直接作为贴纸发出
              </div>
              <div className="text-[11px] text-dl-text-secondary">
                开启后点击贴纸/图片表情立即发送；按住 Shift 点击可临时切换为插入输入框
              </div>
            </div>
            <Switch
              label="点击图片表情直接发送"
              checked={settings.clickImageEmoteToSend}
              onCheckedChange={(checked) =>
                void updateSettingsPatch({ clickImageEmoteToSend: checked }, isPreviewMode)
              }
            />
          </div>

          <div className="space-y-2 border-t border-dl-border-hairline pt-3">
            <div className="text-xs font-semibold text-dl-text-primary">启用的内置表情包</div>
            <div className="grid grid-cols-2 max-narrow:grid-cols-1 gap-2">
              {visibleEmotePacks.map((pack) => {
                const enabled = settings.enabledPackIds.includes(pack.id);
                const sample = pack.items[0];
                return (
                  <div
                    key={pack.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/50 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {sample?.kind === "unicode" ? (
                        <span className="text-lg">{sample.value}</span>
                      ) : sample?.kind === "image" ? (
                        <CachedEmoteImage
                          src={sample.src}
                          alt={pack.label}
                          className="size-6 object-contain"
                        />
                      ) : null}
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-dl-text-primary">
                          {pack.label}
                        </div>
                        <div className="text-[10px] text-dl-text-tertiary">
                          {pack.items.length} 个表情
                        </div>
                      </div>
                    </div>
                    <Switch
                      label={`启用 ${pack.label}`}
                      checked={enabled}
                      disabled={enabled && settings.enabledPackIds.length <= 1}
                      onCheckedChange={(nextOn) => {
                        const nextIds = nextOn
                          ? Array.from(new Set([...settings.enabledPackIds, pack.id]))
                          : settings.enabledPackIds.filter((id) => id !== pack.id);
                        if (nextIds.length === 0) return;
                        void updateSettingsPatch({ enabledPackIds: nextIds }, isPreviewMode);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function EmoteGlobalModals() {
  const isPreviewMode = useWorkspaceStore((s) => s.isPreviewMode);
  const {
    studioOpen,
    closeStudio,
    activeSharedPackId,
    sharedPackDetail,
    sharedPackLoading,
    sharedPackError,
    closeSharedPack,
    importSharedPack,
    toastMessage,
  } = useEmoteStore();

  const [subscribeOnImport, setSubscribeOnImport] = useState(true);
  const [selectedImportIds, setSelectedImportIds] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);

  const shareItems = sharedPackDetail?.items || [];
  const effectiveSelectedIds =
    selectedImportIds.length > 0 ? selectedImportIds : shareItems.map((i) => i.id);

  const handleImportWholePack = async () => {
    if (!activeSharedPackId || !sharedPackDetail) return;
    setImporting(true);
    try {
      await importSharedPack(
        activeSharedPackId,
        {
          asCollection: true,
          subscribeToSourceChanges:
            sharedPackDetail.canSubscribeToSourceChanges && subscribeOnImport,
        },
        isPreviewMode
      );
      setSelectedImportIds([]);
    } finally {
      setImporting(false);
    }
  };

  const handleImportSelectedOnly = async () => {
    if (!activeSharedPackId || effectiveSelectedIds.length === 0) return;
    setImporting(true);
    try {
      await importSharedPack(
        activeSharedPackId,
        {
          asCollection: false,
          emoteIds: effectiveSelectedIds,
        },
        isPreviewMode
      );
      setSelectedImportIds([]);
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      {/* Floating Quick Toast for 1-click Sticker Stealing / Sharing */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="dl-glass-elevated fixed bottom-6 left-1/2 z-[90] -translate-x-1/2 rounded-full border border-dl-lane-shared/35 px-4 py-2 text-xs font-medium text-dl-text-primary shadow-lg"
        >
          {toastMessage}
        </div>
      )}

      {/* Standalone Sticker & Pack Studio Modal (opened from Composer / Sticker menu) */}
      <Dialog
        open={studioOpen}
        onOpenChange={(open) => {
          if (!open) closeStudio();
        }}
      >
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-dl-lane-shared" />
              <span>表情与贴纸工坊</span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              创建、管理、订阅与分享自定义表情包
            </DialogDescription>
          </DialogHeader>
          <div className="dl-scroll max-h-[74vh] overflow-y-auto p-6 max-narrow:p-4 pt-3">
            <EmoteStudioPanel />
          </div>
        </DialogContent>
      </Dialog>

      {/* Telegram-Style Shared Sticker Pack Preview & 1-Click Add Sheet */}
      <Dialog
        open={Boolean(activeSharedPackId)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedImportIds([]);
            closeSharedPack();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="size-4 text-dl-lane-shared" />
              <span>{sharedPackDetail?.name || "预览分享的表情包"}</span>
            </DialogTitle>
            <DialogDescription>
              {sharedPackDetail
                ? `共 ${sharedPackDetail.itemCount} 张贴纸 · 原作者 ${sharedPackDetail.originalCreator.displayName}`
                : "查看并一键添加到你的表情栏"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 p-6 max-narrow:p-4 pt-3">
            {sharedPackLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-dl-text-secondary">
                <RefreshCw className="size-4 animate-spin" />
                <span>正在加载表情包内容…</span>
              </div>
            ) : sharedPackError ? (
              <div className="rounded-xl border border-dl-danger/25 bg-dl-danger/10 p-4 text-xs text-dl-danger">
                {sharedPackError}
              </div>
            ) : sharedPackDetail ? (
              <>
                <div className="dl-scroll grid max-h-64 grid-cols-4 gap-2 overflow-y-auto rounded-2xl border border-dl-border-hairline bg-dl-surface-subtle/40 p-3">
                  {shareItems.map((item) => {
                    const checked = effectiveSelectedIds.includes(item.id);
                    return (
                      <Button
                        key={item.id}
                        type="button"
                        variant="ghost"
                        title={item.label}
                        onClick={() =>
                          setSelectedImportIds((prev) => {
                            const base = prev.length > 0 ? prev : shareItems.map((x) => x.id);
                            return base.includes(item.id)
                              ? base.filter((id) => id !== item.id)
                              : [...base, item.id];
                          })
                        }
                        className={cn(
                          "relative flex h-18 flex-col items-center justify-center rounded-xl border p-1.5",
                          checked
                            ? "border-dl-lane-shared/50 bg-dl-lane-shared/8"
                            : "border-transparent opacity-55"
                        )}
                      >
                        <img
                          src={resolveCustomEmoteSrc(item)}
                          alt={item.label}
                          className="size-13 object-contain"
                          loading="lazy"
                        />
                      </Button>
                    );
                  })}
                </div>

                {sharedPackDetail.canSubscribeToSourceChanges && (
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-dl-surface-subtle/70 px-3 py-2 text-xs">
                    <div>
                      <div className="font-semibold text-dl-text-primary">
                        同步订阅原作者后续更新
                      </div>
                      <div className="text-[11px] text-dl-text-secondary">
                        原作者往该表情包新增贴纸时，你的表情栏将自动同步
                      </div>
                    </div>
                    <Switch
                      label="同步订阅原作者更新"
                      checked={subscribeOnImport}
                      onCheckedChange={setSubscribeOnImport}
                    />
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    busy={importing}
                    onClick={() => void handleImportSelectedOnly()}
                  >
                    仅收藏所选贴纸 ({effectiveSelectedIds.length})
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    busy={importing}
                    className="gap-1.5"
                    onClick={() => void handleImportWholePack()}
                  >
                    <Sparkles className="size-3.5" />
                    整包添加到表情栏 (+{sharedPackDetail.itemCount} 张)
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
