import { describe, expect, it } from "vitest";
import {
  getEmotePickerPackStorageKey,
  getPreferredEmotePickerPack,
  rememberPreferredEmotePickerPack
} from "./emote-picker-preference";

function createStorage(initialValue?: string) {
  const values = new Map<string, string>();
  if (initialValue) values.set(getEmotePickerPackStorageKey("workspace-composer"), initialValue);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}

describe("emote picker pack preference", () => {
  it("restores the last explicitly selected available pack", () => {
    const storage = createStorage();
    rememberPreferredEmotePickerPack("workspace-composer", "feishu", storage);
    expect(getPreferredEmotePickerPack("workspace-composer", ["custom", "emoji", "feishu"], "custom", storage)).toBe("feishu");
  });

  it("falls back without overwriting a pack unavailable in the current picker", () => {
    const storage = createStorage("custom");
    expect(getPreferredEmotePickerPack("workspace-composer", ["emoji", "feishu"], "emoji", storage)).toBe("emoji");
    expect(storage.getItem(getEmotePickerPackStorageKey("workspace-composer"))).toBe("custom");
  });

  it("keeps composer and Reaction preferences independent", () => {
    const storage = createStorage();
    rememberPreferredEmotePickerPack("workspace-composer", "custom", storage);
    rememberPreferredEmotePickerPack("workspace-reaction", "wechat", storage);
    expect(getPreferredEmotePickerPack("workspace-composer", ["custom", "emoji"], "custom", storage)).toBe("custom");
    expect(getPreferredEmotePickerPack("workspace-reaction", ["emoji", "wechat"], "emoji", storage)).toBe("wechat");
  });

  it("tolerates unavailable browser storage", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); }
    };
    expect(getPreferredEmotePickerPack("p2p", ["emoji"], "emoji", storage)).toBe("emoji");
    expect(() => rememberPreferredEmotePickerPack("p2p", "emoji", storage)).not.toThrow();
  });
});
