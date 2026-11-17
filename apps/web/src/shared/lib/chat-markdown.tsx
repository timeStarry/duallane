import React, { useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink, ShieldAlert } from "lucide-react";
import { create } from "zustand";
import { renderMessageParts } from "@/emotes";
import { cn } from "@/shared/lib/cn";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui";

export type ChatMarkdownLane = "workspace" | "p2p";

export const TRUSTED_EXTERNAL_DOMAINS: readonly string[] = [
  "github.com",
  "gist.github.com",
  "npmjs.com",
  "pkg.go.dev",
  "crates.io",
  "pypi.org",
  "developer.mozilla.org",
  "stackoverflow.com",
  "arxiv.org",
  "bilibili.com",
  "youtube.com",
  "youtu.be",
  "zhihu.com",
  "juejin.cn",
  "v2ex.com",
  "mp.weixin.qq.com",
  "wikipedia.org",
  "figma.com",
  "notion.site",
  "feishu.cn",
  "tsio.top",
] as const;

export interface LinkRiskFlags {
  isRawIp: boolean;
  hasUserInfo: boolean;
  isPunycode: boolean;
}

export interface ClassifiedChatLink {
  valid: boolean;
  normalizedUrl: string;
  hostname: string;
  protocol: string;
  kind: "same-origin" | "trusted-external" | "untrusted-external" | "invalid";
  riskFlags: LinkRiskFlags;
}

interface ExternalLinkGuardState {
  pendingLink: ClassifiedChatLink | null;
  openGuard: (link: ClassifiedChatLink) => void;
  closeGuard: () => void;
}

export const useExternalLinkGuardStore = create<ExternalLinkGuardState>((set) => ({
  pendingLink: null,
  openGuard: (pendingLink) => set({ pendingLink }),
  closeGuard: () => set({ pendingLink: null }),
}));

function detectRawIpHost(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase();
  if (!clean) return false;
  if (clean.startsWith("[") || clean.includes(":")) {
    return true;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(clean)) {
    return true;
  }
  if (/^\d+$/.test(clean) || /^0x[0-9a-f]+$/i.test(clean)) {
    return true;
  }
  return false;
}

function detectAuthorityUserInfo(rawUrl: string): boolean {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(rawUrl.trim());
  if (!match?.[1]) return false;
  return match[1].includes("@");
}

export function isTrustedExternalDomain(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return TRUSTED_EXTERNAL_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

export function classifyChatLink(
  rawUrl: string,
  currentOrigin?: string
): ClassifiedChatLink {
  const trimmed = rawUrl.trim();
  const emptyFlags: LinkRiskFlags = {
    isRawIp: false,
    hasUserInfo: false,
    isPunycode: false,
  };
  if (!trimmed) {
    return {
      valid: false,
      normalizedUrl: "",
      hostname: "",
      protocol: "",
      kind: "invalid",
      riskFlags: emptyFlags,
    };
  }

  const effectiveOrigin =
    currentOrigin !== undefined
      ? currentOrigin
      : typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";

  let parsed: URL;
  try {
    parsed = trimmed.startsWith("/") && !trimmed.startsWith("//") && effectiveOrigin
      ? new URL(trimmed, effectiveOrigin)
      : new URL(trimmed);
  } catch {
    return {
      valid: false,
      normalizedUrl: "",
      hostname: "",
      protocol: "",
      kind: "invalid",
      riskFlags: emptyFlags,
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      normalizedUrl: "",
      hostname: "",
      protocol: parsed.protocol,
      kind: "invalid",
      riskFlags: emptyFlags,
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const hasUserInfo =
    Boolean(parsed.username || parsed.password) || detectAuthorityUserInfo(trimmed);
  const isRawIp = detectRawIpHost(hostname);
  const isPunycode = hostname
    .split(".")
    .some((label) => label.toLowerCase().startsWith("xn--"));

  const riskFlags: LinkRiskFlags = {
    isRawIp,
    hasUserInfo,
    isPunycode,
  };

  if (effectiveOrigin && parsed.origin === effectiveOrigin && !hasUserInfo) {
    return {
      valid: true,
      normalizedUrl: parsed.toString(),
      hostname,
      protocol: parsed.protocol,
      kind: "same-origin",
      riskFlags,
    };
  }

  if (
    parsed.protocol === "https:" &&
    !hasUserInfo &&
    !isRawIp &&
    !isPunycode &&
    isTrustedExternalDomain(hostname)
  ) {
    return {
      valid: true,
      normalizedUrl: parsed.toString(),
      hostname,
      protocol: parsed.protocol,
      kind: "trusted-external",
      riskFlags,
    };
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString(),
    hostname,
    protocol: parsed.protocol,
    kind: "untrusted-external",
    riskFlags,
  };
}

const ALWAYS_STRIP_TRAILING_CHARS = new Set([
  "。",
  "，",
  "！",
  "？",
  "；",
  "：",
  "、",
  ".",
  ",",
  "!",
  "?",
  ";",
  ":",
  "'",
  '"',
  "”",
  "’",
  "》",
  ">",
]);

const PAIRED_CLOSERS: Record<string, string> = {
  ")": "(",
  "）": "（",
  "】": "【",
  "]": "[",
};

function countChar(str: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < str.length; i += 1) {
    if (str[i] === ch) count += 1;
  }
  return count;
}

export function splitTrailingUrlPunctuation(rawCandidate: string): {
  cleanUrl: string;
  trailing: string;
} {
  let end = rawCandidate.length;
  while (end > 0) {
    const ch = rawCandidate[end - 1]!;
    if (ALWAYS_STRIP_TRAILING_CHARS.has(ch)) {
      end -= 1;
      continue;
    }
    const opener = PAIRED_CLOSERS[ch];
    if (opener) {
      const slice = rawCandidate.slice(0, end);
      if (countChar(slice, ch) > countChar(slice, opener)) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return {
    cleanUrl: rawCandidate.slice(0, end),
    trailing: rawCandidate.slice(end),
  };
}

export function ChatSafeLink({
  url,
  lane = "workspace",
  className,
  children,
}: {
  url: string;
  lane?: ChatMarkdownLane;
  className?: string;
  children: React.ReactNode;
}) {
  const info = classifyChatLink(url);
  if (!info.valid) {
    return <span>{children}</span>;
  }

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    if (lane === "workspace" && info.kind === "untrusted-external") {
      e.preventDefault();
      useExternalLinkGuardStore.getState().openGuard(info);
    }
  };

  return (
    <a
      href={info.normalizedUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className={cn(
        "underline underline-offset-2 decoration-current/55 hover:decoration-current break-all [overflow-wrap:anywhere] transition-colors",
        className
      )}
    >
      {children}
    </a>
  );
}

export function ExternalLinkGuardDialog() {
  const { pendingLink, closeGuard } = useExternalLinkGuardStore();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!pendingLink) return;
    try {
      await navigator.clipboard?.writeText(pendingLink.normalizedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Fallback textarea copy
      try {
        const el = document.createElement("textarea");
        el.value = pendingLink.normalizedUrl;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      } catch {
        // Ignore
      }
    }
  };

  const handleContinue = () => {
    if (!pendingLink) return;
    const targetUrl = pendingLink.normalizedUrl;
    closeGuard();
    if (typeof window !== "undefined") {
      window.open(targetUrl, "_blank", "noopener,noreferrer");
    }
  };

  const hasRiskWarning = Boolean(
    pendingLink &&
      (pendingLink.riskFlags.isRawIp ||
        pendingLink.riskFlags.hasUserInfo ||
        pendingLink.riskFlags.isPunycode ||
        pendingLink.protocol === "http:")
  );

  return (
    <Dialog
      open={Boolean(pendingLink)}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          closeGuard();
        }
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 shrink-0 text-dl-warning" strokeWidth={2} />
            <span>即将离开 DualLane 前往外部网站</span>
          </DialogTitle>
          <DialogDescription>
            该链接不在空间内置可信域名白名单中，请核对目标站点后再继续访问。
          </DialogDescription>
        </DialogHeader>

        {pendingLink && (
          <div className="space-y-3 px-6 max-narrow:px-4 py-4">
            <div className="rounded-xl border border-dl-border-hairline bg-dl-surface-subtle/65 p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="text-[11px] font-medium text-dl-text-tertiary">目标域名</span>
                <div className="flex flex-wrap items-center gap-1">
                  {pendingLink.riskFlags.isRawIp && (
                    <span
                      data-testid="link-risk-raw-ip"
                      className="inline-flex items-center gap-1 rounded-full bg-dl-warning/16 px-2 py-0.5 text-[10px] font-semibold text-dl-warning"
                    >
                      <AlertTriangle className="size-2.5" />
                      IP 直连地址
                    </span>
                  )}
                  {pendingLink.riskFlags.hasUserInfo && (
                    <span
                      data-testid="link-risk-userinfo"
                      className="inline-flex items-center gap-1 rounded-full bg-dl-danger/15 px-2 py-0.5 text-[10px] font-semibold text-dl-danger"
                    >
                      <AlertTriangle className="size-2.5" />
                      包含 @ 混淆信息
                    </span>
                  )}
                  {pendingLink.riskFlags.isPunycode && (
                    <span
                      data-testid="link-risk-punycode"
                      className="inline-flex items-center gap-1 rounded-full bg-dl-warning/16 px-2 py-0.5 text-[10px] font-semibold text-dl-warning"
                    >
                      <AlertTriangle className="size-2.5" />
                      国际化编码域名 (xn--)
                    </span>
                  )}
                  {pendingLink.protocol === "http:" && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-dl-warning/16 px-2 py-0.5 text-[10px] font-semibold text-dl-warning">
                      未加密 HTTP
                    </span>
                  )}
                </div>
              </div>
              <div
                data-testid="external-link-guard-hostname"
                className={cn(
                  "font-mono text-sm font-bold break-all",
                  hasRiskWarning ? "text-dl-warning" : "text-dl-text-primary"
                )}
              >
                {pendingLink.hostname}
              </div>
              <div className="border-t border-dl-border-hairline pt-2 font-mono text-[11.5px] leading-relaxed text-dl-text-secondary break-all max-h-24 overflow-y-auto dl-scroll">
                {pendingLink.normalizedUrl}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={() => void handleCopy()}
          >
            {copied ? (
              <>
                <Check className="size-3.5 text-dl-success" strokeWidth={2} />
                已复制链接
              </>
            ) : (
              <>
                <Copy className="size-3.5" strokeWidth={1.85} />
                复制链接
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="gap-1.5"
            onClick={handleContinue}
          >
            <span>继续前往</span>
            <ExternalLink className="size-3.5" strokeWidth={1.9} />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CopyCodeBlockButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={copied ? "已复制代码" : "复制代码"}
      className="h-5 gap-1 px-1.5 text-[10px] text-white/80 hover:bg-white/15 hover:text-white"
      onClick={(e) => {
        e.stopPropagation();
        void navigator?.clipboard?.writeText?.(code).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check className="size-2.5" /> : <Copy className="size-2.5" />}
      <span>{copied ? "已复制" : "复制"}</span>
    </Button>
  );
}

// ============================================================================
// Inline AST / Token Parser (Zero-XSS)
// ============================================================================

function parseMarkdownLinkAt(
  src: string,
  startIdx: number
): { label: string; url: string; nextIdx: number } | null {
  if (src[startIdx] !== "[") return null;
  let labelEnd = -1;
  for (let i = startIdx + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\n") return null;
    if (ch === "\\" && i + 1 < src.length) {
      i += 1;
      continue;
    }
    if (ch === "[") return null; // Avoid matching emote tokens inside nested brackets like [[bili:doge]]
    if (ch === "]") {
      labelEnd = i;
      break;
    }
  }
  if (labelEnd === -1 || src[labelEnd + 1] !== "(") return null;

  const label = src.slice(startIdx + 1, labelEnd);
  if (!label.trim()) return null;

  let depth = 1;
  let urlEnd = -1;
  for (let j = labelEnd + 2; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === "\n" || ch === " " || ch === "\t") return null;
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        urlEnd = j;
        break;
      }
    }
  }
  if (urlEnd === -1) return null;
  const url = src.slice(labelEnd + 2, urlEnd).trim();
  if (!url) return null;
  return { label, url, nextIdx: urlEnd + 1 };
}

const BARE_URL_HEAD_RE =
  /^https?:\/\/[^\s<>`"'\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65“”‘’]+/i;

export function renderInlineMarkdownNodes(
  text: string,
  lane: ChatMarkdownLane,
  keyPrefix = "in",
  allowLinks = true
): React.ReactNode {
  if (!text) return null;

  const nodes: React.ReactNode[] = [];
  let plainBuffer = "";
  let i = 0;

  const flushPlain = (idxKey: number) => {
    if (!plainBuffer) return;
    const chunk = plainBuffer;
    plainBuffer = "";
    nodes.push(
      <React.Fragment key={`${keyPrefix}_p_${idxKey}`}>
        {renderMessageParts(chunk)}
      </React.Fragment>
    );
  };

  while (i < text.length) {
    const ch = text[i]!;

    // 1. Inline code: `code`
    if (ch === "`") {
      const closeTick = text.indexOf("`", i + 1);
      if (closeTick > i + 1 && !text.slice(i + 1, closeTick).includes("\n")) {
        flushPlain(i);
        const codeContent = text.slice(i + 1, closeTick);
        nodes.push(
          <code
            key={`${keyPrefix}_ic_${i}`}
            className="mx-0.5 rounded-md bg-black/14 dark:bg-white/14 px-1.5 py-0.5 font-mono text-[12px] whitespace-pre-wrap break-all [overflow-wrap:anywhere]"
          >
            {codeContent}
          </code>
        );
        i = closeTick + 1;
        continue;
      }
    }

    // 2. @所有人 pill
    if (ch === "@" && text.startsWith("@所有人", i)) {
      flushPlain(i);
      nodes.push(
        <span
          key={`${keyPrefix}_all_${i}`}
          className="mx-0.5 inline-flex items-center rounded-md bg-black/14 dark:bg-white/16 px-1.5 py-0.5 text-[13px] font-semibold"
        >
          @所有人
        </span>
      );
      i += 4;
      continue;
    }

    // 3. Markdown link: [label](url)
    if (allowLinks && ch === "[") {
      const mdLink = parseMarkdownLinkAt(text, i);
      if (mdLink) {
        const classified = classifyChatLink(mdLink.url);
        if (classified.valid) {
          flushPlain(i);
          nodes.push(
            <ChatSafeLink key={`${keyPrefix}_ml_${i}`} url={mdLink.url} lane={lane}>
              {renderInlineMarkdownNodes(mdLink.label, lane, `${keyPrefix}_mll_${i}`, false)}
            </ChatSafeLink>
          );
          i = mdLink.nextIdx;
          continue;
        }
      }
    }

    // 4. Bare URL: https://... or http://...
    if (
      allowLinks &&
      (ch === "h" || ch === "H") &&
      (text.slice(i, i + 8).toLowerCase() === "https://" ||
        text.slice(i, i + 7).toLowerCase() === "http://")
    ) {
      const prevChar = i > 0 ? text[i - 1]! : "";
      // Avoid matching inside another word/scheme
      if (!prevChar || !/[a-zA-Z0-9_/-]/.test(prevChar)) {
        const rawMatch = BARE_URL_HEAD_RE.exec(text.slice(i));
        if (rawMatch?.[0]) {
          const { cleanUrl, trailing } = splitTrailingUrlPunctuation(rawMatch[0]);
          const classified = classifyChatLink(cleanUrl);
          if (classified.valid && cleanUrl.length > 8) {
            flushPlain(i);
            nodes.push(
              <ChatSafeLink key={`${keyPrefix}_bu_${i}`} url={cleanUrl} lane={lane}>
                {cleanUrl}
              </ChatSafeLink>
            );
            i += cleanUrl.length;
            void trailing; // Remaining trailing chars will be processed naturally from new `i`
            continue;
          }
        }
      }
    }

    // 5. Bold: **bold**
    if (ch === "*" && text[i + 1] === "*") {
      const closeBold = text.indexOf("**", i + 2);
      if (closeBold > i + 2 && !text.slice(i + 2, closeBold).includes("\n")) {
        flushPlain(i);
        const inner = text.slice(i + 2, closeBold);
        nodes.push(
          <strong key={`${keyPrefix}_b_${i}`} className="font-bold">
            {renderInlineMarkdownNodes(inner, lane, `${keyPrefix}_bi_${i}`, allowLinks)}
          </strong>
        );
        i = closeBold + 2;
        continue;
      }
    }

    // 6. Strikethrough: ~~strike~~
    if (ch === "~" && text[i + 1] === "~") {
      const closeStrike = text.indexOf("~~", i + 2);
      if (closeStrike > i + 2 && !text.slice(i + 2, closeStrike).includes("\n")) {
        flushPlain(i);
        const inner = text.slice(i + 2, closeStrike);
        nodes.push(
          <del key={`${keyPrefix}_s_${i}`} className="line-through opacity-85">
            {renderInlineMarkdownNodes(inner, lane, `${keyPrefix}_si_${i}`, allowLinks)}
          </del>
        );
        i = closeStrike + 2;
        continue;
      }
    }

    // 7. Italic: *italic* (single asterisk, non-space boundary)
    if (ch === "*" && text[i + 1] !== "*" && text[i + 1] !== " " && text[i + 1] !== "\n") {
      let closeIt = -1;
      for (let j = i + 1; j < text.length; j += 1) {
        if (text[j] === "\n") break;
        if (text[j] === "*" && text[j + 1] !== "*" && text[j - 1] !== " ") {
          closeIt = j;
          break;
        }
      }
      if (closeIt > i + 1) {
        flushPlain(i);
        const inner = text.slice(i + 1, closeIt);
        nodes.push(
          <em key={`${keyPrefix}_em_${i}`} className="italic">
            {renderInlineMarkdownNodes(inner, lane, `${keyPrefix}_emi_${i}`, allowLinks)}
          </em>
        );
        i = closeIt + 1;
        continue;
      }
    }

    plainBuffer += ch;
    i += 1;
  }

  flushPlain(text.length);
  return nodes;
}

// ============================================================================
// Block-Level AST Parser (Fenced Code, Headings, Blockquotes, Lists, GFM Tables)
// ============================================================================

type TableAlign = "left" | "center" | "right";

type BlockNode =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "blockquote"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; start: number; items: string[] }
  | { type: "table"; headers: string[]; aligns: TableAlign[]; rows: string[][] }
  | { type: "paragraph"; text: string };

function splitPipeCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  let inner = trimmed;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  const cells = inner.split("|").map((c) => c.trim());
  return cells.length >= 2 ? cells : null;
}

function parseTableSeparatorRow(line: string, expectedCols: number): TableAlign[] | null {
  const cells = splitPipeCells(line);
  if (!cells || cells.length !== expectedCols) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    aligns.push(left && right ? "center" : right ? "right" : "left");
  }
  return aligns;
}

function parseNonCodeBlocks(segment: string): BlockNode[] {
  const normalized = segment.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: BlockNode[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const joined = paragraphLines.join("\n").replace(/^\n+|\n+$/g, "");
    paragraphLines = [];
    if (joined.trim().length > 0) {
      blocks.push({ type: "paragraph", text: joined });
    }
  };

  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx]!;

    // 1. GFM Pipe Table check (current line = header, next line = | --- | --- |)
    if (idx + 1 < lines.length && line.includes("|") && lines[idx + 1]!.includes("-")) {
      const headerCells = splitPipeCells(line);
      const aligns = headerCells ? parseTableSeparatorRow(lines[idx + 1]!, headerCells.length) : null;
      if (headerCells && aligns) {
        flushParagraph();
        const rows: string[][] = [];
        idx += 2;
        while (idx < lines.length) {
          const rowCells = splitPipeCells(lines[idx]!);
          if (!rowCells) break;
          const normalizedRow = Array.from({ length: headerCells.length }, (_, cIdx) => rowCells[cIdx] ?? "");
          rows.push(normalizedRow);
          idx += 1;
        }
        blocks.push({ type: "table", headers: headerCells, aligns, rows });
        continue;
      }
    }

    // 2. Heading (# to ####)
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      const level = Math.min(4, Math.max(1, headingMatch[1]!.length)) as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, text: headingMatch[2]! });
      idx += 1;
      continue;
    }

    // 3. Blockquote (> ...)
    const quoteMatch = /^\s*>\s?(.*)$/.exec(line);
    if (quoteMatch) {
      flushParagraph();
      const qLines: string[] = [quoteMatch[1]!];
      idx += 1;
      while (idx < lines.length) {
        const nextQuote = /^\s*>\s?(.*)$/.exec(lines[idx]!);
        if (!nextQuote) break;
        qLines.push(nextQuote[1]!);
        idx += 1;
      }
      blocks.push({ type: "blockquote", lines: qLines });
      continue;
    }

    // 4. Unordered list (- item / * item)
    const ulMatch = /^\s*[-*]\s+(.+)$/.exec(line);
    if (ulMatch) {
      flushParagraph();
      const items: string[] = [ulMatch[1]!];
      idx += 1;
      while (idx < lines.length) {
        const nextUl = /^\s*[-*]\s+(.+)$/.exec(lines[idx]!);
        if (!nextUl) break;
        items.push(nextUl[1]!);
        idx += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // 5. Ordered list (1. item)
    const olMatch = /^\s*(\d+)\.\s+(.+)$/.exec(line);
    if (olMatch) {
      flushParagraph();
      const start = Number(olMatch[1] || 1) || 1;
      const items: string[] = [olMatch[2]!];
      idx += 1;
      while (idx < lines.length) {
        const nextOl = /^\s*\d+\.\s+(.+)$/.exec(lines[idx]!);
        if (!nextOl) break;
        items.push(nextOl[1]!);
        idx += 1;
      }
      blocks.push({ type: "ol", start, items });
      continue;
    }

    paragraphLines.push(line);
    idx += 1;
  }

  flushParagraph();
  return blocks;
}

const FENCED_CODE_BLOCK_RE = /```([a-zA-Z0-9_+-]*)[ \t]*\n?([\s\S]*?)```/gu;

export function parseChatMarkdownAST(text: string): BlockNode[] {
  if (!text) return [];
  if (!text.includes("```")) {
    return parseNonCodeBlocks(text);
  }
  const out: BlockNode[] = [];
  let lastIndex = 0;
  FENCED_CODE_BLOCK_RE.lastIndex = 0;
  let match = FENCED_CODE_BLOCK_RE.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      const pre = text.slice(lastIndex, match.index).replace(/^\n+|\n+$/g, (m, off) =>
        off === 0 && out.length > 0 ? "" : m
      );
      if (pre) {
        out.push(...parseNonCodeBlocks(pre));
      }
    }
    const lang = (match[1] || "code").trim() || "code";
    const code = (match[2] || "").replace(/\n$/, "");
    out.push({ type: "code", lang, code });
    lastIndex = match.index + match[0].length;
    match = FENCED_CODE_BLOCK_RE.exec(text);
  }
  if (lastIndex < text.length) {
    const post = text.slice(lastIndex).replace(/^\n/, "");
    if (post) {
      out.push(...parseNonCodeBlocks(post));
    }
  }
  return out;
}

export function renderChatMarkdown(
  text: string,
  lane: ChatMarkdownLane = "workspace",
  keyPrefix = "md"
): React.ReactNode {
  if (!text) return null;
  const blocks = parseChatMarkdownAST(text);
  if (blocks.length === 0) return null;

  // Fast path: single plain paragraph keeps exact inline flow so adjacent blocks (like mentions) stay inline
  if (blocks.length === 1 && blocks[0]!.type === "paragraph") {
    return renderInlineMarkdownNodes(blocks[0]!.text, lane, `${keyPrefix}_0`);
  }

  return (
    <div className="min-w-0 max-w-full space-y-1.5">
      {blocks.map((block, bIdx) => {
        const bKey = `${keyPrefix}_b_${bIdx}`;
        if (block.type === "code") {
          return (
            <div
              key={bKey}
              className="my-1 max-w-full min-w-0 overflow-hidden rounded-xl border border-white/12 bg-[#0f172a] text-slate-100 shadow-xs"
            >
              <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.05] px-2.5 py-1 text-[10px] font-mono text-slate-300">
                <span>{block.lang}</span>
                <CopyCodeBlockButton code={block.code} />
              </div>
              <pre className="dl-scroll overflow-x-auto p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        if (block.type === "heading") {
          const sizeCls =
            block.level === 1
              ? "text-[16px] font-bold leading-snug"
              : block.level === 2
              ? "text-[15px] font-bold leading-snug"
              : block.level === 3
              ? "text-[14.5px] font-semibold leading-snug"
              : "text-[14px] font-semibold leading-snug";
          const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4";
          return (
            <Tag key={bKey} className={cn("m-0 tracking-tight", sizeCls)}>
              {renderInlineMarkdownNodes(block.text, lane, bKey)}
            </Tag>
          );
        }

        if (block.type === "blockquote") {
          return (
            <blockquote
              key={bKey}
              className="my-1 border-l-[3px] border-current/35 bg-black/[0.06] dark:bg-white/[0.06] rounded-r-lg pl-2.5 pr-2 py-1 text-[13.5px] opacity-92 whitespace-pre-wrap"
            >
              {block.lines.map((line, lIdx) => (
                <React.Fragment key={`${bKey}_q_${lIdx}`}>
                  {lIdx > 0 && "\n"}
                  {renderInlineMarkdownNodes(line, lane, `${bKey}_q_${lIdx}`)}
                </React.Fragment>
              ))}
            </blockquote>
          );
        }

        if (block.type === "ul") {
          return (
            <ul key={bKey} className="my-1 list-disc pl-5 space-y-0.5 whitespace-normal">
              {block.items.map((item, iIdx) => (
                <li key={`${bKey}_li_${iIdx}`} className="leading-relaxed">
                  {renderInlineMarkdownNodes(item, lane, `${bKey}_li_${iIdx}`)}
                </li>
              ))}
            </ul>
          );
        }

        if (block.type === "ol") {
          return (
            <ol
              key={bKey}
              start={block.start}
              className="my-1 list-decimal pl-5 space-y-0.5 whitespace-normal"
            >
              {block.items.map((item, iIdx) => (
                <li key={`${bKey}_oli_${iIdx}`} className="leading-relaxed">
                  {renderInlineMarkdownNodes(item, lane, `${bKey}_oli_${iIdx}`)}
                </li>
              ))}
            </ol>
          );
        }

        if (block.type === "table") {
          return (
            <div key={bKey} className="dl-scroll my-1 max-w-full overflow-x-auto rounded-lg border border-current/20">
              <table className="w-full border-collapse text-[12.5px] whitespace-normal">
                <thead>
                  <tr className="bg-black/[0.08] dark:bg-white/[0.08]">
                    {block.headers.map((h, cIdx) => {
                      const align = block.aligns[cIdx] || "left";
                      return (
                        <th
                          key={`${bKey}_th_${cIdx}`}
                          style={{ textAlign: align }}
                          className="border-b border-r last:border-r-0 border-current/20 px-2.5 py-1 font-semibold"
                        >
                          {renderInlineMarkdownNodes(h, lane, `${bKey}_th_${cIdx}`)}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr
                      key={`${bKey}_tr_${rIdx}`}
                      className="border-b last:border-b-0 border-current/15"
                    >
                      {row.map((cell, cIdx) => {
                        const align = block.aligns[cIdx] || "left";
                        return (
                          <td
                            key={`${bKey}_td_${rIdx}_${cIdx}`}
                            style={{ textAlign: align }}
                            className="border-r last:border-r-0 border-current/15 px-2.5 py-1"
                          >
                            {renderInlineMarkdownNodes(cell, lane, `${bKey}_td_${rIdx}_${cIdx}`)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <div key={bKey} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {renderInlineMarkdownNodes(block.text, lane, bKey)}
          </div>
        );
      })}
    </div>
  );
}
