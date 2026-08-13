import type { ImgHTMLAttributes } from "react";

export function getCachedEmoteImageSrc(src: string, version = __DUALLANE_APP_VERSION__) {
  if (!src.startsWith("/emotes/")) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}v=${encodeURIComponent(version)}`;
}

export function CachedEmoteImage({ src, alt, ...props }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  return <img {...props} src={getCachedEmoteImageSrc(src)} alt={alt} />;
}
