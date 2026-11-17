import React, { useState } from "react";
import type {
  CardActionsBlock,
  CardFieldsBlock,
  CardHeaderBlock,
  CardKitBlock,
  CardModalSpec,
  CardPollBlock,
  DualLaneCardKitDocument,
} from "@duallane/protocol";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Select, Switch } from "@/shared/ui";
import { cn } from "@/shared/lib/cn";

interface DualLaneCardKitProps {
  card: DualLaneCardKitDocument;
  onAction: (cardId: string, actionId: string, payload?: Record<string, unknown>) => Promise<void> | void;
}

const TONE_BADGE: Record<NonNullable<CardHeaderBlock["tone"]>, string> = {
  neutral: "bg-dl-surface-subtle text-dl-text-secondary border-dl-border-hairline",
  shared: "bg-dl-lane-shared/15 text-dl-lane-shared border-dl-lane-shared/30",
  direct: "bg-dl-lane-direct/15 text-dl-lane-direct border-dl-lane-direct/30",
  success: "bg-dl-success/15 text-dl-success border-dl-success/30",
  warning: "bg-dl-warning/15 text-dl-warning border-dl-warning/30",
  danger: "bg-dl-danger/15 text-dl-danger border-dl-danger/30",
};

export function DualLaneCardKit({ card, onAction }: DualLaneCardKitProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [modalSpec, setModalSpec] = useState<CardModalSpec | null>(null);
  const [modalValues, setModalValues] = useState<Record<string, string | boolean>>({});

  const isLocked = card.status !== "active";

  const handleAction = async (actionId: string, payload?: Record<string, unknown>, opensModal?: boolean) => {
    if (isLocked || busyAction) return;
    if (opensModal && payload && typeof payload.modal === "object" && payload.modal !== null) {
      const spec = payload.modal as CardModalSpec;
      const defaults: Record<string, string | boolean> = {};
      for (const f of spec.fields || []) {
        if (f.defaultValue !== undefined) defaults[f.name] = f.defaultValue;
      }
      setModalValues(defaults);
      setModalSpec(spec);
      return;
    }
    setBusyAction(actionId);
    try {
      await onAction(card.cardId, actionId, payload);
    } finally {
      setBusyAction(null);
    }
  };

  const submitModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalSpec) return;
    setBusyAction(modalSpec.modalId);
    try {
      await onAction(card.cardId, `modal:${modalSpec.modalId}`, modalValues);
      setModalSpec(null);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      className={cn(
        "dl-glass-elevated w-full max-w-md min-w-0 overflow-hidden rounded-2xl p-3.5 border border-dl-border-hairline transition-opacity [overflow-wrap:anywhere] break-words",
        isLocked && "opacity-70"
      )}
    >
      <div className="space-y-3">
        {card.blocks.map((block, index) => (
          <CardBlockView
            key={`${card.cardId}-b-${index}`}
            block={block}
            isLocked={isLocked}
            busyAction={busyAction}
            onAction={handleAction}
          />
        ))}
      </div>
      {card.status !== "active" && (
        <div className="mt-2.5 pt-2 border-t border-dl-border-hairline text-[11px] text-dl-text-tertiary">
          {card.status === "expired" ? "卡片已过期" : "卡片已失效"} · v{card.revision}
        </div>
      )}

      <Dialog
        open={Boolean(modalSpec)}
        onOpenChange={(open) => {
          if (!open) setModalSpec(null);
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{modalSpec?.title || "表单"}</DialogTitle>
          </DialogHeader>
        {modalSpec && (
          <form onSubmit={submitModal} className="space-y-3 p-6 pt-4">
            {modalSpec.fields.map((field) => (
              <div key={field.name} className="space-y-1.5">
                {field.kind === "switch" ? (
                  <div className="flex items-center justify-between py-1">
                    <span className="text-sm text-dl-text-primary">{field.label}</span>
                    <Switch
                      checked={Boolean(modalValues[field.name])}
                      onCheckedChange={(checked) =>
                        setModalValues((prev) => ({ ...prev, [field.name]: checked }))
                      }
                    />
                  </div>
                ) : field.kind === "select" ? (
                  <>
                    <label className="block text-xs font-medium text-dl-text-secondary">
                      {field.label}
                    </label>
                    <Select
                      value={String(modalValues[field.name] || "")}
                      onValueChange={(v) => setModalValues((prev) => ({ ...prev, [field.name]: v }))}
                      options={field.options || []}
                      placeholder={field.placeholder || "请选择"}
                    />
                  </>
                ) : (
                  <>
                    <label className="block text-xs font-medium text-dl-text-secondary">
                      {field.label}
                    </label>
                    <Input
                      value={String(modalValues[field.name] || "")}
                      onChange={(e) =>
                        setModalValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                      }
                      placeholder={field.placeholder}
                      required={field.required}
                    />
                  </>
                )}
              </div>
            ))}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setModalSpec(null)}>
                取消
              </Button>
              <Button type="submit" variant="primary" busy={busyAction === modalSpec.modalId}>
                {modalSpec.submitLabel || "提交"}
              </Button>
            </div>
          </form>
        )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CardBlockView({
  block,
  isLocked,
  busyAction,
  onAction,
}: {
  block: CardKitBlock;
  isLocked: boolean;
  busyAction: string | null;
  onAction: (actionId: string, payload?: Record<string, unknown>, opensModal?: boolean) => void;
}) {
  switch (block.type) {
    case "header":
      return <HeaderBlockView block={block} />;
    case "markdown":
      return (
        <div className="text-sm leading-relaxed text-dl-text-primary whitespace-pre-wrap">
          {block.content}
        </div>
      );
    case "fields":
      return <FieldsBlockView block={block} />;
    case "poll":
      return (
        <PollBlockView
          block={block}
          isLocked={isLocked}
          busyAction={busyAction}
          onAction={onAction}
        />
      );
    case "actions":
      return (
        <ActionsBlockView
          block={block}
          isLocked={isLocked}
          busyAction={busyAction}
          onAction={onAction}
        />
      );
    case "divider":
      return <div className="h-px bg-dl-border-hairline my-1" />;
    default:
      return null;
  }
}

function HeaderBlockView({ block }: { block: CardHeaderBlock }) {
  const tone = block.tone || "neutral";
  return (
    <div className="flex items-start justify-between gap-2">
      <div>
        <div className="text-sm font-semibold text-dl-text-primary">{block.title}</div>
        {block.subtitle && (
          <div className="text-xs text-dl-text-secondary mt-0.5">{block.subtitle}</div>
        )}
      </div>
      {block.badge && (
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            TONE_BADGE[tone]
          )}
        >
          {block.badge}
        </span>
      )}
    </div>
  );
}

function FieldsBlockView({ block }: { block: CardFieldsBlock }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 rounded-xl bg-dl-surface-subtle/60 p-2.5 border border-dl-border-hairline">
      {block.items.map((item, idx) => (
        <div key={idx} className={cn(!item.short && "col-span-2")}>
          <div className="text-[11px] font-medium text-dl-text-tertiary">{item.label}</div>
          <div className="text-xs font-medium text-dl-text-primary mt-0.5 break-words">
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function PollBlockView({
  block,
  isLocked,
  busyAction,
  onAction,
}: {
  block: CardPollBlock;
  isLocked: boolean;
  busyAction: string | null;
  onAction: (actionId: string, payload?: Record<string, unknown>) => void;
}) {
  const total = Math.max(1, block.totalVotes);
  return (
    <div className="space-y-1.5">
      {block.options.map((opt) => {
        const pct = block.totalVotes > 0 ? Math.round((opt.votes / total) * 100) : 0;
        return (
          <Button
            key={opt.id}
            variant="ghost"
            size="sm"
            disabled={isLocked || Boolean(block.closed) || busyAction !== null}
            onClick={() => onAction(`poll:${block.pollId}:${opt.id}`, { pollId: block.pollId, optionId: opt.id })}
            className={cn(
              "relative w-full justify-between overflow-hidden rounded-xl border px-3 py-2 text-left",
              opt.selected
                ? "border-dl-lane-shared bg-dl-lane-shared/10"
                : "border-dl-border-hairline bg-dl-surface-subtle/40"
            )}
          >
            <span
              className="absolute inset-y-0 left-0 bg-dl-lane-shared/15 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
            <span className="relative z-10 text-xs font-medium text-dl-text-primary">
              {opt.selected ? "✓ " : ""}
              {opt.label}
            </span>
            <span className="relative z-10 text-[11px] tabular-nums text-dl-text-secondary">
              {opt.votes} ({pct}%)
            </span>
          </Button>
        );
      })}
      <div className="text-[11px] text-dl-text-tertiary">
        共 {block.totalVotes} 票{block.closed ? " · 已结束" : ""}
      </div>
    </div>
  );
}

function ActionsBlockView({
  block,
  isLocked,
  busyAction,
  onAction,
}: {
  block: CardActionsBlock;
  isLocked: boolean;
  busyAction: string | null;
  onAction: (actionId: string, payload?: Record<string, unknown>, opensModal?: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-0.5">
      {block.elements.map((el) => {
        if (el.type === "select") {
          return (
            <div key={el.actionId} className="min-w-[140px]">
              <Select
                value={el.value || ""}
                disabled={isLocked || el.disabled}
                placeholder={el.placeholder || "选择操作"}
                options={el.options}
                onValueChange={(val) => onAction(el.actionId, { value: val })}
              />
            </div>
          );
        }
        const variant =
          el.style === "primary"
            ? "primary"
            : el.style === "danger"
            ? "danger"
            : "secondary";
        return (
          <Button
            key={el.actionId}
            variant={variant}
            size="sm"
            disabled={isLocked || el.disabled}
            busy={busyAction === el.actionId}
            onClick={() => onAction(el.actionId, el.payload, el.opensModal)}
          >
            {el.label}
          </Button>
        );
      })}
    </div>
  );
}
