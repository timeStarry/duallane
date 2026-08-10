type UnreadFaviconOptions = {
  active: boolean;
  documentVisible: boolean;
};

const ORIGINAL_HREF_DATA_KEY = "duallaneOriginalHref";

export function installWorkspaceUnreadFavicon({ active, documentVisible }: UnreadFaviconOptions) {
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
  for (const link of links) {
    if (!link.dataset[ORIGINAL_HREF_DATA_KEY]) {
      link.dataset[ORIGINAL_HREF_DATA_KEY] = link.getAttribute("href") || "/favicon.ico";
    }
  }
  const restore = () => {
    for (const link of links) {
      link.href = link.dataset[ORIGINAL_HREF_DATA_KEY] || "/favicon.ico";
    }
  };
  if (!active || links.length === 0) {
    restore();
    return restore;
  }

  let cancelled = false;
  let interval = 0;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  void createAlertFavicon().then((alertHref) => {
    if (cancelled || !alertHref) return;
    const showAlert = () => links.forEach((link) => { link.href = alertHref; });
    if (documentVisible || reducedMotion) {
      showAlert();
      return;
    }
    let alertVisible = true;
    showAlert();
    interval = window.setInterval(() => {
      alertVisible = !alertVisible;
      if (alertVisible) showAlert();
      else restore();
    }, 900);
  });

  return () => {
    cancelled = true;
    if (interval) window.clearInterval(interval);
    restore();
  };
}

async function createAlertFavicon() {
  const image = await loadImage("/favicon-32x32.png");
  if (!image) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, 32, 32);
  context.beginPath();
  context.arc(25.5, 6.5, 5.5, 0, Math.PI * 2);
  context.fillStyle = "#c83f37";
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = "#fffdf8";
  context.stroke();
  return canvas.toDataURL("image/png");
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}
