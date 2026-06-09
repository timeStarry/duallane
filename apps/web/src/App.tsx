import {
  AlertCircle,
  ArrowLeft,
  Check,
  Clipboard,
  FileUp,
  Github,
  KeyRound,
  Link2,
  LockKeyhole,
  LogOut,
  MessageSquare,
  Plus,
  Radio,
  Save,
  Search,
  Send,
  ShieldCheck,
  ShieldHalf,
  UsersRound,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Lane = "entry" | "p2p" | "workspace";
type P2pStep = "name" | "waiting" | "chat" | "ended";
type ConnectionState = "idle" | "connecting" | "connected" | "offline" | "error";
type Message = {
  id: string;
  author: string;
  body: string;
  lane: "p2p" | "workspace";
  at: string;
  self?: boolean;
  fileName?: string;
};
type Conversation = {
  id: string;
  name: string;
  type: "direct" | "group";
  unread: number;
  last: string;
};
type WorkspaceUser = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member" | "auditor";
  status: "online" | "away" | "offline";
};
type AuditEvent = {
  id: string;
  action: string;
  actor: string;
  result: "success" | "rejected" | "failure";
  at: string;
};

const workspaceUsers: WorkspaceUser[] = [
  { id: "u-001", name: "Mira Chen", role: "owner", status: "online" },
  { id: "u-014", name: "Jon Bell", role: "admin", status: "away" },
  { id: "u-027", name: "Nadia Ali", role: "member", status: "online" },
  { id: "u-030", name: "Theo Park", role: "auditor", status: "offline" }
];

const fallbackConversations: Conversation[] = [
  { id: "ops", name: "Operations", type: "group", unread: 2, last: "Quota review finished" },
  { id: "mira", name: "Mira Chen", type: "direct", unread: 0, last: "Invite accepted" },
  { id: "handoff", name: "Incident handoff", type: "group", unread: 0, last: "Audit export attached" }
];

const fallbackAudit: AuditEvent[] = [
  { id: "a-1", action: "invite.created", actor: "Mira Chen", result: "success", at: "09:42" },
  { id: "a-2", action: "file.quota_checked", actor: "Jon Bell", result: "success", at: "10:16" },
  { id: "a-3", action: "download.rejected", actor: "Nadia Ali", result: "rejected", at: "10:31" }
];

const initialWorkspaceMessages: Message[] = [
  {
    id: "w-1",
    author: "Mira Chen",
    body: "GitHub invite gate is enabled. New members need accepted invites before workspace access.",
    lane: "workspace",
    at: "09:44"
  },
  {
    id: "w-2",
    author: "Jon Bell",
    body: "Daily transfer quota is tracking uploads and downloads together.",
    lane: "workspace",
    at: "10:18",
    fileName: "quota-ledger.csv"
  }
];

function nowLabel() {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || "Request failed"}`);
  }
  return (await response.json()) as T;
}

function getWsUrl(roomId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/p2p/${encodeURIComponent(roomId)}`;
}

export function App() {
  const [lane, setLane] = useState<Lane>("entry");
  const [p2pStep, setP2pStep] = useState<P2pStep>("name");
  const [displayName, setDisplayName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [p2pStatus, setP2pStatus] = useState<ConnectionState>("idle");
  const [p2pError, setP2pError] = useState("");
  const [p2pMessages, setP2pMessages] = useState<Message[]>([]);
  const [p2pDraft, setP2pDraft] = useState("");
  const [sessionSaved, setSessionSaved] = useState<"idle" | "saved" | "discarded">("idle");
  const wsRef = useRef<WebSocket | null>(null);

  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>(fallbackConversations);
  const [activeConversation, setActiveConversation] = useState(fallbackConversations[0].id);
  const [workspaceMessages, setWorkspaceMessages] = useState<Message[]>(initialWorkspaceMessages);
  const [workspaceDraft, setWorkspaceDraft] = useState("");

  const activeConversationName = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversation)?.name ?? "Conversation",
    [activeConversation, conversations]
  );

  useEffect(() => {
    if (p2pStep !== "waiting" || !roomId) {
      return;
    }

    setP2pStatus("connecting");
    setP2pError("");
    const socket = new WebSocket(getWsUrl(roomId));
    wsRef.current = socket;

    socket.addEventListener("open", () => {
      setP2pStatus("connected");
      setP2pStep("chat");
    });

    socket.addEventListener("message", (event) => {
      const body = typeof event.data === "string" ? event.data : "Received a binary signaling payload.";
      setP2pMessages((messages) => [
        ...messages,
        {
          id: makeId("p2p"),
          author: "Peer",
          body,
          lane: "p2p",
          at: nowLabel()
        }
      ]);
    });

    socket.addEventListener("close", () => {
      setP2pStatus((status) => (status === "connecting" ? "offline" : status));
    });

    socket.addEventListener("error", () => {
      setP2pStatus("error");
      setP2pError("Realtime signaling is not available yet. You can still review the local UI flow.");
      setP2pStep("chat");
    });

    return () => {
      socket.close();
      wsRef.current = null;
    };
  }, [p2pStep, roomId]);

  async function createP2pRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = displayName.trim();
    if (!name) {
      return;
    }

    setP2pStatus("connecting");
    setP2pError("");
    setSessionSaved("idle");

    try {
      const data = await fetch("/api/p2p/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name })
      }).then((response) => parseJson<{ roomId?: string; id?: string; inviteLink?: string }>(response));
      const nextRoomId = data.roomId ?? data.id ?? crypto.randomUUID().slice(0, 8);
      setRoomId(nextRoomId);
      setInviteLink(data.inviteLink ?? `${window.location.origin}/?p2p=${encodeURIComponent(nextRoomId)}`);
    } catch (error) {
      const nextRoomId = crypto.randomUUID().slice(0, 8);
      setRoomId(nextRoomId);
      setInviteLink(`${window.location.origin}/?p2p=${encodeURIComponent(nextRoomId)}`);
      setP2pError(error instanceof Error ? `Room API unavailable: ${error.message}` : "Room API unavailable.");
    } finally {
      setP2pStep("waiting");
    }
  }

  function sendP2pMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = p2pDraft.trim();
    if (!body) {
      return;
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(body);
    }

    setP2pMessages((messages) => [
      ...messages,
      {
        id: makeId("p2p"),
        author: displayName.trim() || "You",
        body,
        lane: "p2p",
        at: nowLabel(),
        self: true
      }
    ]);
    setP2pDraft("");
  }

  function addP2pFile(fileName: string) {
    setP2pMessages((messages) => [
      ...messages,
      {
        id: makeId("p2p"),
        author: displayName.trim() || "You",
        body: "Selected for local peer transfer.",
        lane: "p2p",
        at: nowLabel(),
        self: true,
        fileName
      }
    ]);
  }

  async function openWorkspace() {
    setLane("workspace");
    setWorkspaceLoading(true);
    setWorkspaceError("");

    try {
      await fetch("/api/workspace/bootstrap").then((response) =>
        parseJson<{ user?: unknown; inviteOnly?: boolean }>(response)
      );
      setWorkspaceReady(true);
    } catch (error) {
      setWorkspaceError(
        error instanceof Error
          ? `Workspace bootstrap unavailable: ${error.message}`
          : "Workspace bootstrap unavailable."
      );
      setWorkspaceReady(false);
    }

    try {
      const data = await fetch("/api/workspace/conversations").then((response) =>
        parseJson<{ conversations?: Conversation[] } | Conversation[]>(response)
      );
      const nextConversations = Array.isArray(data) ? data : data.conversations;
      if (nextConversations?.length) {
        setConversations(nextConversations);
        setActiveConversation(nextConversations[0].id);
      }
    } catch {
      setConversations(fallbackConversations);
    } finally {
      setWorkspaceLoading(false);
    }
  }

  function sendWorkspaceMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = workspaceDraft.trim();
    if (!body) {
      return;
    }

    setWorkspaceMessages((messages) => [
      ...messages,
      {
        id: makeId("workspace"),
        author: "You",
        body,
        lane: "workspace",
        at: nowLabel(),
        self: true
      }
    ]);
    setWorkspaceDraft("");
  }

  function resetToEntry() {
    wsRef.current?.close();
    setLane("entry");
    setP2pStep("name");
    setP2pStatus("idle");
    setP2pError("");
    setP2pMessages([]);
    setP2pDraft("");
  }

  return (
    <main className="shell">
      {lane === "entry" && (
        <section className="entry" aria-labelledby="entry-title">
          <div className="entry-heading">
            <p className="eyebrow">DualLane</p>
            <h1 id="entry-title">Choose the lane before the conversation starts.</h1>
          </div>
          <div className="lane-grid" aria-label="Communication lanes">
            <button className="lane-choice direct-choice" type="button" onClick={() => setLane("p2p")}>
              <span className="lane-icon" aria-hidden="true">
                <LockKeyhole size={28} />
              </span>
              <strong>One-to-One Direct</strong>
              <span>No login. Signaling only. The server does not store conversation content.</span>
            </button>
            <button className="lane-choice workspace-choice" type="button" onClick={openWorkspace}>
              <span className="lane-icon" aria-hidden="true">
                <ShieldCheck size={28} />
              </span>
              <strong>Workspace</strong>
              <span>Invite-only relay lane with GitHub login, retention, quotas, and audit logs.</span>
            </button>
          </div>
        </section>
      )}

      {lane === "p2p" && (
        <section className="lane-surface" aria-labelledby="p2p-title">
          <TopBar
            label="P2P private lane"
            title="One-to-One Direct"
            icon={<LockKeyhole size={18} />}
            onBack={resetToEntry}
          />

          {p2pStep === "name" && (
            <div className="single-action">
              <div className="center-icon direct-bg" aria-hidden="true">
                <Radio size={30} />
              </div>
              <p className="eyebrow">No account required</p>
              <h2 id="p2p-title">Start a private direct session.</h2>
              <p className="quiet">Your display name is only shown to the peer in this local session.</p>
              <form className="stack-form" onSubmit={createP2pRoom}>
                <label>
                  <span>Display name</span>
                  <input
                    autoFocus
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    maxLength={40}
                    placeholder="Alex"
                  />
                </label>
                <button className="primary direct-button" type="submit" disabled={!displayName.trim()}>
                  <Plus size={18} />
                  Start session
                </button>
              </form>
            </div>
          )}

          {p2pStep === "waiting" && (
            <div className="single-action">
              <div className="center-icon direct-bg" aria-hidden="true">
                <Link2 size={30} />
              </div>
              <p className="eyebrow">Room ready</p>
              <h2>Share this invite link.</h2>
              <p className="quiet">Room ID {roomId}. Waiting for peer signaling.</p>
              <div className="copy-box">
                <span>{inviteLink}</span>
                <button
                  className="icon-button"
                  type="button"
                  title="Copy invite link"
                  onClick={() => void navigator.clipboard?.writeText(inviteLink)}
                >
                  <Clipboard size={18} />
                </button>
              </div>
              <StatusPill state={p2pStatus} fallbackText="Connecting to signaling" />
              {p2pError && <InlineNotice tone="warning" text={p2pError} />}
            </div>
          )}

          {p2pStep === "chat" && (
            <ChatPanel
              title="Direct session"
              subtitle={`Room ${roomId || "local"}`}
              trustText="No server-side content storage"
              status={<StatusPill state={p2pStatus} fallbackText="Local preview mode" />}
              messages={p2pMessages}
              draft={p2pDraft}
              onDraft={setP2pDraft}
              onSend={sendP2pMessage}
              onFile={addP2pFile}
              onEnd={() => {
                wsRef.current?.close();
                setP2pStep("ended");
              }}
              fileLabel="Select file"
            />
          )}

          {p2pStep === "ended" && (
            <div className="single-action">
              <div className="center-icon ended-bg" aria-hidden="true">
                <Check size={30} />
              </div>
              <p className="eyebrow">Session closed</p>
              <h2>This session has ended.</h2>
              <p className="quiet">Keep the transcript only in this browser, or discard local state now.</p>
              <div className="action-row">
                <button
                  className="primary direct-button"
                  type="button"
                  onClick={() => {
                    localStorage.setItem(`duallane-p2p-${roomId}`, JSON.stringify(p2pMessages));
                    setSessionSaved("saved");
                  }}
                >
                  <Save size={18} />
                  Save locally
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    setP2pMessages([]);
                    setSessionSaved("discarded");
                  }}
                >
                  <X size={18} />
                  Close without saving
                </button>
              </div>
              {sessionSaved === "saved" && <InlineNotice tone="success" text="Saved to local browser storage." />}
              {sessionSaved === "discarded" && <InlineNotice tone="warning" text="Local session state discarded." />}
            </div>
          )}
        </section>
      )}

      {lane === "workspace" && (
        <section className="workspace-shell" aria-labelledby="workspace-title">
          <TopBar
            label="Audited relay lane"
            title="Workspace"
            icon={<ShieldHalf size={18} />}
            onBack={resetToEntry}
          />
          <div className="workspace-status">
            <span>
              <KeyRound size={16} />
              Invite-only
            </span>
            <span>
              <Github size={16} />
              GitHub login required
            </span>
            <span>
              <ShieldCheck size={16} />
              RBAC and audit logs
            </span>
          </div>
          {workspaceLoading && <InlineNotice tone="info" text="Checking workspace bootstrap and conversations..." />}
          {workspaceError && <InlineNotice tone="warning" text={`${workspaceError} Showing local preview data.`} />}

          <div className="workspace-grid">
            <aside className="sidebar" aria-label="Workspace navigation">
              <div className="search-field">
                <Search size={16} />
                <input placeholder="Find conversation" aria-label="Find conversation" />
              </div>
              <div className="section-title">
                <span>Conversations</span>
                <button className="icon-button" type="button" title="Start conversation">
                  <Plus size={16} />
                </button>
              </div>
              <div className="conversation-list">
                {conversations.map((conversation) => (
                  <button
                    className={conversation.id === activeConversation ? "conversation active" : "conversation"}
                    key={conversation.id}
                    type="button"
                    onClick={() => setActiveConversation(conversation.id)}
                  >
                    <span className="conversation-icon" aria-hidden="true">
                      {conversation.type === "group" ? <UsersRound size={17} /> : <MessageSquare size={17} />}
                    </span>
                    <span>
                      <strong>{conversation.name}</strong>
                      <small>{conversation.last}</small>
                    </span>
                    {conversation.unread > 0 && <em>{conversation.unread}</em>}
                  </button>
                ))}
              </div>
              <div className="member-list">
                <div className="section-title">
                  <span>Users</span>
                </div>
                {workspaceUsers.map((user) => (
                  <div className="member" key={user.id}>
                    <span className={`presence ${user.status}`} aria-hidden="true" />
                    <span>
                      <strong>{user.name}</strong>
                      <small>{user.role}</small>
                    </span>
                  </div>
                ))}
              </div>
            </aside>

            <ChatPanel
              title={activeConversationName}
              subtitle={workspaceReady ? "Authenticated workspace" : "Preview until backend is ready"}
              trustText="Server-retained messages and files"
              status={<StatusPill state={workspaceReady ? "connected" : "offline"} fallbackText="Invite gate pending" />}
              messages={workspaceMessages}
              draft={workspaceDraft}
              onDraft={setWorkspaceDraft}
              onSend={sendWorkspaceMessage}
              onFile={(fileName) =>
                setWorkspaceMessages((messages) => [
                  ...messages,
                  {
                    id: makeId("workspace"),
                    author: "You",
                    body: "Queued for relay upload and quota check.",
                    lane: "workspace",
                    at: nowLabel(),
                    self: true,
                    fileName
                  }
                ])
              }
              fileLabel="Attach file"
            />

            <aside className="audit-panel" aria-label="Admin and audit">
              <div className="admin-strip">
                <strong>Admin</strong>
                <span>2 GiB daily transfer quota</span>
              </div>
              <div className="metric-grid">
                <div>
                  <strong>10k</strong>
                  <span>message retention</span>
                </div>
                <div>
                  <strong>4</strong>
                  <span>roles active</span>
                </div>
              </div>
              <div className="section-title">
                <span>Audit</span>
              </div>
              <div className="audit-list">
                {fallbackAudit.map((event) => (
                  <div className="audit-row" key={event.id}>
                    <span className={`audit-dot ${event.result}`} aria-hidden="true" />
                    <span>
                      <strong>{event.action}</strong>
                      <small>
                        {event.actor} at {event.at}
                      </small>
                    </span>
                    <em>{event.result}</em>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </section>
      )}
    </main>
  );
}

function TopBar({
  label,
  title,
  icon,
  onBack
}: {
  label: string;
  title: string;
  icon: React.ReactNode;
  onBack: () => void;
}) {
  return (
    <header className="topbar">
      <button className="icon-button" type="button" onClick={onBack} title="Back to lanes">
        <ArrowLeft size={18} />
      </button>
      <div className="topbar-title">
        <span>
          {icon}
          {label}
        </span>
        <h1>{title}</h1>
      </div>
    </header>
  );
}

function StatusPill({ state, fallbackText }: { state: ConnectionState; fallbackText: string }) {
  const labels: Record<ConnectionState, string> = {
    idle: fallbackText,
    connecting: "Connecting",
    connected: "Connected",
    offline: fallbackText,
    error: "Limited mode"
  };

  return <span className={`status-pill ${state}`}>{labels[state]}</span>;
}

function InlineNotice({ tone, text }: { tone: "info" | "success" | "warning"; text: string }) {
  return (
    <p className={`notice ${tone}`}>
      {tone === "warning" ? <AlertCircle size={16} /> : <Check size={16} />}
      {text}
    </p>
  );
}

function ChatPanel({
  title,
  subtitle,
  trustText,
  status,
  messages,
  draft,
  onDraft,
  onSend,
  onFile,
  onEnd,
  fileLabel
}: {
  title: string;
  subtitle: string;
  trustText: string;
  status: React.ReactNode;
  messages: Message[];
  draft: string;
  onDraft: (value: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  onFile: (fileName: string) => void;
  onEnd?: () => void;
  fileLabel: string;
}) {
  return (
    <section className="chat-panel" aria-label={title}>
      <header className="chat-header">
        <div>
          <p className="eyebrow">{subtitle}</p>
          <h2>{title}</h2>
        </div>
        <div className="chat-status">
          {status}
          {onEnd && (
            <button className="secondary compact" type="button" onClick={onEnd}>
              <LogOut size={16} />
              End
            </button>
          )}
        </div>
      </header>
      <div className="trust-strip">
        <ShieldCheck size={16} />
        <span>{trustText}</span>
      </div>
      <div className="message-list" aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty-state">
            <MessageSquare size={26} />
            <span>No messages yet.</span>
          </div>
        ) : (
          messages.map((message) => (
            <article className={message.self ? "message self" : "message"} key={message.id}>
              <div className="message-meta">
                <strong>{message.author}</strong>
                <span>{message.at}</span>
              </div>
              <p>{message.body}</p>
              {message.fileName && (
                <span className="file-chip">
                  <FileUp size={14} />
                  {message.fileName}
                </span>
              )}
            </article>
          ))
        )}
      </div>
      <form className="composer" onSubmit={onSend}>
        <label className="file-button">
          <FileUp size={17} />
          <span>{fileLabel}</span>
          <input
            type="file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) {
                onFile(file.name);
                event.currentTarget.value = "";
              }
            }}
          />
        </label>
        <input
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="Write a message"
          aria-label="Write a message"
        />
        <button className="primary send-button" type="submit" disabled={!draft.trim()} title="Send message">
          <Send size={18} />
          <span>Send</span>
        </button>
      </form>
    </section>
  );
}
