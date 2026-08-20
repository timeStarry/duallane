# DualLane Channel for Hermes, v1

Compatibility: DualLane Bot Gateway protocol v1 and DualLane SDK 0.15.x.

This release provides the generic JavaScript SDK for Hermes integration, not an
official Hermes Adapter. Review `/integrations/v1/duallane-channel.md`, install
the reviewed SDK package, and connect it from the Hermes process that owns the
model and Agent loop.

The Hermes event handler should:

1. Receive the filtered DualLane event from `client.connect`.
2. Request context only when `messages:read_context` and a conversation grant
   are intentionally configured.
3. Pass only that event and context into Hermes.
4. Send one logical reply using an idempotency key derived from `eventId`.
5. Persist the sequence after the callback completes.

Keep `DUALLANE_URL` and `DUALLANE_BOT_TOKEN` in the Hermes secret/config store.
The Token belongs only in the `Authorization` header; never place it in a URL,
prompt, repository, runtime log, or model-visible message. Do not grant file,
context, or card scopes unless the Bot actually needs them.
