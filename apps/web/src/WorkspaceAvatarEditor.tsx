import { Camera, Minus, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { WorkspaceAvatar } from "./WorkspaceAvatar";

const CLIENT_MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type WorkspaceAvatarEditorProps = {
  name: string;
  avatarUrl?: string;
  busy: boolean;
  onUpload: (blob: Blob) => Promise<void>;
  onDelete: () => Promise<void>;
  onError: (message: string) => void;
};

export function WorkspaceAvatarEditor({
  name,
  avatarUrl,
  busy,
  onUpload,
  onDelete,
  onError
}: WorkspaceAvatarEditorProps) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }, [sourceUrl]);

  useEffect(() => {
    if (!sourceUrl) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      triggerRef.current?.focus();
    };
  }, [sourceUrl]);

  function closeEditor() {
    setSourceUrl("");
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedArea(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function selectFile(file?: File) {
    if (!file) return;
    if (!ACCEPTED_TYPES.has(file.type)) {
      onError("头像仅支持 JPEG、PNG 或 WebP");
      return;
    }
    if (file.size > CLIENT_MAX_BYTES) {
      onError("头像原图不能超过 10 MiB");
      return;
    }
    setSourceUrl(URL.createObjectURL(file));
  }

  async function saveCrop() {
    if (!sourceUrl || !croppedArea) return;
    try {
      await onUpload(await renderAvatarCrop(sourceUrl, croppedArea));
      closeEditor();
    } catch (error) {
      onError(error instanceof Error ? error.message : "头像上传失败");
    }
  }

  return (
    <>
      <div className="workspace-avatar-editor-row">
        <WorkspaceAvatar name={name} avatarUrl={avatarUrl} className="workspace-account-avatar" />
        <div>
          <strong>头像</strong>
          <p>支持 JPEG、PNG、WebP，裁剪后保存为方形头像。</p>
          <div className="workspace-avatar-actions">
            <button ref={triggerRef} className="secondary compact" type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
              <Camera size={16} />
              更换头像
            </button>
            {avatarUrl?.startsWith("/api/workspace/avatars/") && (
              <button className="ghost-button compact" type="button" disabled={busy} onClick={() => void onDelete()}>
                <Trash2 size={15} />
                恢复 GitHub 头像
              </button>
            )}
          </div>
        </div>
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => selectFile(event.target.files?.[0])}
        />
      </div>

      {sourceUrl && (
        <div
          className="workspace-avatar-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditor();
          }}
        >
          <section
            className="workspace-avatar-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-avatar-dialog-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeEditor();
              if (event.key !== "Tab") return;
              const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
              const first = focusable[0];
              const last = focusable.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <header>
              <div>
                <p className="eyebrow">公开资料</p>
                <h3 id="workspace-avatar-dialog-title">调整头像</h3>
              </div>
              <button ref={closeRef} className="icon-button" type="button" title="关闭" onClick={closeEditor}>
                <X size={17} />
              </button>
            </header>
            <div className="workspace-avatar-cropper">
              <Cropper
                image={sourceUrl}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                minZoom={1}
                maxZoom={4}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={(_area, pixels) => setCroppedArea(pixels)}
              />
            </div>
            <label className="workspace-avatar-zoom">
              <Minus size={15} aria-hidden="true" />
              <span className="sr-only">缩放头像</span>
              <input type="range" min="1" max="4" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
              <Plus size={15} aria-hidden="true" />
            </label>
            <footer>
              <button className="secondary" type="button" onClick={closeEditor}>取消</button>
              <button className="primary" type="button" disabled={busy || !croppedArea} onClick={() => void saveCrop()}>
                {busy ? "保存中" : "保存头像"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

async function renderAvatarCrop(sourceUrl: string, crop: Area) {
  const image = await loadImage(sourceUrl);
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("当前浏览器无法处理头像");
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("头像处理失败")), "image/webp", 0.9);
  });
}

function loadImage(sourceUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("头像原图无法读取"));
    image.src = sourceUrl;
  });
}
