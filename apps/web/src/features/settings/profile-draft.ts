import type { SettingsUser } from "./contracts";

export type ProfileDraftSnapshot = Readonly<{
  draft: string;
  saved: string;
  status: "idle" | "saving" | "saved" | "error";
  error: string;
}>;

/** One controller belongs to one mounted account. No draft or response crosses that boundary. */
export function createProfileDraft(initialName: string, persist: (nickname: string | null) => Promise<SettingsUser>, onSaved: (user: SettingsUser) => void, describeError: (error: unknown) => string) {
  let snapshot: ProfileDraftSnapshot = { draft: initialName, saved: initialName, status: "idle", error: "" };
  let alive = true;
  let request: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ProfileDraftSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    if (alive) listeners.forEach((listener) => listener());
  };
  const dirty = () => snapshot.draft.trim() !== snapshot.saved;
  const save = (): Promise<boolean> => {
    if (request) return request;
    if (!alive) return Promise.resolve(false);
    if (!dirty()) return Promise.resolve(true);
    const submitted = snapshot.draft.trim();
    if (submitted.length > 32) {
      publish({ status: "error", error: "公开昵称最多 32 个字符。" });
      return Promise.resolve(false);
    }
    publish({ status: "saving", error: "" });
    request = persist(submitted || null).then((user) => {
      if (!alive) return false;
      const saved = user.nickname ?? "";
      // A newer input belongs to the user, even if a previous save completes later.
      publish({ saved, draft: snapshot.draft.trim() === submitted ? saved : snapshot.draft, status: "saved", error: "" });
      onSaved(user);
      return !dirty();
    }).catch((error: unknown) => {
      if (alive) publish({ status: "error", error: describeError(error) });
      return false;
    }).finally(() => { request = null; });
    return request;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit: (draft: string) => publish({ draft, status: snapshot.status === "saving" ? "saving" : "idle", error: "" }),
    discard: () => {
      // An acknowledged result must settle before leaving: discarding cannot undo an accepted PATCH.
      if (request) return false;
      publish({ draft: snapshot.saved, error: "", status: "idle" });
      return true;
    },
    save,
    activate: () => { alive = true; },
    deactivate: () => { alive = false; }
  };
}
