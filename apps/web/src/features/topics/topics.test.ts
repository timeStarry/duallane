import { afterEach, describe, expect, it, vi } from "vitest";
import { createTopic, topicCreatePayload, validateTopicCreate } from "./create-topic";
import { createWorkspaceTopicSessionStore, type TopicPendingMessage } from "./session";

const fields = { conversationId: "group-a", title: "设计讨论", description: "背景与问题", allowSyncToGroup: true };
const document = (source: string) => ({ source, blocks: [{ type: "text" as const, text: source }] });
const pending = (topicId: string, draftRevision: number): TopicPendingMessage => ({
  id: "local-client-a", clientMessageId: "client-a", topicId, authorId: "user-a", authorKind: "human", author: { id: "user-a", displayName: "测试成员" },
  content: { format: "duallane.message+json;v=1", plainText: "原消息", blocks: [{ type: "text", text: "原消息" }] },
  plainText: "原消息", createdAt: "2026-09-11T00:00:00Z", localState: "failed", submission: { draftRevision, syncToGroup: true }
});

afterEach(() => vi.unstubAllGlobals());

describe("explicit topic creation", () => {
  it("preserves command-looking text as JSON description without constructing source syntax", () => {
    const description = ")\n#[不是第二个话题](正文)\n[link](https://example.test/a(b))";
    expect(topicCreatePayload({ ...fields, description }, "attempt-a")).toEqual({ title: fields.title, description, allowSyncToGroup: true, idempotencyKey: "attempt-a" });
    expect(topicCreatePayload({ ...fields, description }, "attempt-a")).not.toHaveProperty("source");
  });

  it("counts Unicode title characters and follows the existing title restrictions", () => {
    expect(validateTopicCreate({ ...fields, title: "😀".repeat(40) })).toBeNull();
    for (const title of ["😀".repeat(41), "", "a[b", "a]b", "a\nb"]) expect(validateTopicCreate({ ...fields, title })).not.toBeNull();
  });

  it("enforces both description limits and requires a parent group", () => {
    expect(validateTopicCreate({ ...fields, description: "字".repeat(30_000) })).toBeNull();
    expect(validateTopicCreate({ ...fields, description: "a".repeat(30_001) })).not.toBeNull();
    expect(validateTopicCreate({ ...fields, description: "😀".repeat(26_000) })).not.toBeNull();
    expect(validateTopicCreate({ ...fields, description: " \n " })).not.toBeNull();
    expect(validateTopicCreate({ ...fields, conversationId: "" })).not.toBeNull();
  });

  it("uses the authorized topic route with JSON fields and a stable caller-owned idempotency key", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ topic: { id: "topic-a" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await createTopic({ ...fields, conversationId: "group/a" }, "attempt-a");
    await createTopic({ ...fields, conversationId: "group/a" }, "attempt-a");
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("/api/workspace/conversations/group%2Fa/topics");
    expect(options.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(options.body).idempotencyKey).toBe("attempt-a");
    expect(fetch.mock.calls[1][1].body).toBe(options.body);
  });
});

describe("topic session ownership", () => {
  it("reports unsaved content across hidden topics without treating reading position as a draft", () => {
    const store = createWorkspaceTopicSessionStore();
    store.update("a", (current) => ({ ...current, scrollTop: 200, nearBottom: false }));
    expect(store.hasUnsaved()).toBe(false);
    store.edit("a", { draft: document("藏在另一话题的草稿") });
    expect(store.hasUnsaved()).toBe(true);
    store.enqueue("a", pending("a", store.get("a").draftRevision));
    store.acknowledge("a", "client-a");
    expect(store.hasUnsaved()).toBe(false);
    store.edit("b", { replyToMessageId: "reply-b" });
    expect(store.hasUnsaved()).toBe(true);
    store.enqueue("b", pending("b", store.get("b").draftRevision));
    store.acknowledge("b", "client-a");
    store.update("a", (current) => ({ ...current, pending: { "client-a": pending("a", 1) } }));
    expect(store.hasUnsaved()).toBe(true);
  });
  it("keeps text, reply, sync choice and reading position with their own topic", () => {
    const store = createWorkspaceTopicSessionStore();
    store.edit("a", { draft: document("A 草稿"), replyToMessageId: "reply-a", syncToGroup: true });
    store.update("a", (current) => ({ ...current, scrollTop: 420, nearBottom: false }));
    store.edit("b", { draft: document("B 草稿") });
    expect(store.get("a")).toMatchObject({ draft: { source: "A 草稿" }, replyToMessageId: "reply-a", syncToGroup: true, scrollTop: 420, nearBottom: false });
    expect(store.get("b")).toMatchObject({ draft: { source: "B 草稿" }, replyToMessageId: "", syncToGroup: false, scrollTop: null });
    expect(createWorkspaceTopicSessionStore().get("a").draft.source).toBe("");
  });

  it("does not treat an editor selection-only notification as a new submitted draft", () => {
    const store = createWorkspaceTopicSessionStore();
    store.edit("a", { draft: document("原消息") });
    const submitted = store.get("a");
    store.edit("a", { draft: document("原消息") });
    expect(store.get("a")).toBe(submitted);
    expect(store.enqueue("a", pending("a", submitted.draftRevision))).toBe(true);
    expect(store.get("a").draft.source).toBe("");
  });

  it("settles a late response only on its original target and preserves newer input", () => {
    const store = createWorkspaceTopicSessionStore();
    store.edit("a", { draft: document("原消息") });
    const revision = store.get("a").draftRevision;
    store.enqueue("a", pending("a", revision));
    store.edit("a", { draft: document("新的下一条") });
    store.edit("b", { draft: document("B 不能被清空") });
    store.acknowledge("a", "client-a", revision);
    expect(store.get("a").draft.source).toBe("新的下一条");
    expect(store.get("b").draft.source).toBe("B 不能被清空");
    expect(store.get("a").pending).toEqual({});
  });

  it("retains a failed submission's exact target, reply and synchronization choice for retry", () => {
    const store = createWorkspaceTopicSessionStore();
    const original = { ...pending("a", 3), replyToMessageId: "reply-a" };
    store.update("a", (current) => ({ ...current, pending: { "client-a": original } }));
    store.edit("b", { draft: document("别的话题"), syncToGroup: false });
    expect(store.get("a").pending["client-a"]).toMatchObject({ topicId: "a", replyToMessageId: "reply-a", clientMessageId: "client-a", submission: { syncToGroup: true } });
  });

  it("keeps a text draft when an immediate image emote is acknowledged", () => {
    const store = createWorkspaceTopicSessionStore();
    store.edit("a", { draft: document("接着写的正文"), replyToMessageId: "reply-a" });
    const revision = store.get("a").draftRevision;
    const image = pending("a", revision);
    store.enqueue("a", { ...image, submission: { ...image.submission, preserveDraft: true } });
    expect(store.get("a").draft.source).toBe("接着写的正文");
    store.acknowledge("a", "client-a", revision);
    expect(store.get("a").draft.source).toBe("接着写的正文");
    expect(store.get("a").replyToMessageId).toBe("");
  });

  it("releases pending media previews and clears all topic drafts on session reset", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const store = createWorkspaceTopicSessionStore();
    store.edit("a", { draft: document("不能留给下一个账号") });
    store.update("a", (current) => ({ ...current, pending: { "client-a": { ...pending("a", 1), pendingAttachments: [{ id: "file-a", file: new File(["synthetic"], "test.txt"), previewUrl: "blob:synthetic-preview", state: "failed", progress: 0 }] } } }));
    store.clear();
    expect(revoke).toHaveBeenCalledWith("blob:synthetic-preview");
    expect(store.hasUnsaved()).toBe(false);
    expect(store.get("a").pending).toEqual({});
    expect(store.get("a").draft.source).toBe("");
    revoke.mockRestore();
  });

  it("queues each submission independently and frees the editor before delivery finishes", () => {
    const store = createWorkspaceTopicSessionStore();
    store.edit("a", { draft: document("带附件的第一条"), replyToMessageId: "reply-a", syncToGroup: true });
    const attachment = { id: "photo", file: new File(["synthetic"], "photo.png"), state: "queued" as const, progress: 0 };
    const first = { ...pending("a", store.get("a").draftRevision), conversationId: "group-a", replyToMessageId: "reply-a", pendingAttachments: [attachment], localState: "uploading" as const };
    expect(store.enqueue("a", first)).toBe(true);
    expect(store.get("a")).toMatchObject({ conversationId: "group-a", draft: { source: "" }, replyToMessageId: "", syncToGroup: false });
    expect(store.claimDelivery("a", "client-a")).toBe(first);
    expect(store.claimDelivery("a", "client-a")).toBeNull();
    store.edit("a", { draft: document("上传期间继续发送") });
    const second = { ...pending("a", store.get("a").draftRevision), id: "local-client-b", clientMessageId: "client-b", localState: "sending" as const };
    expect(store.enqueue("a", second)).toBe(true);
    expect(store.claimDelivery("a", "client-b")).toBe(second);
    store.edit("a", { draft: document("第三条尚未发送") });
    store.acknowledge("a", "client-b");
    store.finishDelivery("a", "client-b");
    expect(store.get("a").pending["client-a"]).toBe(first);
    expect(store.get("a").draft.source).toBe("第三条尚未发送");
    store.finishDelivery("a", "client-a");
    expect(store.claimDelivery("a", "client-a")).toBe(first);
    expect(first.pendingAttachments[0]).toBe(attachment);
  });

  it("rejects stale draft submissions and never lets a duplicate acknowledgement clear newer input", () => {
    const store = createWorkspaceTopicSessionStore();
    store.edit("a", { draft: document("原草稿") });
    const first = pending("a", store.get("a").draftRevision);
    store.edit("a", { draft: document("新草稿") });
    expect(store.enqueue("a", first)).toBe(false);
    store.acknowledge("a", "client-a", store.get("a").draftRevision);
    expect(store.get("a").draft.source).toBe("新草稿");
    expect(store.get("a").pending).toEqual({});
  });

  it("removes every topic owned by a revoked conversation while preserving other groups", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const cancel = vi.fn();
    const store = createWorkspaceTopicSessionStore();
    store.bindConversation("a", "group-a");
    store.edit("a", { draft: document("已撤销群的隐藏草稿") });
    store.bindConversation("b", "group-b");
    store.edit("b", { draft: document("其它群的草稿") });
    const attachment = { id: "photo", file: new File(["synthetic"], "photo.png"), previewUrl: "blob:revoked-photo", state: "uploading" as const, progress: 10 };
    store.update("c", (current) => ({ ...current, pending: { "client-a": { ...pending("c", 0), conversationId: "group-a", pendingAttachments: [attachment] } } }));
    expect(store.removeConversation("group-a", cancel)).toEqual(["a", "c"]);
    expect(cancel).toHaveBeenCalledWith([attachment]);
    expect(revoke).toHaveBeenCalledWith("blob:revoked-photo");
    expect(store.get("a").draft.source).toBe("");
    expect(store.get("c").pending).toEqual({});
    expect(store.claimDelivery("c", "client-a")).toBeNull();
    expect(store.get("b").draft.source).toBe("其它群的草稿");
    revoke.mockRestore();
  });

  it("notifies only the affected topic and allows Strict Mode unsubscribe", () => {
    const store = createWorkspaceTopicSessionStore();
    const listener = vi.fn();
    const stop = store.subscribe("a", listener);
    store.edit("b", { draft: document("B") });
    expect(listener).not.toHaveBeenCalled();
    store.edit("a", { draft: document("A") });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    store.edit("a", { draft: document("A2") });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
