import { useEffect, useRef } from "react";
import { WorkspaceAvatar } from "../../WorkspaceAvatar";
import type { ConversationMentionMember } from "./contracts";

export function WorkspaceBotBadge({ kind }: { kind?: ConversationMentionMember["kind"] }) {
  if (kind !== "bot") {
    return null;
  }
  return <span className="workspace-bot-badge" aria-label="官方机器人">BOT</span>;
}

export function WorkspaceIdentityName({ name, kind }: { name: string; kind?: ConversationMentionMember["kind"] }) {
  return (
    <span className="workspace-identity-name">
      <span>{name}</span>
      <WorkspaceBotBadge kind={kind} />
    </span>
  );
}

export function MentionPicker<TMember extends ConversationMentionMember>({
  id,
  members,
  activeIndex = -1,
  onSelect,
  onEscape
}: {
  id?: string;
  members: TMember[];
  activeIndex?: number;
  onSelect: (member: TMember) => void;
  onEscape?: () => void;
}) {
  const pickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeIndex < 0) return;
    pickerRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      ref={pickerRef}
      className="mention-picker"
      id={id}
      role="dialog"
      aria-label="提及成员"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onEscape?.();
        }
      }}
    >
      {members.length === 0 ? (
        <p className="saved-empty">没有可提及的成员。</p>
      ) : (
        members.map((member, index) => (
          <button
            className={index === activeIndex ? "mention-row active" : "mention-row"}
            type="button"
            key={member.id}
            data-mention-index={index}
            aria-current={index === activeIndex ? "true" : undefined}
            onClick={() => onSelect(member)}
          >
            <WorkspaceAvatar name={member.displayName} avatarUrl={member.avatarUrl} className="small" decorative />
            <span>
              <strong><WorkspaceIdentityName name={member.displayName} kind={member.kind} /></strong>
              <small>{member.secondaryText || (member.githubLogin ? `@${member.githubLogin}` : "")}</small>
            </span>
          </button>
        ))
      )}
    </div>
  );
}
