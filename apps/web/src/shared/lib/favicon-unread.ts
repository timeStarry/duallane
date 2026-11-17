import { useEffect } from "react";

const BASE_TITLE = "DualLane";
const ORIGINAL_HREF_ATTR = "data-dl-orig-href";

function loadFaviconImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function renderBadgedFaviconDataUrl(baseHref: string): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  let ctx: CanvasRenderingContext2D | null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return null;
  }
  if (!ctx) return null;

  const img = await loadFaviconImage(baseHref || "/favicon-32x32.png");
  if (img) {
    ctx.drawImage(img, 0, 0, 32, 32);
  } else {
    // Crisp fallback DualLane squircle if favicon image asset is absent in dev
    ctx.fillStyle = "#0F172A";
    ctx.beginPath();
    ctx.roundRect?.(2, 2, 28, 28, 8);
    ctx.fill();
    ctx.fillStyle = "#0EA5E9";
    ctx.beginPath();
    ctx.arc(15, 16, 7, 0, Math.PI * 2);
    ctx.fill();
  }

  // Crisp unread dot at top-right
  ctx.beginPath();
  ctx.arc(25, 7, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = "#EF4444";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#FFFFFF";
  ctx.stroke();

  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

export function useFaviconUnreadBadge(unreadCount: number): void {
  useEffect(() => {
    if (typeof document === "undefined") return;

    const safeCount = Math.max(0, Math.trunc(unreadCount || 0));
    document.title =
      safeCount > 0
        ? `(${safeCount > 99 ? "99+" : safeCount}) ${BASE_TITLE}`
        : BASE_TITLE;

    let links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
    if (links.length === 0 && safeCount > 0 && document.head) {
      const created = document.createElement("link");
      created.rel = "icon";
      created.href = "/favicon.ico";
      document.head.appendChild(created);
      links = [created];
    }

    for (const link of links) {
      if (!link.hasAttribute(ORIGINAL_HREF_ATTR)) {
        link.setAttribute(ORIGINAL_HREF_ATTR, link.getAttribute("href") || "/favicon.ico");
      }
    }

    const restoreFavicons = () => {
      for (const link of links) {
        const orig = link.getAttribute(ORIGINAL_HREF_ATTR);
        if (orig) link.href = orig;
      }
    };

    if (safeCount === 0) {
      restoreFavicons();
      return;
    }

    let cancelled = false;
    const primaryOrig = links[0]?.getAttribute(ORIGINAL_HREF_ATTR) || "/favicon-32x32.png";
    void renderBadgedFaviconDataUrl(primaryOrig).then((dataUrl) => {
      if (cancelled || !dataUrl) return;
      for (const link of links) {
        link.href = dataUrl;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [unreadCount]);
}
