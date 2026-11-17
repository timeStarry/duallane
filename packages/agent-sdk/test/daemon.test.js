import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildDaemonAgentPrompt,
  buildLaunchdPlistXml,
  buildSystemdUnitFile,
  checkRuntimeUpdate,
  detectAvailableAgentBinary,
  extractGeneratedFilesFromReply,
  getDaemonServiceLabel,
  stageRuntimeSelfUpdate,
} from "../src/daemon.js";
import { compareRuntimeSemver, DualLaneAgentClient } from "../src/index.js";
import { createDualLaneMcpServer } from "../src/mcp.js";
import { saveAgentProfile } from "../src/profile-store.js";

test("daemon selection stays command-neutral and rejects retired hardcoded agent modes", () => {
  assert.equal(detectAvailableAgentBinary(), "auto");
  assert.equal(detectAvailableAgentBinary(" CMD "), "cmd");
  for (const agent of ["codex", "claude", "unknown"]) {
    assert.throws(() => detectAvailableAgentBinary(agent), /Use auto or cmd with --cmd <command>/u);
  }
});

test("daemon run and install require a handler before gateway or service-manager activity", () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-daemon-handler-test-"));
  const configDir = path.join(fixtureDir, "agents");
  try {
    saveAgentProfile("default", {
      url: "http://127.0.0.1:1",
      token: "synthetic-handler-test-token",
      botId: "bot_handler_test",
    }, { configDir });
    const cli = new URL("../bin/duallane-agent.mjs", import.meta.url);
    for (const action of ["run", "install"]) {
      const result = spawnSync(process.execPath, [fileURLToPath(cli), "daemon", action], {
        env: { ...process.env, DUALLANE_AGENT_CONFIG_DIR: configDir },
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Resident daemons require --cmd <command>/u);
      assert.doesNotMatch(result.stderr, /synthetic-handler-test-token|ECONNREFUSED/u);
    }
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("daemon generates valid macOS launchd plist with KeepAlive and escaped paths", () => {
  const xml = buildLaunchdPlistXml({
    label: getDaemonServiceLabel("comet"),
    programArguments: ["/usr/local/bin/node", "/Users/test/.duallane/bin/duallane-agent.mjs", "daemon", "run", "--profile", "comet"],
    workingDirectory: "/Users/test",
    logPath: "/Users/test/.config/duallane/logs/comet.log",
    env: {
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: "/Users/test",
    },
  });

  assert.match(xml, /<string>top\.tsio\.duallane\.agent\.comet<\/string>/u);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/u);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(xml, /<string>--profile<\/string>/u);
});

test("daemon generates valid Linux systemd user unit with Restart=always", () => {
  const unit = buildSystemdUnitFile({
    profileName: "comet",
    programArguments: ["/usr/bin/node", "/home/user/.duallane/bin/duallane-agent.mjs", "daemon", "run", "--profile", "comet"],
    workingDirectory: "/home/user",
    logPath: "/home/user/.config/duallane/logs/comet.log",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
  });

  assert.match(unit, /Restart=always/u);
  assert.match(unit, /RestartSec=3/u);
  assert.match(unit, /ExecStart="\/usr\/bin\/node"/u);
});

test("daemon prompt enforces read-only safety rule in group chats and formats context", () => {
  const groupPrompt = buildDaemonAgentPrompt({
    botName: "Comet",
    conversation: { id: "conv_grp_1", type: "group", title: "无议程同步对齐碰头会" },
    event: {
      type: "message.created",
      payload: { text: "@Comet 能收到群聊信息吗" },
    },
    context: {
      messages: [
        { authorName: "timeStarry", plainText: "大家好", createdAt: "2026-11-16T03:07:00.000Z" },
      ],
    },
  });

  assert.match(groupPrompt, /严禁执行任何修改本机文件/u);
  assert.match(groupPrompt, /无议程同步对齐碰头会/u);
  assert.match(groupPrompt, /\[03:07:00\] timeStarry: 大家好/u);
  assert.match(groupPrompt, /@Comet 能收到群聊信息吗/u);
});

test("extractGeneratedFilesFromReply parses inline <duallane-file> and enforces DM-only local path boundary", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-daemon-file-test-"));
  const validLocalFile = path.join(tmpDir, "chart.svg");
  fs.writeFileSync(validLocalFile, "<svg></svg>", "utf8");

  const reply = [
    "已为您整理好周报与图表：",
    `<duallane-file name="weekly.md"># 周报\n一切正常</duallane-file>`,
    `[[DUALLANE_FILE: ${validLocalFile}]]`,
  ].join("\n\n");

  // Group mode blocks local paths, keeps inline <duallane-file>
  const groupOut = extractGeneratedFilesFromReply(reply, { allowLocalPath: false, workdir: tmpDir });
  assert.equal(groupOut.cleanText, "已为您整理好周报与图表：");
  assert.equal(groupOut.files.length, 1);
  assert.equal(groupOut.files[0].fileName, "weekly.md");
  assert.equal(groupOut.files[0].mimeType, "text/markdown");

  // Owner 1-on-1 DM allows files inside workdir/tmpdir
  const dmOut = extractGeneratedFilesFromReply(reply, { allowLocalPath: true, workdir: tmpDir });
  assert.equal(dmOut.files.length, 2);
  assert.equal(dmOut.files[1].fileName, "chart.svg");
  assert.equal(dmOut.files[1].mimeType, "image/svg+xml");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("client.sendFile and MCP duallane_send_file upload binary payload with inferred MIME type", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: Buffer.from(init.body) });
    return new Response(
      JSON.stringify({
        ok: true,
        attachment: { id: "att_gen_1", fileName: "report.csv", mimeType: "text/csv", byteSize: init.body.byteLength },
        message: { id: "msg_gen_1" },
      }),
      { status: 201, headers: { "content-type": "application/json" } }
    );
  };

  const client = new DualLaneAgentClient({
    url: "https://duallane.example.com",
    token: "dl_bot_test_token_0123456789abcdef0123456789",
    fetch: fakeFetch,
  });
  const res = await client.sendFile({
    conversationId: "conv_1",
    bytes: "a,b\n1,2\n",
    fileName: "report.csv",
    text: "数据导出",
  });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/bot\/v2\/conversations\/conv_1\/files\?/u);
  assert.match(calls[0].url, /fileName=report\.csv/u);
  assert.equal(calls[0].headers["content-type"], "text/csv");
  assert.equal(calls[0].body.toString("utf8"), "a,b\n1,2\n");

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-mcp-file-test-"));
  saveAgentProfile(
    "default",
    {
      url: "https://duallane.example.com",
      token: "dl_bot_test_token_0123456789abcdef0123456789",
      scopes: ["messages:send", "files:write"],
    },
    { configDir: cfgDir }
  );
  const mcp = createDualLaneMcpServer({ configDir: cfgDir, fetch: fakeFetch });
  const mcpRes = await mcp.callTool("duallane_send_file", {
    conversationId: "conv_1",
    contentText: "# Hello",
    fileName: "hello.md",
    text: "请查收文档",
  });
  assert.equal(mcpRes.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /fileName=hello\.md/u);
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

test("runtime updater verifies SHA-256, rejects tampered bundles, and MCP doctor inspects conversations", async () => {
  assert.equal(compareRuntimeSemver("1.0.15", "1.0.14"), 1);
  assert.equal(compareRuntimeSemver("1.0.14", "1.0.14"), 0);
  assert.equal(compareRuntimeSemver("1.0.11", "1.0.14"), -1);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-self-update-test-"));
  const targetScript = path.join(tmpDir, "duallane-agent.mjs");
  fs.writeFileSync(targetScript, "#!/usr/bin/env node\nconsole.log('old');\n", "utf8");

  const validNewBundle =
    "#!/usr/bin/env node\n" +
    "// " +
    "x".repeat(1200) +
    "\nexport const DUALLANE_AGENT_SDK_VERSION = '9.9.9';\n";
  const validSha256 = crypto.createHash("sha256").update(validNewBundle, "utf8").digest("hex");

  const makeMockFetch = (manifestSha) => async (url) => {
    const u = String(url);
    if (u.includes("duallane-agent.manifest.json")) {
      return new Response(
        JSON.stringify({
          version: "9.9.9",
          sha256: manifestSha,
          byteSize: Buffer.byteLength(validNewBundle, "utf8"),
          highlights: ["Test highlight"],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.includes("/api/bot/v2/doctor")) {
      return new Response(
        JSON.stringify({
          ok: true,
          latestSdkVersion: "9.9.9",
          bot: { id: "bot_comet", name: "Comet", status: "active" },
          conversations: [{ id: "conv_dm_1", type: "direct", allowTrigger: true, isOwnerDirect: true }],
          recentDeliveries: [{ id: "bdl_1", sequence: 99, status: "acked" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(validNewBundle, { status: 200 });
  };

  const checked = await checkRuntimeUpdate({
    origin: "https://duallane.example.com",
    fetchImpl: makeMockFetch(validSha256),
  });
  assert.equal(checked.updateAvailable, true);
  assert.equal(checked.latestVersion, "9.9.9");

  await assert.rejects(
    () =>
      stageRuntimeSelfUpdate({
        origin: "https://duallane.example.com",
        targetPath: targetScript,
        fetchImpl: makeMockFetch("0".repeat(64)),
      }),
    /SHA-256 mismatch/u
  );
  assert.match(fs.readFileSync(targetScript, "utf8"), /old/u);

  const staged = await stageRuntimeSelfUpdate({
    origin: "https://duallane.example.com",
    targetPath: targetScript,
    fetchImpl: makeMockFetch(validSha256),
  });
  assert.equal(staged.updated, true);
  assert.match(fs.readFileSync(targetScript, "utf8"), /9\.9\.9/u);

  const cfgDir = path.join(tmpDir, "cfg");
  saveAgentProfile(
    "default",
    {
      url: "https://duallane.example.com",
      token: "dl_bot_test_token_0123456789abcdef0123456789",
      scopes: ["messages:read_trigger", "messages:send"],
    },
    { configDir: cfgDir }
  );
  const mcp = createDualLaneMcpServer({
    configDir: cfgDir,
    fetch: makeMockFetch(validSha256),
  });
  const docRes = await mcp.callTool("duallane_doctor", {});
  assert.equal(docRes.ok, true);
  assert.equal(docRes.runtimeUpdate.updateAvailable, true);
  assert.equal(docRes.conversations[0].isOwnerDirect, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
