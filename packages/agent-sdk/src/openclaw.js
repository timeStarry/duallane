import { DualLaneAgentClient } from "./index.js";

export function createOpenClawDualLaneAdapter(options = {}) {
  const client = options.client;
  if (!(client instanceof DualLaneAgentClient) && !isClientLike(client)) {
    throw new TypeError("OpenClaw adapter requires a DualLaneAgentClient");
  }
  if (typeof options.dispatchInbound !== "function") throw new TypeError("dispatchInbound must be a function");
  const includeContext = options.includeContext !== false;

  async function start(input = {}) {
    return client.connect({
      lastSequence: input.lastSequence ?? 0,
      signal: input.signal,
      onStatus: input.onStatus,
      onSyncRequired: input.onSyncRequired,
      onError: input.onError,
      onEvent: async (event) => {
        const context = includeContext && event.conversationId
          ? await client.getContext(event.conversationId).catch((error) => {
            if (error?.code === "bot.context_forbidden" || error?.code === "bot.scope_denied") return null;
            throw error;
          })
          : null;
        let replied = false;
        const claimReply = () => {
          if (replied) throw new Error("DualLane OpenClaw adapter permits one logical reply per event");
          replied = true;
        };
        const reply = Object.freeze({
          text: async (text, replyOptions = {}) => {
            claimReply();
            return client.sendMessage({
              conversationId: event.conversationId,
              text,
              replyToMessageId: replyOptions.replyToMessageId,
              idempotencyKey: replyOptions.idempotencyKey ?? `${event.eventId}:text`,
              clientMessageId: replyOptions.clientMessageId ?? `${event.eventId}:reply`
            });
          },
          card: async (cardInput) => {
            claimReply();
            return client.sendCard({
              ...cardInput,
              conversationId: event.conversationId,
              idempotencyKey: cardInput.idempotencyKey ?? `${event.eventId}:card`,
              clientMessageId: cardInput.clientMessageId ?? `${event.eventId}:card-message`
            });
          }
        });
        const result = await options.dispatchInbound({
          channel: "duallane",
          accountId: options.accountId ?? "default",
          target: event.conversationId,
          event,
          context,
          reply
        });
        if (!replied && typeof result === "string" && result.trim()) await reply.text(result.trim());
        if (!replied && result?.text && typeof result.text === "string") await reply.text(result.text, result);
      }
    });
  }

  return Object.freeze({
    id: "duallane",
    start,
    stop: () => client.stop(),
    sendText: ({ to, text, replyToMessageId, idempotencyKey, clientMessageId }) => client.sendMessage({
      conversationId: to,
      text,
      replyToMessageId,
      idempotencyKey,
      clientMessageId
    }),
    sendCard: ({ to, ...card }) => client.sendCard({ conversationId: to, ...card }),
    setTyping: ({ to }) => client.setTyping(to)
  });
}

function isClientLike(value) {
  return value && ["connect", "stop", "getContext", "sendMessage", "sendCard", "setTyping"].every((name) => typeof value[name] === "function");
}
