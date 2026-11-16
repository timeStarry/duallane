import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDaemonAgentPrompt,
  buildLaunchdPlistXml,
  buildSystemdUnitFile,
  getDaemonServiceLabel,
} from "../src/daemon.js";

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
