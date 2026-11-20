import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(sdkRoot, "..", "..");
const sdkPkg = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));

const sourceFiles = [
  "src/ws-lite.js",
  "src/transport.js",
  "src/base64.js",
  "src/file-input.js",
  "src/message-content.js",
  "src/task-client.js",
  "src/task-tools.js",
  "src/index.js",
  "src/media.js",
  "src/inbound.js",
  "src/bridge-protocol.js",
  "src/task-runtime.js",
  "src/runtime-update.js",
  "src/v2.js",
  "src/profile-store.js",
  "src/mcp.js",
  "src/daemon.js",
  "bin/duallane-agent.mjs",
];

function stripImportsAndReexports(code, relPath) {
  let out = code.replace(/^#!\/usr\/bin\/env node\s*\n/u, "");
  // Strip multi-line and single-line ES imports (node:* builtins are emitted once in header)
  out = out.replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gmu, "");
  out = out.replace(/^export\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?\s*$/gmu, "");
  if (relPath === "bin/duallane-agent.mjs") {
    // Symbols from src/*.js are already exported at declaration
    out = out.replace(/^export\s*\{[\s\S]*?\};\s*$/gmu, "");
  }
  return out.trim();
}

const header = `#!/usr/bin/env node
/**
 * DualLane Universal Agent Runtime (Standalone Single-File CLI + Stdio MCP + JS SDK)
 * Zero external npm dependencies · Requires Node.js >= 20
 *
 * Install anywhere directly from your DualLane host:
 *   mkdir -p ~/.duallane/bin
 *   curl -fsSL https://<duallane-host>/integrations/duallane-agent.mjs -o ~/.duallane/bin/duallane-agent.mjs
 *   chmod +x ~/.duallane/bin/duallane-agent.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
`;

const sections = sourceFiles.map((relPath) => {
  const fullPath = path.join(sdkRoot, relPath);
  const raw = fs.readFileSync(fullPath, "utf8").replace(/\r\n?/gu, "\n");
  return `// --- ${relPath} ---\n${stripImportsAndReexports(raw, relPath)}`;
});

const bundle = `${header}\n${sections.join("\n\n")}\n`;
const bundleBytes = Buffer.from(bundle, "utf8");
const bundleSha256 = crypto.createHash("sha256").update(bundleBytes).digest("hex");

// Validate before replacing any published runtime or its integrity manifest.
const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
  input: bundle,
  encoding: "utf8",
});
if (check.status !== 0) {
  throw new Error(`Bundled runtime syntax check failed:\n${check.stderr || check.error || "invalid JavaScript"}`);
}

const targets = [
  path.join(repoRoot, "apps/web/public/integrations/duallane-agent.mjs"),
  path.join(repoRoot, "apps/web/public/integrations/v2/duallane-agent.mjs"),
];

for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bundleBytes, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}

const manifestPayload =
  JSON.stringify(
    {
      name: "@duallane/agent-sdk",
      version: String(sdkPkg.version),
      sha256: bundleSha256,
      byteSize: bundleBytes.byteLength,
      downloadPath: "/integrations/duallane-agent.mjs",
      documentationPath: "/integrations/v2/duallane-channel.md",
      skillPath: "/integrations/duallane-agent/SKILL.md",
      minNodeVersion: "20.0.0",
      buildId: crypto.createHash("sha256").update(sections.join("\n")).digest("hex"),
      compatibility: { gatewayVersion: 1, bridgeProtocolVersion: 1, sdkVersionHeader: "X-DualLane-SDK-Version", minimumSdkVersion: String(sdkPkg.version), sdkMajorVersion: 1 },
      highlights: [
        "修复机器人在大量无关事件后漏收待投递消息，重连时从已确认的位置安全续收",
        "修复确认、取消卡片的按钮结构，发送和更新保留嵌套业务数据与固定动作边界",
        "卡片写入区分本次校验拒绝与结果未知，保留原操作引用且不盲目重发",
        `SDK ${sdkPkg.version} 为最低接入版本，升级保留既有身份与桥接配置`,
        "任务限定的历史、消息、成员与附件工具，受控提及和机器人协作",
        "按需上下文与查询覆盖说明；条件修改和未知操作结果协调",
        "接入 Skill 明确聊天能力、外部 Agent 工具与授权边界",
        "修复较大图片内联编码触发解析失败，严格校验编码和文件大小边界",
        "恢复机器人执行期间的思考状态，任务结束、失败或取消后停止续租",
        "通用命令桥接采用版本化任务与产物协议，支持受控媒体获取和授权入站附件",
        "任务持久接收后确认事件，按上传与发送回执恢复，并提供安全失败状态和显式重试",
        "官方运行包按版本、摘要和协议核验更新，保留独立bridge、策略和服务配置",
      ],
    },
    null,
    2
  ) + "\n";

const manifestTargets = [
  path.join(repoRoot, "apps/web/public/integrations/duallane-agent.manifest.json"),
  path.join(repoRoot, "apps/web/public/integrations/v2/duallane-agent.manifest.json"),
];

for (const manifestTarget of manifestTargets) {
  fs.mkdirSync(path.dirname(manifestTarget), { recursive: true });
  fs.writeFileSync(manifestTarget, manifestPayload, "utf8");
}

process.stdout.write(
  `[bundle-standalone] Wrote ${bundleBytes.byteLength} bytes (sha256=${bundleSha256.slice(0, 12)}...) + manifest v${sdkPkg.version} to ${targets.length} public integration paths.\n`
);
