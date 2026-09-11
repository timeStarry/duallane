import type { EmoteItem, EmotePack } from "../../emotes";
import type { ConversationComposerAttachment } from "./contracts";

export function formatMessageDayLabel(value?: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDelta = Math.round((startOfToday - startOfDate) / 86400000);
  if (dayDelta === 0) {
    return "今天";
  }
  if (dayDelta === 1) {
    return "昨天";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric"
  }).format(date);
}

export function getMessageDayKey(value?: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function shouldDirectSendWorkspaceEmote(item: EmoteItem, packId: EmotePack["id"], enabled: boolean) {
  return enabled && packId === "custom" && item.kind === "image";
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

export function getWorkspacePendingAttachmentProgress(attachments: ConversationComposerAttachment[]) {
  if (attachments.length === 0) return 0;
  const totalBytes = attachments.reduce((total, attachment) => total + Math.max(attachment.file.size, 1), 0);
  const uploadedBytes = attachments.reduce(
    (total, attachment) => total + Math.max(attachment.file.size, 1) * Math.min(100, Math.max(0, attachment.progress)) / 100,
    0
  );
  return Math.round(uploadedBytes / totalBytes * 100);
}
