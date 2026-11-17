export function triggerBrowserDownload(url: string, fileName: string): void {
  if (!url || typeof document === "undefined") return;
  const safeName = (fileName || "download").replace(/[\r\n/\\]+/g, "_");
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeName;
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}
