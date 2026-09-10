import { EyeOff } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { findFirstImageEmoteKey } from "./emotes";
import { prepareWorkspaceMarkdown } from "./WorkspaceMarkdown";
import { isPreviewableImageMimeType } from "./workspace-image-files";
import "./workspace-auto-hide.css";

export const AUTO_HIDE_MESSAGE_TYPES = ["image", "emote", "long"] as const;
export type AutoHideMessageType = typeof AUTO_HIDE_MESSAGE_TYPES[number];
export type WorkspaceAutoHidePreferences = {
  autoHideMessages: boolean;
  autoHideMessageTypes: AutoHideMessageType[];
};
export const DEFAULT_AUTO_HIDE_PREFERENCES: WorkspaceAutoHidePreferences = {
  autoHideMessages: false,
  autoHideMessageTypes: [...AUTO_HIDE_MESSAGE_TYPES]
};
export const AUTO_HIDE_LABELS: Record<AutoHideMessageType, string> = {
  image: "图片", emote: "表情", long: "长消息"
};

// Old servers omit these additive fields. Never turn hiding on by coercion.
export function normalizeAutoHidePreferences(value: Partial<WorkspaceAutoHidePreferences>): WorkspaceAutoHidePreferences {
  return {
    autoHideMessages: value.autoHideMessages === true,
    autoHideMessageTypes: Array.isArray(value.autoHideMessageTypes)
      ? AUTO_HIDE_MESSAGE_TYPES.filter((type) => value.autoHideMessageTypes!.includes(type))
      : [...AUTO_HIDE_MESSAGE_TYPES]
  };
}

type DisplayBlock = {
  type: string;
  text?: string;
  label?: string;
  url?: string;
  shortcode?: string;
  title?: string;
  fallbackText?: string;
  attachmentId?: string;
  share?: { name?: string } | null;
};
type DisplayContent = {
  blocks: readonly DisplayBlock[];
  fallbackText?: string;
  attachments?: readonly { id: string; mimeType: string; status: string }[];
};

const workspaceDisplayBlockTypes = new Set([
  "text",
  "mention",
  "link",
  "emoji",
  "attachment",
  "emote_collection",
  "topic_reference",
  "card"
]);

// WorkspaceStructuredMessage falls back to MessageBody for any block outside
// this set. Keep this predicate exportable so the renderer and classifier can
// share the same fallback boundary without duplicating the full block union.
export function isWorkspaceDisplayBlock(block: { type?: unknown } | null | undefined) {
  return typeof block?.type === "string" && workspaceDisplayBlockTypes.has(block.type);
}

export function shouldCollapseWorkspaceMessageText(blocks: readonly DisplayBlock[]) {
  const visible = blocks.map((block) => {
    if (block.type === "text") return block.text ?? "";
    if (block.type === "mention") return `@${block.label}`;
    if (block.type === "link") return block.label || block.url;
    if (block.type === "emoji") return block.shortcode?.startsWith("custom:") ? "[表情]" : `:${block.shortcode}:`;
    if (block.type === "emote_collection") return `[表情合集] ${block.share?.name || ""}`;
    if (block.type === "topic_reference") return `#${block.title}`;
    if (block.type === "card") return block.fallbackText;
    return "";
  }).join("");
  return Array.from(visible).length > 700 || visible.split(/\r?\n/).length > 10;
}

type MarkdownNode = { type: string; value?: string; url?: string; identifier?: string; children?: MarkdownNode[] };
const markdownParser = unified().use(remarkParse).use(remarkGfm);
const unicodeEmote = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;
function containsEmote(text: string) {
  return unicodeEmote.test(text) || findFirstImageEmoteKey(text) !== null;
}
function isRemoteImage(url?: string) {
  try { return ["http:", "https:"].includes(new URL(url ?? "").protocol); }
  catch { return false; }
}

function classifyPlainFallbackText(text: string, found: Set<AutoHideMessageType>) {
  if (shouldCollapseWorkspaceMessageText([{ type: "text", text }])) found.add("long");
  // MessageBody uses renderMessageParts, so only plain Unicode and known
  // image-emote tokens are displayed here; Markdown images are not rendered.
  if (containsEmote(text)) found.add("emote");
}

export function classifyAutoHiddenContent({ blocks, fallbackText = "", attachments = [] }: DisplayContent): AutoHideMessageType[] {
  const found = new Set<AutoHideMessageType>();
  const usesPlainFallback = blocks.length === 0 || blocks.some((block) => !isWorkspaceDisplayBlock(block));
  if (usesPlainFallback) {
    classifyPlainFallbackText(fallbackText, found);
    return AUTO_HIDE_MESSAGE_TYPES.filter((type) => found.has(type));
  }

  const displayedBlocks = blocks;
  if (shouldCollapseWorkspaceMessageText(displayedBlocks)) found.add("long");
  for (const block of displayedBlocks) {
    if (block.type === "emoji") found.add("emote");
    if (block.type === "attachment" && attachments.some((file) => file.id === block.attachmentId && file.status === "available" && isPreviewableImageMimeType(file.mimeType))) found.add("image");
    if (block.type !== "text") continue;
    const prepared = prepareWorkspaceMarkdown(block.text ?? "");
    if (prepared.plain) {
      if (containsEmote(prepared.source)) found.add("emote");
      continue;
    }
    const tree = markdownParser.parse(prepared.source) as MarkdownNode;
    const definitions = new Map<string, string>();
    const collectDefinitions = (node: MarkdownNode) => {
      if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
      node.children?.forEach(collectDefinitions);
    };
    collectDefinitions(tree);
    const visit = (node: MarkdownNode) => {
      // Literal code, image alt text and link destinations are not displayed emotes.
      if (["code", "inlineCode", "definition"].includes(node.type)) return;
      if (node.type === "image" || node.type === "imageReference") {
        const url = node.type === "image" ? node.url : definitions.get(node.identifier ?? "");
        if (isRemoteImage(url)) found.add("image");
        return;
      }
      if (node.type === "text" && containsEmote(node.value ?? "")) found.add("emote");
      node.children?.forEach(visit);
    };
    visit(tree);
  }
  return AUTO_HIDE_MESSAGE_TYPES.filter((type) => found.has(type));
}

export function WorkspaceAutoHiddenContent({ preferences = DEFAULT_AUTO_HIDE_PREFERENCES, children, ...content }: DisplayContent & {
  preferences?: WorkspaceAutoHidePreferences | null;
  children: ReactNode;
}) {
  const matched = useMemo(() => preferences?.autoHideMessages
    ? classifyAutoHiddenContent(content).filter((type) => preferences.autoHideMessageTypes.includes(type))
    : [], [preferences, content.blocks, content.fallbackText, content.attachments]);
  if (preferences === null) return <div className="workspace-auto-hidden-summary" aria-busy="true">正在加载消息显示设置</div>;
  // A new selection gets its own reveal state; disabling never persists a message hide.
  return matched.length ? <AutoHiddenBody key={matched.join(",")} types={matched}>{children}</AutoHiddenBody> : <>{children}</>;
}

function AutoHiddenBody({ types, children }: { types: AutoHideMessageType[]; children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return <div className="workspace-auto-hidden-content">
    <div className="workspace-auto-hidden-summary">
      <EyeOff size={14} aria-hidden="true" />
      <span>{revealed ? "已展开" : "已自动隐藏"} · {types.map((type) => AUTO_HIDE_LABELS[type]).join("、")}</span>
      <button type="button" aria-expanded={revealed} onClick={() => setRevealed((value) => !value)}>{revealed ? "收起" : "展开消息"}</button>
    </div>
    {revealed && children}
  </div>;
}
