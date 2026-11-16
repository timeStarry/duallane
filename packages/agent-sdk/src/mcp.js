import fs from "node:fs";
import path from "node:path";
import {
  DualLaneAgentClient,
  DualLaneAgentError,
  DualLaneAgentSetupClient,
  DUALLANE_AGENT_SDK_VERSION,
  inferMimeTypeFromFileName,
} from "./index.js";
import {
  clearPendingSetup,
  DEFAULT_SETUP_SCOPES,
  deleteAgentProfile,
  loadAgentProfile,
  loadPendingSetup,
  normalizeProfileName,
  parseSetupTarget,
  sanitizeSetupClientName,
  saveAgentProfile,
  savePendingSetup,
  updateProfileCursor,
} from "./profile-store.js";

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const DEFAULT_MCP_PROTOCOL_VERSION = "2024-11-05";
const ALLOWED_CARD_ACTIONS = new Set(["confirm", "cancel", "submit", "refresh"]);

export const DUALLANE_MCP_TOOLS = [
  {
    name: "duallane_setup_start",
    description:
      "Start one-time interactive pairing between this AI Agent and a DualLane Bot using the user's setup URL (?setup=setup_...). Returns the approval URL for the user to click in their browser. Never requires manual token copy-paste.",
    inputSchema: {
      type: "object",
      properties: {
        setupUrl: {
          type: "string",
          description: "The DualLane setup URL (e.g. https://.../workspace?setup=setup_xxx) provided by the user.",
        },
        url: {
          type: "string",
          description: "Optional DualLane base URL if setupUrl is a bare setup_<id>.",
        },
        profile: {
          type: "string",
          description: "Local credential profile name (default: 'default').",
        },
        clientName: {
          type: "string",
          description: "Human-readable name of this Agent runtime shown on the user's approval screen (e.g. 'Claude Code', 'Codex', 'Cursor', 'Antigravity').",
        },
        requestedScopes: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of Bot Gateway scopes to request.",
        },
      },
      required: ["setupUrl"],
    },
  },
  {
    name: "duallane_setup_finish",
    description:
      "Poll an initiated DualLane setup session until the user approves it in their browser, exchange the session once for a Bot token, and store it securely in ~/.config/duallane/agents/<profile>.json (0600).",
    inputSchema: {
      type: "object",
      properties: {
        setupUrl: {
          type: "string",
          description: "Optional DualLane setup URL or setup_<id> (defaults to the most recent pending session for this profile).",
        },
        url: {
          type: "string",
          description: "Optional DualLane base URL when setupUrl is a bare setup_<id>.",
        },
        profile: {
          type: "string",
          description: "Local credential profile name (default: 'default').",
        },
        waitSeconds: {
          type: "integer",
          minimum: 0,
          maximum: 180,
          description: "How many seconds to wait/poll for user browser approval before returning (default: 45).",
        },
      },
    },
  },
  {
    name: "duallane_status",
    description:
      "Check DualLane Bot connection status, identity, granted scopes, and authorized conversations for the active profile.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
    },
  },
  {
    name: "duallane_list_conversations",
    description:
      "List all DualLane direct and group conversations this Bot belongs to, including whether sending, trigger delivery, and context reading are enabled.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
    },
  },
  {
    name: "duallane_get_context",
    description:
      "Read recent authorized messages from a DualLane conversation (requires messages:read_context scope and an active context grant from the conversation owner).",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Target DualLane conversation ID (conv_...)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max messages to fetch (default: 30)." },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "duallane_send_message",
    description: "Send a text / Markdown message to an authorized DualLane conversation.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Target DualLane conversation ID (conv_...)." },
        text: { type: "string", description: "Message text (supports Markdown)." },
        replyToMessageId: { type: "string", description: "Optional message ID (msg_...) to reply to." },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["conversationId", "text"],
    },
  },
  {
    name: "duallane_edit_message",
    description:
      "Edit a message previously sent by this Bot in DualLane (useful for live progress updates and streaming final answers).",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID (msg_...) previously returned by duallane_send_message." },
        plainText: { type: "string", description: "Updated message text." },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["messageId", "plainText"],
    },
  },
  {
    name: "duallane_send_file",
    description:
      "Upload and send a generated file or image (from a local filePath, UTF-8 contentText, or base64 contentBase64) directly to an authorized DualLane conversation.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Target DualLane conversation ID (conv_...)." },
        filePath: { type: "string", description: "Local path to the file to upload (provide filePath, contentText, or contentBase64)." },
        contentText: { type: "string", description: "Inline UTF-8 file text when generating text/markdown/csv/svg/code without writing to disk." },
        contentBase64: { type: "string", description: "Inline Base64-encoded binary payload when sending generated images/PDFs/ZIPs directly." },
        fileName: { type: "string", description: "File name shown in DualLane (inferred from filePath if omitted, e.g. 'report.md' or 'chart.png')." },
        mimeType: { type: "string", description: "Optional MIME type (auto-inferred from fileName extension if omitted)." },
        text: { type: "string", description: "Optional caption / message text sent together with the file." },
        replyToMessageId: { type: "string", description: "Optional message ID (msg_...) to reply to." },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "duallane_send_card",
    description:
      "Send an interactive approval/notification card to a DualLane conversation with optional action buttons (confirm, cancel, submit, refresh).",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Target DualLane conversation ID (conv_...)." },
        title: { type: "string", description: "Card header title." },
        markdown: { type: "string", description: "Main Markdown body of the card." },
        tone: {
          type: "string",
          enum: ["blue", "wathet", "turquoise", "green", "yellow", "orange", "red", "grey"],
          description: "Optional header color template (default: 'blue').",
        },
        fallbackText: { type: "string", description: "Plain-text summary shown in conversation list previews." },
        buttons: {
          type: "array",
          description:
            "Optional interactive buttons (up to 4). Each actionId must be one of: confirm, cancel, submit, refresh (each used at most once per card).",
          items: {
            type: "object",
            properties: {
              actionId: { type: "string", enum: ["confirm", "cancel", "submit", "refresh"] },
              label: { type: "string" },
              style: { type: "string", enum: ["default", "primary", "danger"] },
              value: { type: "object", description: "Optional metadata object returned when the user clicks this button." },
            },
            required: ["actionId", "label"],
          },
        },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["conversationId", "title", "markdown"],
    },
  },
  {
    name: "duallane_wait_for_event",
    description:
      "Wait in real time (via outbound WebSocket with replay cursor) for the next incoming DualLane message, @mention, /command, or interactive card button click.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 300,
          description: "Maximum seconds to wait before returning { timeout: true } (default: 60).",
        },
        conversationId: {
          type: "string",
          description: "Optional conversationId filter — only return events from this conversation.",
        },
        afterSequence: {
          type: "integer",
          minimum: 0,
          description: "Optional sequence cursor override (defaults to profile's saved lastSequence).",
        },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
    },
  },
  {
    name: "duallane_set_typing",
    description:
      "Emit a real-time 'thinking' or 'typing' indicator in a DualLane conversation (and advance read confirmation) while processing a complex task.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Target DualLane conversation ID (conv_...)." },
        state: {
          type: "string",
          enum: ["thinking", "typing"],
          description: "Processing state shown to users (default: 'thinking').",
        },
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "duallane_unbind",
    description:
      "Revoke this Agent's bound DualLane Bot token on the server and remove the local ~/.config/duallane/agents/<profile>.json credential file.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Local credential profile name (default: 'default')." },
      },
    },
  },
];

export function createDualLaneMcpServer(options = {}) {
  const defaultProfile = normalizeProfileName(options.defaultProfile || "default");
  const configDir = options.configDir;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const webSocketFactory = options.webSocketFactory;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  function makeClient(profileName) {
    const profile = loadAgentProfile(profileName || defaultProfile, { configDir });
    if (!profile) {
      throw new DualLaneAgentError(
        "profile.not_configured",
        `No DualLane Bot credentials found for profile "${profileName || defaultProfile}". Run duallane_setup_start with a setup URL from DualLane Settings -> Bots first.`
      );
    }
    const client = new DualLaneAgentClient({
      url: profile.url,
      token: profile.token,
      fetch: fetchImpl,
      webSocketFactory,
      adapterVersion: `duallane-mcp/${DUALLANE_AGENT_SDK_VERSION}`,
    });
    return { client, profile };
  }

  async function callTool(name, args = {}) {
    const profileName = normalizeProfileName(args.profile || defaultProfile);

    switch (name) {
      case "duallane_setup_start": {
        const target = parseSetupTarget(args.setupUrl, args.url);
        const clientName = sanitizeSetupClientName(args.clientName, `duallane-mcp/${DUALLANE_AGENT_SDK_VERSION}`);
        const requestedScopes =
          Array.isArray(args.requestedScopes) && args.requestedScopes.length > 0
            ? args.requestedScopes
            : [...DEFAULT_SETUP_SCOPES];

        const setupClient = new DualLaneAgentSetupClient({ url: target.origin, fetch: fetchImpl });
        const initialCheck = await setupClient.status(target.setupSessionId).catch(() => null);
        const initialSession = initialCheck?.setup || initialCheck?.session || null;
        const initialStatus = initialSession ? String(initialSession.status || "") : "";

        let response = initialCheck;
        if (initialStatus !== "approved") {
          response = await setupClient.request(target.setupSessionId, {
            requestedScopes,
            clientName,
            clientVersion: DUALLANE_AGENT_SDK_VERSION,
            protocolVersion: "v1",
            capabilities: ["mcp", "websocket", "cards", "stream_edit"],
          });
        }

        savePendingSetup(
          profileName,
          {
            origin: target.origin,
            setupSessionId: target.setupSessionId,
            approvalUrl: target.approvalUrl,
            clientName,
            clientVersion: DUALLANE_AGENT_SDK_VERSION,
          },
          { configDir }
        );

        const resolvedStatus = response?.session?.status || response?.setup?.status || "pending_approval";
        return {
          status: resolvedStatus,
          profile: profileName,
          origin: target.origin,
          setupSessionId: target.setupSessionId,
          approvalUrl: target.approvalUrl,
          requestedScopes,
          nextStep:
            resolvedStatus === "approved"
              ? "Session is already approved! Call duallane_setup_finish immediately to complete credential exchange."
              : `Ask the user to open ${target.approvalUrl} (or approve directly in DualLane Settings -> Bots), then call duallane_setup_finish.`,
        };
      }

      case "duallane_setup_finish": {
        const pending = loadPendingSetup(profileName, { configDir });
        let target;
        if (args.setupUrl) {
          target = parseSetupTarget(args.setupUrl, args.url || pending?.origin);
        } else if (pending?.setupSessionId && pending?.origin) {
          target = {
            origin: pending.origin,
            setupSessionId: pending.setupSessionId,
            approvalUrl: pending.approvalUrl || `${pending.origin}/workspace?setup=${encodeURIComponent(pending.setupSessionId)}`,
          };
        } else {
          throw new DualLaneAgentError(
            "setup.no_pending_session",
            "No pending setup session found. Call duallane_setup_start with the user's setup URL first."
          );
        }

        const waitSeconds = Math.min(180, Math.max(0, Number.isFinite(Number(args.waitSeconds)) ? Number(args.waitSeconds) : 45));
        const deadline = Date.now() + waitSeconds * 1000;
        const setupClient = new DualLaneAgentSetupClient({ url: target.origin, fetch: fetchImpl });
        const clientName = sanitizeSetupClientName(pending?.clientName, `duallane-mcp/${DUALLANE_AGENT_SDK_VERSION}`);

        let latestStatus = "pending";
        while (true) {
          const check = await setupClient.status(target.setupSessionId);
          const session = check?.setup || check?.session || {};
          latestStatus = String(session.status || "pending");
          if (latestStatus === "approved") {
            break;
          }
          if (latestStatus === "denied" || latestStatus === "expired" || latestStatus === "exchanged") {
            clearPendingSetup(profileName, { configDir });
            throw new DualLaneAgentError(
              `setup.${latestStatus}`,
              `Setup session is ${latestStatus}. Please generate a fresh pairing link in DualLane Settings -> Bots.`
            );
          }
          if (Date.now() >= deadline) {
            return {
              status: latestStatus,
              profile: profileName,
              setupSessionId: target.setupSessionId,
              approvalUrl: target.approvalUrl,
              message: "Waiting for user approval in DualLane. Once the user clicks Approve, call duallane_setup_finish again.",
            };
          }
          await sleep(1500);
        }

        const exchanged = await setupClient.exchange(target.setupSessionId, {
          clientName,
          clientVersion: DUALLANE_AGENT_SDK_VERSION,
          protocolVersion: "v1",
        });

        const rawToken = String(exchanged?.token || "").trim();
        if (!rawToken) {
          throw new DualLaneAgentError("setup.exchange_empty", "Setup exchange succeeded without returning a token");
        }

        const verifyClient = new DualLaneAgentClient({
          url: target.origin,
          token: rawToken,
          fetch: fetchImpl,
          webSocketFactory,
          adapterVersion: `duallane-mcp/${DUALLANE_AGENT_SDK_VERSION}`,
        });
        let me = null;
        let conversations = [];
        try {
          me = await verifyClient.getMe();
          const convRes = await verifyClient.listConversations();
          conversations = convRes?.conversations || [];
        } catch {
          /* non-fatal verification enrichment */
        }

        const saved = saveAgentProfile(
          profileName,
          {
            url: target.origin,
            token: rawToken,
            botId: me?.bot?.id || exchanged?.session?.botId || null,
            botUserId: me?.bot?.botUserId || null,
            botName: me?.bot?.name || null,
            scopes: me?.scopes || exchanged?.tokenRecord?.scopes || [],
            clientName,
          },
          { configDir }
        );
        clearPendingSetup(profileName, { configDir });

        return {
          status: "connected",
          profile: saved.profile,
          credentialsStoredAt: saved.filePath,
          origin: target.origin,
          bot: me?.bot || { id: exchanged?.session?.botId },
          scopes: me?.scopes || exchanged?.tokenRecord?.scopes || [],
          conversations,
        };
      }

      case "duallane_status": {
        const { client, profile } = makeClient(profileName);
        const [me, convRes] = await Promise.all([
          client.getMe(),
          client.listConversations().catch(() => ({ conversations: [] })),
        ]);
        return {
          connected: true,
          profile: profile.profile,
          source: profile.source,
          origin: profile.url,
          lastSequence: profile.lastSequence,
          bot: me?.bot,
          scopes: me?.scopes || [],
          settings: me?.settings,
          gatewayConnection: me?.connection || null,
          conversations: convRes?.conversations || [],
        };
      }

      case "duallane_list_conversations": {
        const { client } = makeClient(profileName);
        return await client.listConversations();
      }

      case "duallane_get_context": {
        const { client } = makeClient(profileName);
        const limit = args.limit === undefined ? 30 : Number(args.limit);
        return await client.getContext(args.conversationId, { limit });
      }

      case "duallane_send_message": {
        const { client } = makeClient(profileName);
        return await client.sendMessage({
          conversationId: args.conversationId,
          text: args.text,
          replyToMessageId: args.replyToMessageId,
        });
      }

      case "duallane_edit_message": {
        const { client } = makeClient(profileName);
        return await client.editMessage(args.messageId, args.plainText);
      }

      case "duallane_send_file": {
        const { client } = makeClient(profileName);
        let rawBytes;
        let resolvedName = typeof args.fileName === "string" ? args.fileName.trim() : "";
        if (typeof args.filePath === "string" && args.filePath.trim()) {
          const full = path.resolve(args.filePath.trim());
          rawBytes = fs.readFileSync(full);
          if (!resolvedName) {
            resolvedName = path.basename(full);
          }
        } else if (typeof args.contentBase64 === "string" && args.contentBase64.trim()) {
          const cleanedB64 = args.contentBase64.trim().replace(/^data:[^;]+;base64,/iu, "");
          rawBytes = Buffer.from(cleanedB64, "base64");
        } else if (typeof args.contentText === "string" && args.contentText.length > 0) {
          rawBytes = Buffer.from(args.contentText, "utf8");
        } else {
          throw new TypeError("One of filePath, contentText, or contentBase64 is required for duallane_send_file");
        }
        if (!resolvedName) {
          resolvedName = "generated.txt";
        }
        const mimeType =
          typeof args.mimeType === "string" && args.mimeType.trim()
            ? args.mimeType.trim()
            : inferMimeTypeFromFileName(resolvedName);
        return await client.sendFile({
          conversationId: args.conversationId,
          bytes: rawBytes,
          fileName: resolvedName,
          mimeType,
          text: args.text,
          replyToMessageId: args.replyToMessageId,
        });
      }

      case "duallane_send_card": {
        const { client } = makeClient(profileName);
        const elements = [
          {
            tag: "markdown",
            content: String(args.markdown || ""),
          },
        ];
        if (Array.isArray(args.buttons) && args.buttons.length > 0) {
          const seen = new Set();
          const actions = [];
          for (const btn of args.buttons.slice(0, 4)) {
            const actionId = String(btn?.actionId || "").trim();
            if (!ALLOWED_CARD_ACTIONS.has(actionId) || seen.has(actionId)) {
              throw new TypeError(`Card button actionId must be unique and one of: confirm, cancel, submit, refresh (got "${actionId}")`);
            }
            seen.add(actionId);
            actions.push({
              tag: "button",
              text: { tag: "plain_text", content: String(btn.label || actionId) },
              type: btn.style === "primary" || btn.style === "danger" ? btn.style : "default",
              value: {
                action: actionId,
                ...(btn.value && typeof btn.value === "object" && !Array.isArray(btn.value) ? btn.value : {}),
              },
            });
          }
          if (actions.length > 0) {
            elements.push({ tag: "hr" });
            elements.push({ tag: "action", actions });
          }
        }
        const card = {
          header: {
            title: { tag: "plain_text", content: String(args.title || "通知卡片") },
            template: args.tone || "blue",
          },
          elements,
        };
        return await client.sendFeishuCard({
          conversationId: args.conversationId,
          fallbackText: String(args.fallbackText || args.title || "交互卡片"),
          card,
        });
      }

      case "duallane_wait_for_event": {
        const { client, profile } = makeClient(profileName);
        const timeoutSeconds = Math.min(300, Math.max(1, Number(args.timeoutSeconds || 60)));
        const startSeq =
          args.afterSequence !== undefined && Number.isSafeInteger(Number(args.afterSequence))
            ? Number(args.afterSequence)
            : profile.lastSequence || 0;
        const filterConv = args.conversationId ? String(args.conversationId).trim() : "";
        const startedAtMs = Date.now();

        const fallbackToPoll = async (cursor) => {
          const remainingMs = Math.max(1000, timeoutSeconds * 1000 - (Date.now() - startedAtMs));
          const polled = await client.pollNextEvent({
            afterSequence: cursor,
            timeoutMs: remainingMs,
            conversationId: filterConv,
            onCursorAdvance: (seq) => updateProfileCursor(profileName, seq, { configDir }),
            onSyncRequired: ({ currentSequence }) => updateProfileCursor(profileName, currentSequence, { configDir }),
          });
          if (polled.timeout) {
            return {
              timeout: true,
              waitedSeconds: timeoutSeconds,
              lastSequence: polled.lastSequence,
            };
          }
          return {
            timeout: false,
            event: polled.event,
            lastSequence: polled.lastSequence,
          };
        };

        return await new Promise((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            client.stop();
            resolve({
              timeout: true,
              waitedSeconds: timeoutSeconds,
              lastSequence: client.lastSequence || startSeq,
            });
          }, timeoutSeconds * 1000);
          timer.unref?.();

          client
            .connect({
              lastSequence: startSeq,
              async onEvent(event) {
                updateProfileCursor(profileName, event.sequence, { configDir });
                if (filterConv && event.conversationId !== filterConv) {
                  return;
                }
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                setImmediate(() => client.stop());
                resolve({
                  timeout: false,
                  event,
                  lastSequence: event.sequence,
                });
              },
              async onSyncRequired({ currentSequence }) {
                updateProfileCursor(profileName, currentSequence, { configDir });
              },
              onError(err) {
                if (!settled && !err?.retryable) {
                  settled = true;
                  clearTimeout(timer);
                  client.stop();
                  reject(err);
                }
              },
            })
            .catch((err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              client.stop();
              if (err?.retryable) {
                fallbackToPoll(client.lastSequence || startSeq).then(resolve, reject);
                return;
              }
              reject(err);
            });
        });
      }

      case "duallane_set_typing": {
        const { client } = makeClient(args.profile);
        return await client.setTyping(args.conversationId, { state: args.state || "thinking" });
      }

      case "duallane_unbind": {
        const profileName = normalizeProfileName(args.profile || defaultProfile);
        const existing = loadAgentProfile(profileName, { configDir });
        let serverRevoked = false;
        if (existing) {
          const client = new DualLaneAgentClient({
            url: existing.url,
            token: existing.token,
            fetch: fetchImpl,
            webSocketFactory,
          });
          await client.unbind().then(() => {
            serverRevoked = true;
          }).catch(() => {});
        }
        const cleaned = deleteAgentProfile(profileName, { configDir });
        return {
          status: "unbound",
          profile: cleaned.profile,
          serverRevoked,
          removedLocalFile: cleaned.removed,
        };
      }

      default:
        throw new DualLaneAgentError("mcp.unknown_tool", `Unknown tool: ${name}`);
    }
  }

  async function handleJsonRpc(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" },
      };
    }

    const { id, method, params } = message;
    const isNotification = id === undefined;

    try {
      switch (method) {
        case "initialize": {
          const requestedVersion = String(params?.protocolVersion || "");
          const negotiated = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
            ? requestedVersion
            : DEFAULT_MCP_PROTOCOL_VERSION;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: negotiated,
              capabilities: {
                tools: { listChanged: false },
              },
              serverInfo: {
                name: "duallane-agent-mcp",
                version: DUALLANE_AGENT_SDK_VERSION,
              },
            },
          };
        }

        case "notifications/initialized":
        case "notifications/cancelled":
          return null;

        case "ping":
          return { jsonrpc: "2.0", id, result: {} };

        case "tools/list":
          return {
            jsonrpc: "2.0",
            id,
            result: { tools: DUALLANE_MCP_TOOLS },
          };

        case "resources/list":
          return { jsonrpc: "2.0", id, result: { resources: [] } };

        case "prompts/list":
          return { jsonrpc: "2.0", id, result: { prompts: [] } };

        case "tools/call": {
          const toolName = String(params?.name || "");
          const toolArgs = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
          try {
            const output = await callTool(toolName, toolArgs);
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
                structuredContent: output,
                isError: false,
              },
            };
          } catch (toolErr) {
            const safeError = {
              code: toolErr?.code || "tool.execution_failed",
              message: redactSecrets(toolErr?.message || String(toolErr)),
              statusCode: toolErr?.statusCode || null,
            };
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ error: safeError }, null, 2) }],
                isError: true,
              },
            };
          }
        }

        default:
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
    } catch (err) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: redactSecrets(err?.message || "Internal MCP server error"),
        },
      };
    }
  }

  return {
    callTool,
    handleJsonRpc,
  };
}

export function startDualLaneMcpStdioServer(options = {}) {
  const server = createDualLaneMcpServer(options);
  const input = options.stdin || process.stdin;
  const output = options.stdout || process.stdout;

  let buffer = Buffer.alloc(0);
  let framingMode = null; // "newline" | "content-length"

  function sendResponse(payload) {
    if (!payload) return;
    const json = JSON.stringify(payload);
    if (framingMode === "content-length") {
      const byteLength = Buffer.byteLength(json, "utf8");
      output.write(`Content-Length: ${byteLength}\r\n\r\n${json}`);
    } else {
      output.write(`${json}\n`);
    }
  }

  function dispatchRawMessage(rawText) {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      sendResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    Promise.all(items.map((item) => server.handleJsonRpc(item))).then((responses) => {
      const valid = responses.filter(Boolean);
      if (valid.length === 0) return;
      if (Array.isArray(parsed)) sendResponse(valid);
      else sendResponse(valid[0]);
    });
  }

  input.on("data", (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);

    while (buffer.length > 0) {
      if (!framingMode) {
        const preview = buffer.subarray(0, Math.min(buffer.length, 32)).toString("utf8").trimStart();
        if (!preview) return;
        framingMode = /^content-length:/iu.test(preview) ? "content-length" : "newline";
      }

      if (framingMode === "content-length") {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headerText = buffer.subarray(0, headerEnd).toString("utf8");
        const match = /content-length:\s*(\d+)/iu.exec(headerText);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) return;
        const bodyText = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
        buffer = buffer.subarray(bodyStart + length);
        dispatchRawMessage(bodyText);
      } else {
        const newlineIdx = buffer.indexOf(0x0a);
        if (newlineIdx === -1) return;
        const line = buffer.subarray(0, newlineIdx).toString("utf8");
        buffer = buffer.subarray(newlineIdx + 1);
        dispatchRawMessage(line);
      }
    }
  });

  return server;
}

function redactSecrets(text) {
  return String(text || "").replace(/dl_bot_[A-Za-z0-9_-]{12,}/gu, "[REDACTED]");
}
