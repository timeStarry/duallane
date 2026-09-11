import { describe, expect, it, vi } from "vitest";
import { createProfileDraft } from "./profile-draft";
import type { SettingsUser } from "./contracts";

const user = (nickname: string | null): SettingsUser => ({ id: "member-a", displayName: nickname || "github-name", nickname, kind: "human", role: "member", joinedAt: "2026-09-11T00:00:00Z" });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("personal profile draft", () => {
  it("does not send edits until explicitly saved and preserves the existing null-nickname contract", async () => {
    const persist = vi.fn(async (nickname: string | null) => user(nickname));
    const profile = createProfileDraft("旧名字", persist, vi.fn(), () => "保存失败");
    profile.edit("  ");
    expect(persist).not.toHaveBeenCalled();
    expect(await profile.save()).toBe(true);
    expect(persist).toHaveBeenCalledExactlyOnceWith(null);
    expect(profile.getSnapshot()).toMatchObject({ saved: "", draft: "", status: "saved" });
  });

  it("keeps failed input and retries the actual persistence operation", async () => {
    const persist = vi.fn<(nickname: string | null) => Promise<SettingsUser>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(user("新名字"));
    const profile = createProfileDraft("旧名字", persist, vi.fn(), () => "网络失败，请重试");
    profile.edit("新名字");
    expect(await profile.save()).toBe(false);
    expect(profile.getSnapshot()).toMatchObject({ saved: "旧名字", draft: "新名字", status: "error", error: "网络失败，请重试" });
    expect(await profile.save()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(profile.getSnapshot()).toMatchObject({ saved: "新名字", draft: "新名字", status: "saved" });
  });

  it("shares a pending save and never clears a later edit with its result", async () => {
    const pending = deferred<SettingsUser>();
    const persist = vi.fn(() => pending.promise);
    const profile = createProfileDraft("旧名字", persist, vi.fn(), () => "保存失败");
    profile.edit("提交的名字");
    const first = profile.save();
    expect(profile.save()).toBe(first);
    profile.edit("更新的草稿");
    pending.resolve(user("提交的名字"));
    expect(await first).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(profile.getSnapshot()).toMatchObject({ saved: "提交的名字", draft: "更新的草稿" });
  });

  it("does not deliver a departed account's late response", async () => {
    const pending = deferred<SettingsUser>();
    const onSaved = vi.fn();
    const profile = createProfileDraft("旧名字", () => pending.promise, onSaved, () => "保存失败");
    profile.edit("新名字");
    const saving = profile.save();
    profile.deactivate();
    pending.resolve(user("新名字"));
    expect(await saving).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("discard restores the last successful value without reverting it on the server", async () => {
    const persist = vi.fn(async (nickname: string | null) => user(nickname));
    const profile = createProfileDraft("旧名字", persist, vi.fn(), () => "保存失败");
    profile.edit("已保存名字");
    await profile.save();
    profile.edit("未提交名字");
    profile.discard();
    expect(profile.getSnapshot()).toMatchObject({ saved: "已保存名字", draft: "已保存名字", status: "idle" });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await profile.save()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("refuses to discard a submitted save until the response settles", async () => {
    const pending = deferred<SettingsUser>();
    const onSaved = vi.fn();
    const profile = createProfileDraft("旧名字", () => pending.promise, onSaved, () => "保存失败");
    profile.edit("提交的名字");
    const saving = profile.save();
    expect(profile.discard()).toBe(false);
    expect(profile.getSnapshot()).toMatchObject({ draft: "提交的名字", saved: "旧名字", status: "saving" });
    pending.resolve(user("提交的名字"));
    expect(await saving).toBe(true);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(user("提交的名字"));
    expect(profile.discard()).toBe(true);
    expect(profile.getSnapshot()).toMatchObject({ draft: "提交的名字", saved: "提交的名字", status: "idle" });
  });

  it("validates length before persistence and tolerates Strict Mode activation", async () => {
    const persist = vi.fn(async (nickname: string | null) => user(nickname));
    const profile = createProfileDraft("旧名字", persist, vi.fn(), () => "保存失败");
    profile.deactivate(); profile.activate();
    profile.edit("字".repeat(33));
    expect(await profile.save()).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    profile.edit("有效名字");
    expect(await profile.save()).toBe(true);
  });
});
