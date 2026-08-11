export type WorkspaceFileCategory = "all" | "media" | "document" | "other";
export type WorkspaceFileViewMode = "list" | "grid";

const MEDIA_EXTENSIONS = new Set([
  "avif", "bmp", "gif", "heic", "heif", "jpg", "jpeg", "png", "svg", "webp",
  "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm"
]);

const DOCUMENT_EXTENSIONS = new Set([
  "csv", "doc", "docx", "epub", "html", "htm", "json", "log", "md", "markdown",
  "odf", "odg", "odp", "ods", "odt", "pdf", "ppt", "pptx", "rtf", "tex", "toml",
  "tsv", "txt", "xls", "xlsx", "xml", "yaml", "yml"
]);

const DOCUMENT_MIME_TYPES = new Set([
  "application/epub+zip",
  "application/json",
  "application/msword",
  "application/pdf",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/xml"
]);

function fileExtension(fileName: string) {
  const normalized = fileName.trim().toLowerCase();
  const index = normalized.lastIndexOf(".");
  return index > -1 && index < normalized.length - 1 ? normalized.slice(index + 1) : "";
}

export function classifyWorkspaceFile(file: { fileName: string; mimeType: string }): Exclude<WorkspaceFileCategory, "all"> {
  const mimeType = file.mimeType.trim().toLowerCase().split(";", 1)[0];
  const extension = fileExtension(file.fileName);
  if (mimeType.startsWith("image/") || mimeType.startsWith("video/") || MEDIA_EXTENSIONS.has(extension)) {
    return "media";
  }
  if (mimeType.startsWith("text/") || DOCUMENT_MIME_TYPES.has(mimeType) || DOCUMENT_EXTENSIONS.has(extension)) {
    return "document";
  }
  return "other";
}

export function workspaceFileMatchesCategory(
  file: { fileName: string; mimeType: string },
  category: WorkspaceFileCategory
) {
  return category === "all" || classifyWorkspaceFile(file) === category;
}
