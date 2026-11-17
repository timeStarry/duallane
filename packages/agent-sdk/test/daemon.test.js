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
  createDaemonMediaResolver,
  detectAvailableAgentBinary,
  extractGeneratedFilesFromReply,
  getDaemonServiceLabel,
  stageRuntimeSelfUpdate,
} from "../src/daemon.js";
import { compareRuntimeSemver, DualLaneAgentClient } from "../src/index.js";
import { createDualLaneMcpServer } from "../src/mcp.js";
import { saveAgentProfile } from "../src/profile-store.js";

test("enabled daemon media uses system DNS by default and only forwards explicit operator DNS", async () => {
  const calls = [];
  const fetchMedia = async (url, options) => { calls.push({ url, options }); return { bytes: Buffer.from("safe") }; };
  assert.equal(createDaemonMediaResolver({ enabled: false, fetchMedia }), undefined);
  await createDaemonMediaResolver({ enabled: true, fetchMedia })("https://example.com/media");
  assert.equal(Object.hasOwn(calls[0].options, "dnsServers"), false);
  await createDaemonMediaResolver({ enabled: true, dnsServers: ["1.1.1.1"], fetchMedia })("https://example.com/media");
  assert.deepEqual(calls[1].options.dnsServers, ["1.1.1.1"]);
});

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

test("an explicit command migrates retired daemon records unless an agent mode is explicitly requested", () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-daemon-migration-test-"));
  const configDir = path.join(fixtureDir, "agents");
  const stateDir = path.join(fixtureDir, "daemons");
  const recordPath = path.join(stateDir, "default.json");
  try {
    saveAgentProfile("default", { url: "http://127.0.0.1:1", token: "dl_bot_test_token_0123456789abcdef0123456789" }, { configDir });
    fs.mkdirSync(stateDir);
    const daemonUrl = new URL("../src/daemon.js", import.meta.url).href;
    for (const oldAgent of ["codex", "claude"]) {
      for (const action of ["install", "run"]) {
        fs.writeFileSync(recordPath, JSON.stringify({ agent: oldAgent }));
        const script = `
          import fs from "node:fs";
          import path from "node:path";
          import childProcess from "node:child_process";
          import { syncBuiltinESMExports } from "node:module";
          // Prevent every process-manager, handler, and network side effect.
          childProcess.spawnSync = () => ({ status: 0, stdout: "", stderr: "" });
          childProcess.spawn = () => ({ pid: 0, unref() {} });
          syncBuiltinESMExports();
          globalThis.fetch = async () => new Response(JSON.stringify({ bot: { id: "synthetic-bot" }, scopes: [] }), { headers: { "content-type": "application/json" } });
          const writeFile = fs.writeFileSync;
          fs.writeFileSync = (target, content, ...args) => {
            if (typeof target === "string" && path.resolve(target) === ${JSON.stringify(recordPath)}) {
              const record = JSON.parse(content);
              process.stdout.write(JSON.stringify({ agent: record.agent, cmd: record.cmd }));
              throw new Error("synthetic record boundary");
            }
            return writeFile(target, content, ...args);
          };
          const { manageDaemonCli } = await import(${JSON.stringify(daemonUrl)});
          try {
            await manageDaemonCli([${JSON.stringify(action)}], JSON.parse(process.env.TEST_DAEMON_FLAGS));
            process.exitCode = 2;
          } catch (error) {
            if (error.message !== "synthetic record boundary") {
              process.stderr.write(error.message);
              process.exitCode = 1;
            }
          }
        `;
        for (const explicitAgent of [undefined, "claude"]) {
          const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
            env: {
              ...process.env,
              HOME: path.join(fixtureDir, "home"),
              USERPROFILE: path.join(fixtureDir, "home"),
              DUALLANE_AGENT_CONFIG_DIR: configDir,
              TEST_DAEMON_FLAGS: JSON.stringify({ cmd: "new-handler-command", agent: explicitAgent, workdir: fixtureDir }),
            },
            encoding: "utf8",
            timeout: 5_000,
          });
          if (explicitAgent) {
            assert.equal(result.status, 1, result.stderr);
            assert.match(result.stderr, /Unsupported --agent/u);
            assert.equal(result.stdout, "");
          } else {
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), { agent: "cmd", cmd: "new-handler-command" });
          }
        }
      }
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

test("legacy extraction shares structured validation and refuses local paths in every conversation", () => {
  const reply = 'report\n<duallane-file name="weekly.md"># report</duallane-file>';
  const parsed = extractGeneratedFilesFromReply(reply);
  assert.equal(parsed.cleanText, "report");
  assert.equal(parsed.files[0].fileName, "weekly.md");
  assert.equal(parsed.files[0].bytes.toString(), "# report");
  for (const allowLocalPath of [false, true]) {
    assert.throws(() => extractGeneratedFilesFromReply('[[DUALLANE_FILE: /tmp/private.txt]]', { allowLocalPath }), { code: "artifact.local_path_denied" });
  }
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
    { code: "runtime.integrity_mismatch" }
  );
  assert.equal(fs.existsSync(targetScript), false);

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
