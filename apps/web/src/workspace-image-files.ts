const PREVIEWABLE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp"
]);

const PASTED_IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp"
};

const GENERIC_PASTED_IMAGE_NAME = /^image(?:\s*\(\d+\)|[-_ ]?\d+)?\.(?:png|jpe?g|gif|webp|avif|bmp)$/i;

export function isPreviewableImageMimeType(mimeType: string) {
  return PREVIEWABLE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function renamePastedImageFiles(files: File[], pastedAt = new Date()): File[] {
  let renamedCount = 0;
  return files.map((file) => {
    if (!isPreviewableImageMimeType(file.type) || (file.name && !GENERIC_PASTED_IMAGE_NAME.test(file.name))) {
      return file;
    }

    renamedCount += 1;
    const suffix = renamedCount > 1 ? `-${renamedCount}` : "";
    const extension = PASTED_IMAGE_EXTENSION_BY_MIME_TYPE[file.type.toLowerCase()] ?? "png";
    const generatedName = `粘贴图片-${formatPastedImageTimestamp(pastedAt)}${suffix}.${extension}`;
    return new File([file], generatedName, {
      type: file.type,
      lastModified: file.lastModified
    });
  });
}

function formatPastedImageTimestamp(value: Date) {
  const part = (number: number) => String(number).padStart(2, "0");
  return [
    value.getFullYear(),
    part(value.getMonth() + 1),
    part(value.getDate()),
    "-",
    part(value.getHours()),
    part(value.getMinutes()),
    part(value.getSeconds())
  ].join("");
}
