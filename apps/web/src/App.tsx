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
import type { RefObject } from "react";

type Lane = "entry" | "p2p" | "workspace";
type P2pStep = "name" | "waiting" | "chat" | "ended";
type ConnectionState = "idle" | "connecting" | "connected" | "offline" | "error";
type CopyState = "idle" | "copied" | "failed";
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
type ApiMessage = {
  id: string;
  authorName?: string;
  body: string;
  createdAt?: string;
};
type ApiConversation = {
  id: string;
  title?: string;
  name?: string;
  type: "direct" | "group";
  messageCount?: number;
  last?: string;
  messages?: ApiMessage[];
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
type Peer = {
  id: string;
  name: string;
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
  return `${prefix}-${randomId()}`;
}

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const values = new Uint32Array(4);
    crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || "Request failed"}`);
  }
  return (await response.json()) as T;
}

function getWsUrl(roomId: string, name: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ name });
  return `${protocol}//${window.location.host}/ws/p2p/${encodeURIComponent(roomId)}?${query}`;
}

function getInviteLink(roomId: string) {
  return `${window.location.origin}/?lane=p2p&room=${encodeURIComponent(roomId)}`;
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall back to the legacy path below for LAN HTTP browsers.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function getO2OState(peerCount: number, socketState: ConnectionState): ConnectionState {
  if (socketState === "error" || socketState === "connecting") {
    return socketState;
  }
  if (peerCount >= 2) {
    return "connected";
  }
  if (socketState === "offline") {
    return "offline";
  }
  return "idle";
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
  const [p2pPeers, setP2pPeers] = useState<Peer[]>([]);
  const [p2pSocketState, setP2pSocketState] = useState<ConnectionState>("idle");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const wsRef = useRef<WebSocket | null>(null);
  const p2pMessageListRef = useRef<HTMLDivElement | null>(null);
  const workspaceMessageListRef = useRef<HTMLDivElement | null>(null);

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
  const p2pConnectionState = getO2OState(p2pPeers.length, p2pSocketState);

  useEffect(() => {
    p2pMessageListRef.current?.scrollTo({
      top: p2pMessageListRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [p2pMessages.length]);

  useEffect(() => {
    workspaceMessageListRef.current?.scrollTo({
      top: workspaceMessageListRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [workspaceMessages.length]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const incomingRoomId = params.get("room");
    if (params.get("lane") !== "p2p" || !incomingRoomId) {
      return;
    }

    setLane("p2p");
    setP2pStep("name");
    setRoomId(incomingRoomId);
    setInviteLink(getInviteLink(incomingRoomId));
  }, []);

  useEffect(() => {
    if (p2pStep !== "chat" || !roomId) {
      return;
    }

    setP2pSocketState("connecting");
    setP2pError("");
    const socket = new WebSocket(getWsUrl(roomId, displayName.trim() || "Guest"));
    wsRef.current = socket;

    socket.addEventListener("open", () => {
      setP2pSocketState("connected");
    });

    socket.addEventListener("message", (event) => {
      const incoming = parsePeerMessage(event.data);
      if (incoming?.peers) {
        setP2pPeers(incoming.peers);
      }
      if (!incoming) {
        return;
      }
      const body = incoming.body;
      if (!body) {
        return;
      }
      setP2pMessages((messages) => [
        ...messages,
        {
          id: makeId("p2p"),
          author: incoming.author,
          body,
          lane: "p2p",
          at: nowLabel()
        }
      ]);
    });

    socket.addEventListener("close", () => {
      setP2pSocketState((status) => (status === "connecting" ? "offline" : status));
      setP2pPeers([]);
    });

    socket.addEventListener("error", () => {
      setP2pSocketState("error");
      setP2pError("Realtime signaling is not available yet. You can still review the local UI flow.");
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
    setP2pSocketState("idle");
    setP2pError("");
    setSessionSaved("idle");

    if (roomId) {
      setInviteLink(getInviteLink(roomId));
      setP2pStatus("idle");
      setP2pStep("chat");
      return;
    }

    try {
      const data = await fetch("/api/p2p/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name })
      }).then((response) => parseJson<{ roomId?: string; id?: string; inviteLink?: string }>(response));
      const nextRoomId = data.roomId ?? data.id ?? randomId().slice(0, 8);
      setRoomId(nextRoomId);
      setInviteLink(getInviteLink(nextRoomId));
    } catch (error) {
      const nextRoomId = randomId().slice(0, 8);
      setRoomId(nextRoomId);
      setInviteLink(getInviteLink(nextRoomId));
      setP2pError(error instanceof Error ? `Room API unavailable: ${error.message}` : "Room API unavailable.");
    } finally {
      setP2pStatus("idle");
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
      wsRef.current.send(JSON.stringify({ type: "message", body }));
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
        parseJson<{ conversations?: ApiConversation[] } | ApiConversation[]>(response)
      );
      const nextConversations = Array.isArray(data) ? data : data.conversations;
      if (nextConversations?.length) {
        const mappedConversations = nextConversations.map(mapApiConversation);
        setConversations(mappedConversations);
        setActiveConversation(mappedConversations[0].id);
        setWorkspaceMessages(mapApiMessages(nextConversations[0].messages ?? []));
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
    setP2pPeers([]);
    setP2pSocketState("idle");
    setCopyState("idle");
    setRoomId("");
    setInviteLink("");
  }

  async function copyInviteLink() {
    const didCopy = await copyText(inviteLink);
    setCopyState(didCopy ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
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
              <h2 id="p2p-title">{roomId ? "Join a private direct session." : "Start a private direct session."}</h2>
              <p className="quiet">
                {roomId
                  ? `Enter a display name to join room ${roomId}.`
                  : "Your display name is only shown to the peer in this local session."}
              </p>
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
                  {roomId ? <MessageSquare size={18} /> : <Plus size={18} />}
                  {roomId ? "Join session" : "Start session"}
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
              <p className="quiet">Room ID {roomId}. Copy the link first, then enter the chat when you are ready.</p>
              <div className="copy-box">
                <span>{inviteLink}</span>
                <button
                  className="icon-button"
                  type="button"
                  title="Copy invite link"
                  onClick={() => void copyInviteLink()}
                >
                  <Clipboard size={18} />
                </button>
              </div>
              <div className="action-row">
                <button className="primary direct-button" type="button" onClick={() => setP2pStep("chat")}>
                  <MessageSquare size={18} />
                  Enter chat
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => void copyInviteLink()}
                >
                  <Clipboard size={18} />
                  {copyState === "copied" ? "Copied" : "Copy link"}
                </button>
              </div>
              <StatusPill state={p2pStatus} fallbackText="Ready to share" />
              {copyState === "failed" && <InlineNotice tone="warning" text="Copy failed. Select the link text manually." />}
              {p2pError && <InlineNotice tone="warning" text={p2pError} />}
            </div>
          )}

          {p2pStep === "chat" && (
            <ChatPanel
              title="Direct session"
              subtitle={`Room ${roomId || "local"}`}
              trustText="No server-side content storage"
              shareLink={inviteLink}
              onCopyShare={copyInviteLink}
              copyState={copyState}
              status={<StatusPill state={p2pConnectionState} fallbackText="Waiting for peer" />}
              messages={p2pMessages}
              messageListRef={p2pMessageListRef}
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
              messageListRef={workspaceMessageListRef}
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

function parsePeerMessage(raw: unknown): { author: string; body?: string; peers?: Peer[] } | null {
  if (typeof raw !== "string") {
    return { author: "Peer", body: "Received a binary signaling payload." };
  }

  try {
    const parsed = JSON.parse(raw) as {
      type?: string;
      event?: string;
      body?: string;
      from?: { name?: string };
      peer?: { name?: string };
      peers?: Peer[];
    };

    if (parsed.type === "system") {
      const peerName = parsed.peer?.name ?? "Peer";
      if (parsed.event === "joined") {
        return {
          author: "System",
          body: `${peerName} joined the room.`,
          peers: parsed.peers
        };
      }
      if (parsed.event === "peer-joined") {
        return {
          author: "System",
          body: `${peerName} joined the room.`,
          peers: parsed.peers
        };
      }
      if (parsed.event === "peer-left") {
        return {
          author: "System",
          body: `${peerName} left the room.`,
          peers: parsed.peers
        };
      }
      if (parsed.event === "peer-list") {
        return {
          author: "System",
          peers: parsed.peers
        };
      }
      return parsed.event ? { author: "System", body: parsed.event, peers: parsed.peers } : null;
    }

    if (typeof parsed.body === "string" && parsed.body.trim()) {
      return {
        author: parsed.from?.name ?? "Peer",
        body: parsed.body
      };
    }

    return null;
  } catch {
    return { author: "Peer", body: raw };
  }
}

function mapApiConversation(conversation: ApiConversation): Conversation {
  const latestMessage = conversation.messages?.at(-1);
  return {
    id: conversation.id,
    name: conversation.title ?? conversation.name ?? "Conversation",
    type: conversation.type,
    unread: 0,
    last: latestMessage?.body ?? conversation.last ?? `${conversation.messageCount ?? 0} retained messages`
  };
}

function mapApiMessages(messages: ApiMessage[]): Message[] {
  if (!messages.length) {
    return initialWorkspaceMessages;
  }

  return messages.map((message) => ({
    id: message.id,
    author: message.authorName ?? "Workspace user",
    body: message.body,
    lane: "workspace",
    at: message.createdAt ? nowLabelFromDate(message.createdAt) : nowLabel()
  }));
}

function nowLabelFromDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return nowLabel();
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
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
    connected: "Peer online",
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
  shareLink,
  onCopyShare,
  copyState,
  status,
  messages,
  messageListRef,
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
  shareLink?: string;
  onCopyShare?: () => void;
  copyState?: CopyState;
  status: React.ReactNode;
  messages: Message[];
  messageListRef?: RefObject<HTMLDivElement | null>;
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
      {shareLink && (
        <div className="share-block">
          <div className="share-strip">
            <div className="share-meta">
              <Link2 size={16} />
              <span>Invite</span>
            </div>
            <span className="share-link-text">{shareLink}</span>
            <button
              className="secondary compact"
              type="button"
              title="Copy invite link"
              onClick={onCopyShare}
            >
              <Clipboard size={16} />
              {copyState === "copied" ? "Copied" : "Copy"}
            </button>
          </div>
          {copyState === "failed" && <p className="copy-fallback">Copy failed. Select the link manually.</p>}
        </div>
      )}
      <div className="message-list" ref={messageListRef} aria-live="polite">
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
