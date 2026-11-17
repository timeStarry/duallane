export type CardActionStyle = "default" | "primary" | "danger";

export interface CardHeaderBlock {
  type: "header";
  title: string;
  subtitle?: string;
  badge?: string;
  tone?: "neutral" | "shared" | "direct" | "success" | "warning" | "danger";
}

export interface CardMarkdownBlock {
  type: "markdown";
  content: string;
}

export interface CardFieldItem {
  label: string;
  value: string;
  short?: boolean;
}

export interface CardFieldsBlock {
  type: "fields";
  items: CardFieldItem[];
}

export interface CardPollOption {
  id: string;
  label: string;
  votes: number;
  selected?: boolean;
}

export interface CardPollBlock {
  type: "poll";
  pollId: string;
  multiSelect?: boolean;
  totalVotes: number;
  closed?: boolean;
  options: CardPollOption[];
}

export interface CardActionButton {
  type: "button";
  actionId: string;
  label: string;
  style?: CardActionStyle;
  disabled?: boolean;
  payload?: Record<string, unknown>;
  opensModal?: boolean;
}

export interface CardActionSelectOption {
  value: string;
  label: string;
}

export interface CardActionSelect {
  type: "select";
  actionId: string;
  placeholder?: string;
  value?: string;
  options: CardActionSelectOption[];
  disabled?: boolean;
}

export interface CardActionsBlock {
  type: "actions";
  elements: Array<CardActionButton | CardActionSelect>;
}

export interface CardDividerBlock {
  type: "divider";
}

export type CardKitBlock =
  | CardHeaderBlock
  | CardMarkdownBlock
  | CardFieldsBlock
  | CardPollBlock
  | CardActionsBlock
  | CardDividerBlock;

export interface DualLaneCardKitDocument {
  version: 1;
  cardId: string;
  cardType: string;
  status: "active" | "invalidated" | "expired";
  revision: number;
  fallbackText: string;
  blocks: CardKitBlock[];
}

export interface CardModalField {
  name: string;
  label: string;
  kind: "text" | "textarea" | "select" | "switch";
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | boolean;
  options?: CardActionSelectOption[];
}

export interface CardModalSpec {
  modalId: string;
  title: string;
  submitLabel?: string;
  fields: CardModalField[];
}
