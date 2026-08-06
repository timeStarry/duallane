import { describe, expect, it } from "vitest";
import { isPreviewableImageMimeType, renamePastedImageFiles } from "./workspace-image-files";

describe("workspace pasted images", () => {
  const pastedAt = new Date(2026, 7, 6, 15, 4, 5);

  it("renames browser-generated image names with a readable timestamp", () => {
    const original = new File(["image"], "image.png", { type: "image/png", lastModified: 42 });
    const [renamed] = renamePastedImageFiles([original], pastedAt);

    expect(renamed.name).toBe("粘贴图片-20260806-150405.png");
    expect(renamed.type).toBe("image/png");
    expect(renamed.lastModified).toBe(42);
  });

  it("keeps user-provided file names unchanged", () => {
    const original = new File(["image"], "设计稿-final.png", { type: "image/png" });
    expect(renamePastedImageFiles([original], pastedAt)[0]).toBe(original);
  });

  it("uses MIME-derived extensions and unique suffixes for one paste", () => {
    const renamed = renamePastedImageFiles([
      new File(["a"], "image.jpeg", { type: "image/jpeg" }),
      new File(["b"], "image.png", { type: "image/webp" })
    ], pastedAt);

    expect(renamed.map((file) => file.name)).toEqual([
      "粘贴图片-20260806-150405.jpg",
      "粘贴图片-20260806-150405-2.webp"
    ]);
  });

  it("uses the same allowlist for message and file-library previews", () => {
    expect(isPreviewableImageMimeType("image/AVIF")).toBe(true);
    expect(isPreviewableImageMimeType("image/svg+xml")).toBe(false);
    expect(isPreviewableImageMimeType("application/pdf")).toBe(false);
  });
});
