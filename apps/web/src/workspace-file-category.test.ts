import { describe, expect, it } from "vitest";
import { classifyWorkspaceFile, workspaceFileMatchesCategory } from "./workspace-file-category";

describe("workspace file categories", () => {
  it("groups images and videos as media", () => {
    expect(classifyWorkspaceFile({ fileName: "photo.bin", mimeType: "image/webp" })).toBe("media");
    expect(classifyWorkspaceFile({ fileName: "clip.mp4", mimeType: "application/octet-stream" })).toBe("media");
  });

  it("recognizes common documents by MIME type or extension", () => {
    expect(classifyWorkspaceFile({ fileName: "report.bin", mimeType: "application/pdf" })).toBe("document");
    expect(classifyWorkspaceFile({ fileName: "notes.md", mimeType: "application/octet-stream" })).toBe("document");
    expect(classifyWorkspaceFile({ fileName: "archive.zip", mimeType: "application/zip" })).toBe("other");
  });

  it("matches the all category without changing the detected category", () => {
    const file = { fileName: "movie.webm", mimeType: "video/webm" };
    expect(workspaceFileMatchesCategory(file, "all")).toBe(true);
    expect(workspaceFileMatchesCategory(file, "media")).toBe(true);
    expect(workspaceFileMatchesCategory(file, "document")).toBe(false);
  });
});
