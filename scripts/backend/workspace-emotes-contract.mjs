import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../apps/web/server/index.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const fixturePath = path.join(repoRoot, "apps/backend/internal/workspacecontract/testdata/node-emotes.json");
const nodeRoutesPath = path.join(repoRoot, "apps/backend/api/node-routes.json");
const emoteCatalogPath = path.join(repoRoot, "apps/web/shared/emote-packs.json");

const OWNER_ID = "usr_owner";
const MEMBER_ID = "usr_emote_contract_member";
const OUTSIDER_ID = "usr_emote_contract_outsider";
const MESSAGE_ID = "msg_emote_contract";
const CONVERSATION_ID = "con_emote_contract";

const EMOTE_ROUTES = [
  ["GET", "/api/workspace/emote-collection-shares/{shareId}"],
  ["POST", "/api/workspace/emote-collection-shares/{shareId}/import"],
  ["GET", "/api/workspace/emotes/{emoteId}/content"],
  ["DELETE", "/api/workspace/me/emote-collection-shares/{shareId}"],
  ["POST", "/api/workspace/me/emote-collections"],
  ["DELETE", "/api/workspace/me/emote-collections/{collectionId}"],
  ["PATCH", "/api/workspace/me/emote-collections/{collectionId}"],
  ["POST", "/api/workspace/me/emote-collections/{collectionId}/items"],
  ["DELETE", "/api/workspace/me/emote-collections/{collectionId}/items/{emoteId}"],
  ["PUT", "/api/workspace/me/emote-collections/{collectionId}/order"],
  ["POST", "/api/workspace/me/emote-collections/{collectionId}/shares"],
  ["PUT", "/api/workspace/me/emote-collections/{collectionId}/source-subscription"],
  ["GET", "/api/workspace/me/emote-library"],
  ["PUT", "/api/workspace/me/emote-library/order"],
  ["GET", "/api/workspace/me/emote-settings"],
  ["PUT", "/api/workspace/me/emote-settings"],
  ["GET", "/api/workspace/me/emotes"],
  ["POST", "/api/workspace/me/emotes"],
  ["POST", "/api/workspace/me/emotes/favorite"],
  ["PUT", "/api/workspace/me/emotes/order"],
  ["DELETE", "/api/workspace/me/emotes/{emoteId}"],
  ["PATCH", "/api/workspace/me/emotes/{emoteId}"]
];

function readRouteInventory() {
  const inventory = JSON.parse(readFileSync(nodeRoutesPath, "utf8"));
  const routes = new Map(inventory.routes.map((route) => [`${route.method} ${route.path}`, route]));
  return EMOTE_ROUTES.map(([method, routePath]) => {
    const route = routes.get(`${method} ${routePath}`);
    assert(route, `node-routes.json is missing ${method} ${routePath}`);
    assert.equal(route.source, "apps/web/server/index.mjs", `${method} ${routePath} source changed unexpectedly`);
    return {
      method,
      path: routePath,
      nodePath: route.nodePath,
      source: route.source
    };
  });
}

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function seedHuman(db, { id, login, displayName, member }) {
  const now = iso();
  db.prepare(`
    INSERT INTO users (
      id, github_id, github_login, email, display_name, nickname, avatar_url, kind, created_at, last_login_at
    ) VALUES (?, NULL, ?, NULL, ?, ?, NULL, 'human', ?, NULL)
    ON CONFLICT (id) DO NOTHING
  `).run(id, login, displayName, login, now);
  if (member) {
    db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES ('spc_default', ?, 'member', ?, NULL)
      ON CONFLICT (space_id, user_id) DO UPDATE SET removed_at = NULL
    `).run(id, now);
  }
}

function seedVisibleMessage(db) {
  const now = iso();
  db.prepare(`
    INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
    VALUES (?, 'spc_default', 'direct', '', 'emote-contract-direct', 100, ?, ?)
  `).run(CONVERSATION_ID, OWNER_ID, now);
  for (const userId of [OWNER_ID, MEMBER_ID]) {
    db.prepare(`
      INSERT INTO conversation_members (
        conversation_id, user_id, joined_at, removed_at, notification_level
      ) VALUES (?, ?, ?, NULL, 'all')
    `).run(CONVERSATION_ID, userId, now);
  }
  db.prepare(`
    INSERT INTO messages (
      id, space_id, conversation_id, author_id, author_kind, kind, client_message_id,
      content_format, content_json, plain_text, reply_to_message_id, created_at, edited_at, deleted_at
    ) VALUES (?, 'spc_default', ?, ?, 'human', 'user', 'emote-contract-message',
      'duallane.message+json;v=1', ?, '[表情]', NULL, ?, NULL, NULL)
  `).run(
    MESSAGE_ID,
    CONVERSATION_ID,
    OWNER_ID,
    JSON.stringify({ format: "duallane.message+json;v=1", plainText: "[表情]", blocks: [] }),
    now
  );
}

function onePixelBmp({ blue = 32, green = 128, red = 224 } = {}) {
  const buffer = Buffer.alloc(58);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(1, 18);
  buffer.writeInt32LE(1, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(4, 34);
  buffer.set([blue, green, red, 0], 54);
  return buffer;
}

function firstVisibleImageEmote() {
  const packs = JSON.parse(readFileSync(emoteCatalogPath, "utf8"));
  for (const pack of packs) {
    if (["douyin", "qq"].includes(pack.id)) continue;
    const item = (pack.items ?? []).find((candidate) => candidate.kind === "image");
    if (item) return { ...item, packId: pack.id };
  }
  throw new Error("Node emote catalog has no visible image emote");
}

function actorHeaders(actorId) {
  return actorId ? { "x-workspace-user-id": actorId } : {};
}

function jsonRequest(method, url, payload, actorId) {
  return {
    method,
    url,
    headers: { ...actorHeaders(actorId), "content-type": "application/json" },
    payload
  };
}

function emptyRequest(method, url, actorId) {
  return { method, url, headers: actorHeaders(actorId) };
}

function rawRequest(url, payload, contentType, fileName, actorId) {
  return {
    method: "POST",
    url,
    headers: {
      ...actorHeaders(actorId),
      "content-type": contentType,
      "x-duallane-file-name": encodeURIComponent(fileName)
    },
    payload
  };
}

function requestBody(request) {
  if (request.payload === undefined) return {};
  if (Buffer.isBuffer(request.payload)) {
    return { bodyBase64: request.payload.toString("base64") };
  }
  return { body: request.payload };
}

function captureRequest(request) {
  return {
    method: request.method,
    path: request.url,
    headers: request.headers ?? {},
    ...requestBody(request)
  };
}

function responseHeaders(response) {
  const headers = {};
  for (const name of ["content-type", "cache-control", "content-disposition"]) {
    const value = response.headers[name];
    if (value !== undefined) headers[name] = String(value).split(";", 1)[0].trim();
  }
  return headers;
}

function captureResponse(response, { binary = false } = {}) {
  if (!binary) {
    return {
      status: response.statusCode,
      headers: responseHeaders(response),
      body: response.body ? response.json() : null
    };
  }
  const payload = Buffer.isBuffer(response.rawPayload)
    ? response.rawPayload
    : Buffer.from(response.body ?? "", "binary");
  return {
    status: response.statusCode,
    headers: responseHeaders(response),
    bodyBase64: payload.toString("base64")
  };
}

function assertError(response, status, code) {
  assert.equal(response.statusCode, status, `expected ${code} response status`);
  assert.equal(response.json().error.code, code, `expected ${code} response code`);
}

function addScenario(scenarios, name, request, response, options = {}) {
  scenarios.push({
    name,
    request: captureRequest(request),
    response: captureResponse(response, options)
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_IN_STRING_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

function replaceString(value, ids, generatedIds) {
  if (ids.has(value)) return ids.get(value);
  let normalized = value;
  for (const [raw, canonical] of ids) normalized = normalized.split(raw).join(canonical);
  if (UUID_PATTERN.test(normalized)) {
    if (!generatedIds.has(normalized)) {
      generatedIds.set(normalized, `generated_${String(generatedIds.size + 1).padStart(2, "0")}`);
    }
    return generatedIds.get(normalized);
  }
  if (normalized.match(UUID_IN_STRING_PATTERN)) {
    return normalized.replace(UUID_IN_STRING_PATTERN, (raw) => {
      if (!generatedIds.has(raw)) {
        generatedIds.set(raw, `generated_${String(generatedIds.size + 1).padStart(2, "0")}`);
      }
      return generatedIds.get(raw);
    });
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized)) {
    return "2026-01-01T00:00:00.000Z";
  }
  return normalized;
}

function normalizeFixture(value, ids, generatedIds = new Map()) {
  if (Array.isArray(value)) return value.map((item) => normalizeFixture(item, ids, generatedIds));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? replaceString(value, ids, generatedIds) : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    normalizeFixture(child, ids, generatedIds)
  ]));
}

async function createFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "duallane-workspace-emotes-contract-"));
  const db = openTestDatabase(dataDir);
  seedHuman(db, {
    id: MEMBER_ID,
    login: "emote-contract-member",
    displayName: "Emote Contract Member",
    member: true
  });
  seedHuman(db, {
    id: OUTSIDER_ID,
    login: "emote-contract-outsider",
    displayName: "Emote Contract Outsider",
    member: false
  });
  seedVisibleMessage(db);

  const app = await createApp({
    dataDir,
    db,
    env: {
      WORKSPACE_ENABLED: "true",
      NODE_ENV: "test",
      SERVE_STATIC: "false",
      WORKSPACE_EMAIL_WORKER_ENABLED: "false",
      WORKSPACE_NTFY_WORKER_ENABLED: "false",
      WORKSPACE_ECHO_DELIVERY_WORKER_ENABLED: "false",
      SESSION_SECRET: "workspace-emotes-contract-test-secret"
    },
    logger: false
  });
  const scenarios = [];
  const imageEmote = firstVisibleImageEmote();
  const builtinKey = `${imageEmote.packId}:${imageEmote.id}`;

  try {
    const unauthorizedRequest = emptyRequest("GET", "/api/workspace/me/emote-settings");
    const unauthorized = await app.inject(unauthorizedRequest);
    assertError(unauthorized, 403, "permission.denied");
    addScenario(scenarios, "unauthenticated-emote-denied", unauthorizedRequest, unauthorized);

    const settingsRequest = emptyRequest("GET", "/api/workspace/me/emote-settings", OWNER_ID);
    const settings = await app.inject(settingsRequest);
    assert.equal(settings.statusCode, 200);
    assert(settings.json().settings.availablePacks.length > 0);
    addScenario(scenarios, "settings-read-catalog", settingsRequest, settings);

    const settingsUpdateRequest = jsonRequest(
      "PUT",
      "/api/workspace/me/emote-settings",
      { enabledPackIds: ["emoji", "bili"], clickImageEmoteToSend: true, replyAutoMention: true },
      OWNER_ID
    );
    const settingsUpdate = await app.inject(settingsUpdateRequest);
    assert.equal(settingsUpdate.statusCode, 200);
    assert.deepEqual(settingsUpdate.json().settings.enabledPackIds, ["emoji", "bili"]);
    addScenario(scenarios, "settings-update", settingsUpdateRequest, settingsUpdate);

    const invalidSettingsRequest = jsonRequest(
      "PUT",
      "/api/workspace/me/emote-settings",
      { enabledPackIds: [] },
      OWNER_ID
    );
    const invalidSettings = await app.inject(invalidSettingsRequest);
    assertError(invalidSettings, 400, "emote.pack_required");
    addScenario(scenarios, "settings-invalid-pack-selection", invalidSettingsRequest, invalidSettings);

    const builtinMessage = {
      format: "duallane.message+json;v=1",
      plainText: imageEmote.token,
      blocks: [{ type: "text", text: imageEmote.token }]
    };
    db.prepare("UPDATE messages SET content_json = ?, plain_text = ? WHERE id = ?")
      .run(JSON.stringify(builtinMessage), imageEmote.token, MESSAGE_ID);
    const builtinFavoriteRequest = jsonRequest(
      "POST",
      "/api/workspace/me/emotes/favorite",
      { messageId: MESSAGE_ID, emoteKey: builtinKey },
      OWNER_ID
    );
    const builtinFavorite = await app.inject(builtinFavoriteRequest);
    assert.equal(builtinFavorite.statusCode, 201);
    assert.equal(builtinFavorite.json().emote.kind, "builtin");
    const builtinFavoriteId = builtinFavorite.json().emote.id;
    addScenario(scenarios, "builtin-catalog-favorite", builtinFavoriteRequest, builtinFavorite);

    const uploadRequest = rawRequest(
      "/api/workspace/me/emotes?addToLibrary=true",
      onePixelBmp(),
      "image/bmp",
      "contract-pixel.bmp",
      OWNER_ID
    );
    const upload = await app.inject(uploadRequest);
    assert.equal(upload.statusCode, 201);
    assert.equal(upload.json().emote.kind, "custom");
    const uploadedId = upload.json().emote.id;
    addScenario(scenarios, "custom-upload", uploadRequest, upload);

    const invalidUploadRequest = rawRequest(
      "/api/workspace/me/emotes",
      Buffer.from("not an image"),
      "application/octet-stream",
      "unsafe.bin",
      OWNER_ID
    );
    const invalidUpload = await app.inject(invalidUploadRequest);
    assertError(invalidUpload, 400, "emote.invalid_format");
    addScenario(scenarios, "custom-upload-invalid-body", invalidUploadRequest, invalidUpload);

    const listRequest = emptyRequest("GET", "/api/workspace/me/emotes", OWNER_ID);
    const list = await app.inject(listRequest);
    assert.equal(list.statusCode, 200);
    assert(list.json().items.some((item) => item.id === uploadedId));
    addScenario(scenarios, "emote-list", listRequest, list);

    const deniedContentRequest = emptyRequest(
      "GET",
      `/api/workspace/emotes/${uploadedId}/content`,
      MEMBER_ID
    );
    const deniedContent = await app.inject(deniedContentRequest);
    assertError(deniedContent, 403, "permission.denied");
    addScenario(scenarios, "content-denied-before-share", deniedContentRequest, deniedContent);

    const contentRequest = emptyRequest(
      "GET",
      `/api/workspace/emotes/${uploadedId}/content`,
      OWNER_ID
    );
    const content = await app.inject(contentRequest);
    assert.equal(content.statusCode, 200);
    assert.equal(content.headers["content-type"].split(";", 1)[0], "image/webp");
    assert(Buffer.from(content.rawPayload).length > 0);
    addScenario(scenarios, "content-authorized-webp", contentRequest, content, { binary: true });

    const patchEmoteRequest = jsonRequest(
      "PATCH",
      `/api/workspace/me/emotes/${uploadedId}`,
      { label: "Contract Pixel" },
      OWNER_ID
    );
    const patchEmote = await app.inject(patchEmoteRequest);
    assert.equal(patchEmote.statusCode, 200);
    assert.equal(patchEmote.json().emote.label, "Contract Pixel");
    addScenario(scenarios, "emote-update", patchEmoteRequest, patchEmote);

    db.prepare("UPDATE messages SET content_json = ?, plain_text = ? WHERE id = ?")
      .run(JSON.stringify({
        format: "duallane.message+json;v=1",
        plainText: "[表情]",
        blocks: [{ type: "emoji", shortcode: `custom:${uploadedId}` }]
      }), "[表情]", MESSAGE_ID);
    db.prepare("INSERT INTO message_custom_emotes (message_id, custom_emote_id) VALUES (?, ?)")
      .run(MESSAGE_ID, uploadedId);
    const favoriteCustomRequest = jsonRequest(
      "POST",
      "/api/workspace/me/emotes/favorite",
      { messageId: MESSAGE_ID, customEmoteId: uploadedId },
      MEMBER_ID
    );
    const favoriteCustom = await app.inject(favoriteCustomRequest);
    assert.equal(favoriteCustom.statusCode, 201);
    assert.equal(favoriteCustom.json().emote.kind, "custom");
    addScenario(scenarios, "custom-favorite-visible-message", favoriteCustomRequest, favoriteCustom);

    const collectionRequest = jsonRequest(
      "POST",
      "/api/workspace/me/emote-collections",
      { name: "Contract Collection", emoteIds: [uploadedId, builtinFavoriteId] },
      OWNER_ID
    );
    const collectionResponse = await app.inject(collectionRequest);
    assert.equal(collectionResponse.statusCode, 201);
    const collectionId = collectionResponse.json().collection.id;
    addScenario(scenarios, "collection-create", collectionRequest, collectionResponse);

    const memberCollectionPatchRequest = jsonRequest(
      "PATCH",
      `/api/workspace/me/emote-collections/${collectionId}`,
      { name: "Member Must Not Rename" },
      MEMBER_ID
    );
    const memberCollectionPatch = await app.inject(memberCollectionPatchRequest);
    assertError(memberCollectionPatch, 404, "emote.collection_not_found");
    addScenario(scenarios, "collection-owner-authorization", memberCollectionPatchRequest, memberCollectionPatch);

    const secondUploadRequest = rawRequest(
      "/api/workspace/me/emotes?addToLibrary=false",
      onePixelBmp({ blue: 96, green: 32, red: 192 }),
      "image/bmp",
      "contract-second.bmp",
      OWNER_ID
    );
    const secondUpload = await app.inject(secondUploadRequest);
    assert.equal(secondUpload.statusCode, 201);
    const secondUploadedId = secondUpload.json().emote.id;
    addScenario(scenarios, "custom-upload-without-library-placement", secondUploadRequest, secondUpload);

    const addItemsRequest = jsonRequest(
      "POST",
      `/api/workspace/me/emote-collections/${collectionId}/items`,
      { emoteIds: [secondUploadedId] },
      OWNER_ID
    );
    const addItems = await app.inject(addItemsRequest);
    assert.equal(addItems.statusCode, 200);
    addScenario(scenarios, "collection-add-items", addItemsRequest, addItems);

    const collectionOrderRequest = jsonRequest(
      "PUT",
      `/api/workspace/me/emote-collections/${collectionId}/order`,
      { emoteIds: [secondUploadedId, uploadedId, builtinFavoriteId] },
      OWNER_ID
    );
    const collectionOrder = await app.inject(collectionOrderRequest);
    assert.equal(collectionOrder.statusCode, 200);
    addScenario(scenarios, "collection-reorder", collectionOrderRequest, collectionOrder);

    const removeItemRequest = emptyRequest(
      "DELETE",
      `/api/workspace/me/emote-collections/${collectionId}/items/${secondUploadedId}`,
      OWNER_ID
    );
    const removeItem = await app.inject(removeItemRequest);
    assert.equal(removeItem.statusCode, 200);
    addScenario(scenarios, "collection-remove-item", removeItemRequest, removeItem);

    const libraryBeforeOrderRequest = emptyRequest("GET", "/api/workspace/me/emote-library", OWNER_ID);
    const libraryBeforeOrder = await app.inject(libraryBeforeOrderRequest);
    assert.equal(libraryBeforeOrder.statusCode, 200);
    const entryIds = libraryBeforeOrder.json().entries.map((entry) => entry.id);
    const libraryOrderRequest = jsonRequest(
      "PUT",
      "/api/workspace/me/emote-library/order",
      { entryIds: [...entryIds].reverse() },
      OWNER_ID
    );
    const libraryOrder = await app.inject(libraryOrderRequest);
    assert.equal(libraryOrder.statusCode, 200);
    addScenario(scenarios, "library-read", libraryBeforeOrderRequest, libraryBeforeOrder);
    addScenario(scenarios, "library-reorder", libraryOrderRequest, libraryOrder);

    const emoteIds = libraryBeforeOrder.json().entries
      .filter((entry) => entry.type === "emote")
      .map((entry) => entry.emote.id);
    const emoteOrderRequest = jsonRequest(
      "PUT",
      "/api/workspace/me/emotes/order",
      { emoteIds: [...emoteIds].reverse() },
      OWNER_ID
    );
    const emoteOrder = await app.inject(emoteOrderRequest);
    assert.equal(emoteOrder.statusCode, 200);
    addScenario(scenarios, "emote-reorder", emoteOrderRequest, emoteOrder);

    const shareRequest = emptyRequest(
      "POST",
      `/api/workspace/me/emote-collections/${collectionId}/shares`,
      OWNER_ID
    );
    const shareResponse = await app.inject(shareRequest);
    assert.equal(shareResponse.statusCode, 201);
    const shareId = shareResponse.json().share.id;
    addScenario(scenarios, "share-create", shareRequest, shareResponse);

    const shareGetRequest = emptyRequest(
      "GET",
      `/api/workspace/emote-collection-shares/${shareId}`,
      MEMBER_ID
    );
    const shareGet = await app.inject(shareGetRequest);
    assert.equal(shareGet.statusCode, 200);
    assert.equal(shareGet.json().share.canSubscribeToSourceChanges, true);
    addScenario(scenarios, "share-read-member", shareGetRequest, shareGet);

    const invalidShareImportRequest = jsonRequest(
      "POST",
      `/api/workspace/emote-collection-shares/${shareId}/import`,
      { emoteIds: ["00000000-0000-4000-8000-000000000000"] },
      MEMBER_ID
    );
    const invalidShareImport = await app.inject(invalidShareImportRequest);
    assertError(invalidShareImport, 400, "emote.invalid_source");
    addScenario(scenarios, "share-import-invalid-selection", invalidShareImportRequest, invalidShareImport);

    const snapshotImportRequest = jsonRequest(
      "POST",
      `/api/workspace/emote-collection-shares/${shareId}/import`,
      {},
      MEMBER_ID
    );
    const snapshotImport = await app.inject(snapshotImportRequest);
    assert.equal(snapshotImport.statusCode, 200);
    assert(snapshotImport.json().collection);
    const snapshotCollectionId = snapshotImport.json().collection.id;
    addScenario(scenarios, "share-import-snapshot", snapshotImportRequest, snapshotImport);

    const partialSubscriptionImportRequest = jsonRequest(
      "POST",
      `/api/workspace/emote-collection-shares/${shareId}/import`,
      { subscribeToSourceChanges: true, emoteIds: [uploadedId] },
      MEMBER_ID
    );
    const partialSubscriptionImport = await app.inject(partialSubscriptionImportRequest);
    assertError(partialSubscriptionImport, 400, "emote.subscription_requires_collection");
    addScenario(
      scenarios,
      "share-import-subscription-requires-full-collection",
      partialSubscriptionImportRequest,
      partialSubscriptionImport
    );

    const subscriptionImportRequest = jsonRequest(
      "POST",
      `/api/workspace/emote-collection-shares/${shareId}/import`,
      { subscribeToSourceChanges: true },
      MEMBER_ID
    );
    const subscriptionImport = await app.inject(subscriptionImportRequest);
    assert.equal(subscriptionImport.statusCode, 200);
    assert.equal(subscriptionImport.json().collection.sourceSubscription.enabled, true);
    const subscribedCollectionId = subscriptionImport.json().collection.id;
    addScenario(scenarios, "share-import-source-subscription", subscriptionImportRequest, subscriptionImport);

    const readOnlyPatchRequest = jsonRequest(
      "PATCH",
      `/api/workspace/me/emote-collections/${subscribedCollectionId}`,
      { name: "Must Stay Read Only" },
      MEMBER_ID
    );
    const readOnlyPatch = await app.inject(readOnlyPatchRequest);
    assertError(readOnlyPatch, 409, "emote.subscription_read_only");
    addScenario(scenarios, "subscription-read-only-authorization", readOnlyPatchRequest, readOnlyPatch);

    const disableSubscriptionRequest = jsonRequest(
      "PUT",
      `/api/workspace/me/emote-collections/${subscribedCollectionId}/source-subscription`,
      { enabled: false },
      MEMBER_ID
    );
    const disableSubscription = await app.inject(disableSubscriptionRequest);
    assert.equal(disableSubscription.statusCode, 200);
    assert.equal(disableSubscription.json().collection.sourceSubscription.enabled, false);
    addScenario(scenarios, "subscription-disable", disableSubscriptionRequest, disableSubscription);

    const enableSubscriptionRequest = jsonRequest(
      "PUT",
      `/api/workspace/me/emote-collections/${subscribedCollectionId}/source-subscription`,
      { enabled: true },
      MEMBER_ID
    );
    const enableSubscription = await app.inject(enableSubscriptionRequest);
    assert.equal(enableSubscription.statusCode, 200);
    assert.equal(enableSubscription.json().collection.sourceSubscription.enabled, true);
    addScenario(scenarios, "subscription-enable", enableSubscriptionRequest, enableSubscription);

    const deleteSnapshotRequest = emptyRequest(
      "DELETE",
      `/api/workspace/me/emote-collections/${snapshotCollectionId}?itemDisposition=remove`,
      MEMBER_ID
    );
    const deleteSnapshot = await app.inject(deleteSnapshotRequest);
    assert.equal(deleteSnapshot.statusCode, 200);
    addScenario(scenarios, "collection-delete-imported-snapshot", deleteSnapshotRequest, deleteSnapshot);

    const unauthorizedRevokeRequest = emptyRequest(
      "DELETE",
      `/api/workspace/me/emote-collection-shares/${shareId}`,
      MEMBER_ID
    );
    const unauthorizedRevoke = await app.inject(unauthorizedRevokeRequest);
    assertError(unauthorizedRevoke, 403, "permission.denied");
    addScenario(scenarios, "share-revoke-owner-authorization", unauthorizedRevokeRequest, unauthorizedRevoke);

    const revokeRequest = emptyRequest(
      "DELETE",
      `/api/workspace/me/emote-collection-shares/${shareId}`,
      OWNER_ID
    );
    const revoke = await app.inject(revokeRequest);
    assert.equal(revoke.statusCode, 200);
    assert.equal(revoke.json().share.revokedAt !== null, true);
    assert.deepEqual(revoke.json().share.items, []);
    addScenario(scenarios, "share-revoke", revokeRequest, revoke);

    const revokedGetRequest = emptyRequest(
      "GET",
      `/api/workspace/emote-collection-shares/${shareId}`,
      MEMBER_ID
    );
    const revokedGet = await app.inject(revokedGetRequest);
    assert.equal(revokedGet.statusCode, 200);
    assert.equal(revokedGet.json().share.revokedAt !== null, true);
    addScenario(scenarios, "share-read-revoked", revokedGetRequest, revokedGet);

    const revokedImportRequest = jsonRequest(
      "POST",
      `/api/workspace/emote-collection-shares/${shareId}/import`,
      {},
      MEMBER_ID
    );
    const revokedImport = await app.inject(revokedImportRequest);
    assertError(revokedImport, 410, "emote.share_revoked");
    addScenario(scenarios, "share-import-revoked", revokedImportRequest, revokedImport);

    const missingShareRequest = emptyRequest(
      "GET",
      "/api/workspace/emote-collection-shares/missing-share",
      MEMBER_ID
    );
    const missingShare = await app.inject(missingShareRequest);
    assertError(missingShare, 404, "emote.share_not_found");
    addScenario(scenarios, "share-read-missing", missingShareRequest, missingShare);

    const missingContentRequest = emptyRequest(
      "GET",
      "/api/workspace/emotes/missing-emote/content",
      OWNER_ID
    );
    const missingContent = await app.inject(missingContentRequest);
    assertError(missingContent, 404, "emote.not_found");
    addScenario(scenarios, "content-read-missing", missingContentRequest, missingContent);

    const deleteCollectionRequest = emptyRequest(
      "DELETE",
      `/api/workspace/me/emote-collections/${collectionId}?itemDisposition=keep`,
      OWNER_ID
    );
    const deleteCollection = await app.inject(deleteCollectionRequest);
    assert.equal(deleteCollection.statusCode, 200);
    addScenario(scenarios, "collection-delete", deleteCollectionRequest, deleteCollection);

    const deleteEmoteRequest = emptyRequest(
      "DELETE",
      `/api/workspace/me/emotes/${secondUploadedId}`,
      OWNER_ID
    );
    const deleteEmote = await app.inject(deleteEmoteRequest);
    assert.equal(deleteEmote.statusCode, 200);
    addScenario(scenarios, "emote-delete", deleteEmoteRequest, deleteEmote);

    const ids = new Map([
      [builtinFavoriteId, "emote_builtin_01"],
      [uploadedId, "emote_custom_01"],
      [secondUploadedId, "emote_custom_02"],
      [collectionId, "collection_source_01"],
      [shareId, "share_01"],
      [snapshotCollectionId, "collection_snapshot_01"],
      [subscribedCollectionId, "collection_subscription_01"]
    ]);
    return normalizeFixture({
      schemaVersion: 1,
      source: {
        nodeRoutes: "apps/backend/api/node-routes.json",
        routeSource: "apps/web/server/index.mjs",
        fixtureRuntime: "apps/web/server/services/test-database.mjs"
      },
      routes: readRouteInventory(),
      scenarios
    }, ids);
  } finally {
    await app.close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check") || !write;
  const fixture = await createFixture();
  if (write) {
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    console.log(`workspace emotes fixture written: ${fixturePath}`);
  }
  if (check) {
    const expected = JSON.parse(await readFile(fixturePath, "utf8"));
    assert.deepEqual(fixture, expected, "checked-in Workspace emotes fixture is stale; run --write after reviewing Node changes");
    console.log(`workspace emotes contract fixture PASS (${fixture.scenarios.length} scenarios, ${fixture.routes.length} routes)`);
  }
}

await main();
