import type { CardKitBlock, DualLaneCardKitDocument } from "@duallane/protocol";
export type WorkspaceCardBlock = Exclude<CardKitBlock, { type: "markdown" }> | { type: "markdown"; content: string; plainText: boolean };
export type WorkspaceCardDocument = Omit<DualLaneCardKitDocument, "blocks"> & { blocks: WorkspaceCardBlock[] };

export interface WorkspaceCardReference {
  cardId: string;
  cardType: string;
  schemaVersion: number;
  fallbackText: string;
}

const fixedActions = new Set(["confirm", "cancel", "submit", "refresh"]);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 160;
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 12_288;

export function readWorkspaceCardReferences(content: unknown): WorkspaceCardReference[] {
  const blocks = record(content)?.blocks;
  if (!Array.isArray(blocks)) return [];
  const references: WorkspaceCardReference[] = [];
  for (const item of blocks.slice(0, 100)) {
    const block = record(item);
    if (block?.type !== "card" || !identifier(block.cardId) || !identifier(block.cardType) ||
        !Number.isSafeInteger(block.schemaVersion) || Number(block.schemaVersion) < 1 || !text(block.fallbackText)) continue;
    if (!references.some((entry) => entry.cardId === block.cardId)) references.push({
      cardId: block.cardId, cardType: block.cardType,
      schemaVersion: Number(block.schemaVersion), fallbackText: block.fallbackText,
    });
  }
  return references;
}

// Project only the registered, normalized server DTO. Business data stays on
// the server; a button never becomes a URL, executable or arbitrary input form.
export function projectWorkspaceCard(reference: WorkspaceCardReference, value: unknown): WorkspaceCardDocument | null {
  const resolution = record(value);
  const block = record(resolution?.block);
  if (resolution?.type !== "card" || resolution.id !== reference.cardId ||
      block?.cardId !== reference.cardId || block.cardType !== reference.cardType ||
      block.schemaVersion !== reference.schemaVersion || reference.cardType !== "feishu.adaptive.v1" ||
      reference.schemaVersion !== 1 || !Number.isSafeInteger(resolution.revision) || Number(resolution.revision) < 1 ||
      !["active", "invalidated", "expired"].includes(String(resolution.status))) return null;
  const payload = record(resolution.payload);
  if (payload?.format !== "duallane.feishu-card.v1" || !Array.isArray(payload.elements)) return null;
  const allowed = new Set(Array.isArray(resolution.actions)
    ? resolution.actions.filter((action): action is string => typeof action === "string" && fixedActions.has(action)) : []);
  const blocks: WorkspaceCardBlock[] = [];
  const header = record(payload.header);
  if (header) {
    if (!text(header.title) || (header.subtitle !== undefined && !text(header.subtitle))) return null;
    const tone = ["neutral", "shared", "direct", "success", "warning", "danger"].includes(String(header.tone))
      ? header.tone as "neutral" | "shared" | "direct" | "success" | "warning" | "danger" : "neutral";
    blocks.push({ type: "header", title: header.title, subtitle: header.subtitle as string | undefined, tone });
  }
  let nodes = 0;
  let textLength = 0;
  const seenActions = new Set<string>();
  const visit = (elements: unknown[], depth: number): boolean => {
    if (depth > 10) return false;
    for (const raw of elements) {
      if (++nodes > 80) return false;
      const element = record(raw);
      if (!element) return false;
      if (element.type === "text") {
        if (!text(element.text) || !["plain", "markdown"].includes(String(element.format))) return false;
        textLength += element.text.length;
        blocks.push({ type: "markdown", content: element.text, plainText: element.format === "plain" });
      } else if (element.type === "divider") {
        blocks.push({ type: "divider" });
      } else if (element.type === "note") {
        if (!Array.isArray(element.parts)) return false;
        for (const rawPart of element.parts) {
          const part = record(rawPart);
          if (++nodes > 80 || !text(part?.text) || !["plain", "markdown"].includes(String(part?.format))) return false;
          textLength += part.text.length;
          blocks.push({ type: "markdown", content: part.text, plainText: part.format === "plain" });
        }
      } else if (element.type === "columns") {
        if (!Array.isArray(element.columns) || element.columns.length > 4) return false;
        for (const rawColumn of element.columns) {
          const column = record(rawColumn);
          if (++nodes > 80 || !Array.isArray(column?.elements) || !visit(column.elements, depth + 1)) return false;
        }
      } else if (element.type === "actions") {
        if (!Array.isArray(element.buttons) || element.buttons.length > 4) return false;
        const buttons: Extract<CardKitBlock, { type: "actions" }>["elements"] = [];
        for (const rawButton of element.buttons) {
          const button = record(rawButton);
          if (++nodes > 80 || button?.type !== "button" || !text(button.label) ||
              typeof button.actionId !== "string" || !fixedActions.has(button.actionId) || seenActions.has(button.actionId) ||
              !["default", "primary", "danger"].includes(String(button.style))) return false;
          seenActions.add(button.actionId);
          textLength += button.label.length;
          buttons.push({ type: "button", actionId: button.actionId, label: button.label,
            style: button.style as "default" | "primary" | "danger", disabled: !allowed.has(button.actionId) });
        }
        blocks.push({ type: "actions", elements: buttons });
      } else return false;
      if (textLength > 12_288) return false;
    }
    return true;
  };
  if (!visit(payload.elements, 0)) return null;
  return { version: 1, cardId: reference.cardId, cardType: reference.cardType,
    status: resolution.status as DualLaneCardKitDocument["status"], revision: Number(resolution.revision),
    fallbackText: reference.fallbackText, blocks };
}
