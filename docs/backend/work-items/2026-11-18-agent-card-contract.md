# SDK 1.2.1 card contract regression

## Observable behavior and scope

The SDK 1.2.0 interactive-card builder placed business values and `action` in
`button.value`. Go intentionally accepts only `action_id` and nested `data` at
that boundary, so the normal SDK confirm/cancel card failed strict conversion.
The existing public validation response is HTTP422; this patch preserves it.

SDK 1.2.1 uses the same fixed-action builder for task/operator send and update.
It emits `value.action_id` and optional `value.data`, keeps business keys nested,
and preserves fixed actions, uniqueness and the 4096-byte JSON-object limit.
The Go unknown-field/action/data validator and revision/provenance rules remain
unchanged. Workspace alone is affected; P2P and persisted schemas are unchanged.

## Attempt failure and operation receipts

Recognized strict-converter HTTP400/422 errors report this write attempt as
`attemptOutcome: rejected`. The code list is explicit and includes the converter's
literal `card.feishu_unknown_field`; future or business errors do not inherit the
classification. Transport loss, timeout, invalid responses and unrecognized
errors remain `unknown`. Both carry `safeToRetry: false` and the operation reference.

An attempt rejection does not prove that the same key has never committed.
Server operation queries continue returning committed receipts or conservative
`unknown / safeToRetry:false`; no rejection table, migration, inferred global
not-committed result, automatic retry or replacement key is introduced.

## Regression evidence

- SDK source/tool tests check all fixed actions, nested business data, size/type
  rejection, CLI and both MCP paths, stable keys and safe error projections.
- The real Go/PG browser gate invokes the actual SDK builder and client for
  confirm/cancel send/update, then a task-tool update. It verifies normalized
  stored data and revision conflicts against the strict Go converter.
- The old builder's malformed value is still rejected with HTTP422 and creates
  no card message or revision change. An earlier committed use of the same key
  remains queryable after a rejected request.
- A real HTTP request is forwarded and committed before its response is dropped.
  Receipt lookup finds the committed card; repeating the same tool request causes
  no second card POST. This is fault injection over the real server, not a mocked
  card client or a duplicated JavaScript converter.
- Live output is observed through the authorized synthetic human conversation;
  task history retains its original snapshot boundary.

Only synthetic data is used. The completed Comet task and its failed operation
are diagnostic evidence, never replay inputs. Comet's runtime, credentials,
global settings and approval policy remain owned by its original chat.

## Release and rollback

App and SDK target1.2.1; minimum SDK admission remains1.2.0 because the transport
contract is compatible. Publish both runtime manifests and exact digests with
the reviewed PR. Production activation, if selected under the existing release
instruction, uses the guarded main checkout and the current1.2.0/schema37 recovery
snapshot. No schema bridge or database restore is required. Final gate and
deployment evidence belongs in the PR release record.
