import { openDB, type DBSchema, type IDBPDatabase } from "idb";

interface DualLaneWorkspaceDB extends DBSchema {
  drafts: {
    key: string; // conversationId
    value: {
      conversationId: string;
      text: string;
      replyToMessageId?: string;
      updatedAt: number;
    };
  };
  scrollPositions: {
    key: string; // conversationId
    value: {
      conversationId: string;
      scrollTop: number;
      anchorMessageId?: string;
      updatedAt: number;
    };
  };
  meta: {
    key: string;
    value: {
      key: string;
      value: string | number;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<DualLaneWorkspaceDB>> | null = null;

function getWorkspaceDB(): Promise<IDBPDatabase<DualLaneWorkspaceDB>> | null {
  if (typeof indexedDB === "undefined") {
    return null;
  }
  if (!dbPromise) {
    dbPromise = openDB<DualLaneWorkspaceDB>("duallane-workspace-v1", 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("drafts")) {
          db.createObjectStore("drafts", { keyPath: "conversationId" });
        }
        if (!db.objectStoreNames.contains("scrollPositions")) {
          db.createObjectStore("scrollPositions", { keyPath: "conversationId" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
      },
    });
  }
  return dbPromise;
}

export async function loadWorkspaceDrafts(): Promise<Record<string, { text: string; replyToMessageId?: string }>> {
  const db = getWorkspaceDB();
  if (!db) return {};
  try {
    const rows = await (await db).getAll("drafts");
    const result: Record<string, { text: string; replyToMessageId?: string }> = {};
    for (const row of rows) {
      if (row.text.trim()) {
        result[row.conversationId] = { text: row.text, replyToMessageId: row.replyToMessageId };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function saveWorkspaceDraft(
  conversationId: string,
  text: string,
  replyToMessageId?: string
): Promise<void> {
  const db = getWorkspaceDB();
  if (!db) return;
  try {
    const conn = await db;
    if (!text.trim()) {
      await conn.delete("drafts", conversationId);
      return;
    }
    await conn.put("drafts", {
      conversationId,
      text,
      replyToMessageId,
      updatedAt: Date.now(),
    });
  } catch {
    // Ignore quota/private-mode IndexedDB errors
  }
}

export async function saveWorkspaceScroll(
  conversationId: string,
  scrollTop: number,
  anchorMessageId?: string
): Promise<void> {
  const db = getWorkspaceDB();
  if (!db) return;
  try {
    await (await db).put("scrollPositions", {
      conversationId,
      scrollTop,
      anchorMessageId,
      updatedAt: Date.now(),
    });
  } catch {
    // Ignore
  }
}

export async function loadWorkspaceScrolls(): Promise<Record<string, number>> {
  const db = getWorkspaceDB();
  if (!db) return {};
  try {
    const rows = await (await db).getAll("scrollPositions");
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.conversationId] = row.scrollTop;
    }
    return result;
  } catch {
    return {};
  }
}

export async function getWorkspaceSyncCursor(): Promise<number> {
  const db = getWorkspaceDB();
  if (!db) return 0;
  try {
    const row = await (await db).get("meta", "syncSeq");
    return typeof row?.value === "number" ? row.value : 0;
  } catch {
    return 0;
  }
}

export async function setWorkspaceSyncCursor(seq: number): Promise<void> {
  const db = getWorkspaceDB();
  if (!db) return;
  try {
    await (await db).put("meta", { key: "syncSeq", value: seq });
  } catch {
    // Ignore
  }
}
