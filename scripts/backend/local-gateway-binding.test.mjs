import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  isLocalGatewayAddress,
  normalizeLocalGatewayURL,
  resolveLocalGatewayURL,
} from "./local-gateway-binding.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const localInterface = "192.0.2.10";
const foreignInterface = "192.0.2.11";
const commit = "a".repeat(40);
const webID = "b".repeat(64);

const injectedInterfaces = () => ({
  synthetic0: [{ address: localInterface, family: "IPv4", internal: false }],
});

function binding(host = localInterface, port = "8787") {
  return { "8080/tcp": [{ HostIp: host, HostPort: port }] };
}

function localOptions() {
  return { networkInterfaces: injectedInterfaces };
}

function assertBindingRejected(value, code) {
  assert.throws(() => resolveLocalGatewayURL(value, localOptions()), (error) => error?.code === code);
}

test("accepts an exact injected IPv4 interface and rejects a foreign address", () => {
  const options = localOptions();
  assert.equal(isLocalGatewayAddress(localInterface, options), true);
  assert.equal(isLocalGatewayAddress(foreignInterface, options), false);
  assert.equal(resolveLocalGatewayURL(binding(), options), `http://${localInterface}:8787`);
  assertBindingRejected(binding(foreignInterface), "invalid_gateway_host");
});

test("keeps loopback and wildcard mapping while rejecting noncanonical or malformed bindings", () => {
  const options = localOptions();
  assert.equal(resolveLocalGatewayURL(binding("127.0.0.1"), options), "http://127.0.0.1:8787");
  assert.equal(resolveLocalGatewayURL(binding("127.10.20.30"), options), "http://127.10.20.30:8787");
  assert.equal(resolveLocalGatewayURL(binding("0.0.0.0"), options), "http://127.0.0.1:8787");
  assert.equal(resolveLocalGatewayURL(binding("::1"), options), "http://[::1]:8787");
  assert.equal(resolveLocalGatewayURL(binding("::"), options), "http://[::1]:8787");

  for (const value of [
    binding("192.0.2.010"),
    binding("999.0.0.1"),
    binding("localhost"),
    binding("example.invalid"),
    binding("127.0.0.1", "0"),
    binding("127.0.0.1", "65536"),
    binding("127.0.0.1", 8787),
    { "8080/tcp": [] },
    { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8787" }, { HostIp: "127.0.0.1", HostPort: "8788" }] },
  ]) {
    assertBindingRejected(value, value["8080/tcp"]?.length === 0 || value["8080/tcp"]?.length > 1
      ? "invalid_gateway_binding_count"
      : value["8080/tcp"]?.[0]?.HostPort === "0" || value["8080/tcp"]?.[0]?.HostPort === "65536" || typeof value["8080/tcp"]?.[0]?.HostPort !== "string"
        ? "invalid_gateway_port"
        : "invalid_gateway_host");
  }
});

test("normalizes only safe HTTP origins and rejects URL aliases or DNS targets", () => {
  const options = localOptions();
  assert.equal(normalizeLocalGatewayURL(`http://${localInterface}:8787/`, options).origin, `http://${localInterface}:8787`);
  assert.equal(normalizeLocalGatewayURL("http://localhost:8787/", options).origin, "http://localhost:8787");
  for (const value of [
    "http://192.0.2.010:8787/",
    "http://2130706433:8787/",
    "http://192.0.2.11:8787/",
    "http://example.invalid:8787/",
    "http://user:pass@127.0.0.1:8787/",
    "http://127.0.0.1:8787/?query=1",
    "http://127.0.0.1:8787/#fragment",
  ]) {
    assert.throws(() => normalizeLocalGatewayURL(value, options), (error) => error?.code === "invalid_gateway_url");
  }
});

test("fails closed when host interface discovery fails or returns malformed data", () => {
  for (const networkInterfaces of [() => { throw new Error("synthetic"); }, () => null, () => ({ test: {} })]) {
    assert.throws(() => resolveLocalGatewayURL(binding(), { networkInterfaces }));
  }
  assert.equal(isLocalGatewayAddress("127.0.0.1", { networkInterfaces: () => { throw new Error("unused"); } }), true);
});

test("copied release helper resolves its shared module from the isolated checkout", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-gateway-binding-"));
  const checkout = path.join(directory, "checkout");
  const production = path.join(checkout, "deploy", "production");
  const backend = path.join(checkout, "scripts", "backend");
  const bin = path.join(directory, "bin");
  const trace = path.join(directory, "trace");
  const recovery = path.join(directory, "recovery");
  try {
    await Promise.all([
      mkdir(production, { recursive: true }),
      mkdir(backend, { recursive: true }),
      mkdir(bin, { recursive: true }),
      writeFile(recovery, "", { mode: 0o600 }),
    ]);
    await copyFile(path.join(root, "deploy/production/release-helper.sh"), path.join(production, "release-helper.sh"));
    await copyFile(path.join(root, "scripts/backend/local-gateway-binding.mjs"), path.join(backend, "local-gateway-binding.mjs"));
    await copyFile(path.join(root, "scripts/backend/gateway-readonly-smoke.mjs"), path.join(backend, "gateway-readonly-smoke.mjs"));
    await writeFile(path.join(bin, "node"), [
      "#!/usr/bin/env bash",
      "if [[ \"$1\" == -e ]]; then exec \"$REAL_NODE\" \"$@\"; fi",
      "printf '%s\\n' \"$*\" >> \"$TRACE\"",
      "exit 0",
      "",
    ].join("\n"), { mode: 0o700 });
    const driver = [
      "set -Eeuo pipefail",
      "source \"$CHECKOUT/deploy/production/release-helper.sh\"",
      "RELEASE_PROFILE_NAME=go-full",
      "RELEASE_RECOVERY_FILE=$RECOVERY",
      "COMPOSE_PROJECT_NAME=synthetic",
      "release_compose_service_configured() { return 0; }",
      "compose() { [[ \"$1\" == ps ]] || return 1; printf '%s\\n' \"$WEB_ID\"; }",
      "docker() {",
      "  [[ \"$1\" == inspect ]] || return 1",
      "  local format=\"$4\"",
      "  if [[ \"$format\" == *com.docker.compose.project* ]]; then printf '%s\\n' synthetic; return 0; fi",
      "  if [[ \"$format\" == *com.docker.compose.service* ]]; then printf '%s\\n' web; return 0; fi",
      "  if [[ \"$format\" == *org.opencontainers.image.version* ]]; then printf '%s\\n' 0.16.0; return 0; fi",
      "  if [[ \"$format\" == *org.opencontainers.image.revision* ]]; then printf '%s\\n' \"$COMMIT\"; return 0; fi",
      "  if [[ \"$format\" == \"{{json .NetworkSettings.Ports}}\" ]]; then printf '%s\\n' \"$PORTS_JSON\"; return 0; fi",
      "  return 1",
      "}",
      "release_run_gateway_smoke go-full 0.16.0 \"$COMMIT\"",
    ].join("\n");
    const actualIPv4 = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    for (const host of ["127.0.0.1", ...(actualIPv4 ? [actualIPv4] : [])]) {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", driver], {
        cwd: checkout,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          CHECKOUT: checkout,
          RECOVERY: recovery,
          TRACE: trace,
          REAL_NODE: process.execPath,
          WEB_ID: webID,
          COMMIT: commit,
          PORTS_JSON: JSON.stringify(binding(host, "18787")),
        },
      });
      assert.equal(result.error, undefined, `${result.stderr}\n${result.stdout}`);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const invoked = await readFile(trace, "utf8");
      assert.ok(invoked.includes(`--base-url http://${host}:18787 `));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
