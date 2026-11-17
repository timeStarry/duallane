import assert from "node:assert/strict";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import https from "node:https";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fetchPublicMedia, MediaPolicyError, validateArtifactBytes } from "../src/media.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l8AAAAASUVORK5CYII=", "base64");
const publicAddress = "93.184.216.34";

function mediaHarness(t, responses = [{}], lookup) {
  const requests = [];
  const dnsCalls = [];
  t.mock.method(dns, "lookup", async (hostname, options) => {
    dnsCalls.push({ hostname, options });
    return lookup ? lookup(hostname, dnsCalls.length) : [{ address: publicAddress, family: 4 }];
  });
  t.mock.method(https, "request", (url, options, onResponse) => {
    const spec = responses[requests.length] || {};
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => { request.destroyed = true; };
    const record = { url, options, request, lookupResults: [] };
    requests.push(record);
    request.end = () => queueMicrotask(() => {
      if (request.destroyed) return;
      if (spec.requestError) {
        request.emit("error", new Error(spec.requestError));
        return;
      }
      options.lookup(url.hostname, { all: true }, (error, addresses) => record.lookupResults.push({ error, addresses }));
      options.lookup(url.hostname, {}, (error, address, family) => record.lookupResults.push({ error, address, family }));
      const socket = new EventEmitter();
      socket.remoteAddress = spec.remoteAddress || record.lookupResults[0].addresses[0].address;
      socket.authorized = spec.authorized !== false;
      request.emit("socket", socket);
      if (spec.connectStall) return;
      socket.emit("secureConnect");
      if (request.destroyed || spec.responseStall) return;
      const response = new PassThrough();
      record.response = response;
      response.statusCode = spec.status ?? 200;
      response.headers = spec.headers || { "content-type": "image/png", "content-length": String(png.length) };
      response.complete = spec.complete !== false;
      response.socket = socket;
      onResponse(response);
      if (response.destroyed || spec.bodyStall) return;
      for (const chunk of spec.chunks || [spec.body ?? png]) response.write(chunk);
      response.end();
    });
    return request;
  });
  return { requests, dnsCalls };
}

async function denied(url, code, options = {}) {
  await assert.rejects(fetchPublicMedia(url, { enabled: true, ...options }), { code });
}

test("public media requires explicit operator opt-in before DNS or HTTP", async (t) => {
  const h = mediaHarness(t);
  await assert.rejects(fetchPublicMedia("https://example.com/image.png"), { code: "media.disabled" });
  await assert.rejects(fetchPublicMedia("https://example.com/image.png", { enabled: "true" }), { code: "media.disabled" });
  assert.equal(h.dnsCalls.length, 0);
  assert.equal(h.requests.length, 0);
});

test("media limits reject invalid values and cannot exceed hard bounds", async (t) => {
  const h = mediaHarness(t);
  for (const options of [{ maxBytes: Infinity }, { maxBytes: 0 }, { maxBytes: 51 * 1024 * 1024 },
    { timeoutMs: 60001 }, { connectTimeoutMs: 15001 }, { maxRedirects: 4 }, { maxRedirects: -1 }, { signal: {} }]) {
    await denied("https://example.com/a", "media.invalid_options", options);
  }
  assert.equal(h.requests.length, 0);
});

test("URL policy rejects credentials, non-HTTPS, ports and ambiguous host forms", async (t) => {
  const h = mediaHarness(t);
  for (const url of ["http://example.com/image", "file:///secret", "https://user:password@example.com/a",
    "https://example.com:444/a", "https://localhost/a", "https://example.com./a"]) {
    await denied(url, "media.destination_denied");
  }
  for (const url of ["https://example.com\\@127.0.0.1/a", "https://example.com/a\nsecret", " https://example.com/a"]) {
    await denied(url, "media.invalid_url");
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.dnsCalls.length, 0);
});

test("literal IPv4 private, reserved, shared and encoded addresses are rejected", async (t) => {
  const h = mediaHarness(t);
  const deniedAddresses = ["0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.254", "127.0.0.1",
    "169.254.169.254", "172.16.0.1", "172.31.255.254", "192.0.0.9", "192.0.2.1", "192.88.99.1",
    "192.168.0.1", "198.18.0.1", "198.19.1.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "2130706433", "0x7f000001", "0177.0.0.1", "127.1"];
  for (const address of deniedAddresses) await denied(`https://${address}/image`, "media.destination_denied");
  assert.equal(h.requests.length, 0);
  assert.equal(h.dnsCalls.length, 0);
});

test("IPv6 non-global, mapped, translation, transition and documentation ranges are rejected", async (t) => {
  const h = mediaHarness(t);
  for (const address of ["::", "::1", "::ffff:127.0.0.1", "::ffff:5db8:d822", "64:ff9b::7f00:1", "64:ff9b:1::1",
    "100::1", "2001::1", "2001:2::1", "2001:20::1", "2001:db8::1", "2002:5db8:d822::1", "3fff::1",
    "3fff:fff::1", "5f00::1", "fc00::1", "fdff::1", "fe80::1", "ff02::1"]) {
    await denied(`https://[${address}]/a`, "media.destination_denied");
  }
  assert.equal(h.requests.length, 0);
});

test("every DNS answer must be public and have a truthful address family", async (t) => {
  const h = mediaHarness(t, [], (hostname) => {
    if (hostname === "empty.example") return [];
    if (hostname === "family.example") return [{ address: publicAddress, family: 6 }];
    return [{ address: publicAddress, family: 4 }, { address: "10.0.0.1", family: 4 }];
  });
  for (const hostname of ["empty.example", "family.example", "mixed.example"]) {
    await denied(`https://${hostname}/a`, "media.destination_denied");
  }
  assert.equal(h.requests.length, 0);
});

test("DNS resolution and network errors expose only safe classified failures", async (t) => {
  const secret = "private-path?token=never-print-this";
  const h = mediaHarness(t, [{ requestError: secret }], (hostname) => {
    if (hostname === "dns.example") throw new Error(secret);
    return [{ address: publicAddress, family: 4 }];
  });
  for (const [url, code] of [["https://dns.example/a", "media.dns_failed"], ["https://network.example/a", "media.network"]]) {
    await assert.rejects(fetchPublicMedia(url, { enabled: true }), (error) => {
      assert.ok(error instanceof MediaPolicyError);
      assert.equal(error.code, code);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.stack + JSON.stringify(error), /private-path|never-print-this|https:/u);
      return true;
    });
  }
  assert.equal(h.requests.length, 1);
});

test("validated DNS address is pinned for both lookup shapes without a second resolution", async (t) => {
  const h = mediaHarness(t, [{}], (_hostname, call) => [{ address: call === 1 ? publicAddress : "127.0.0.1", family: 4 }]);
  const result = await fetchPublicMedia("https://example.com/secret/path?token=hidden#key", {
    enabled: true, headers: { Authorization: "must-not-forward", Cookie: "private" },
    lookup: () => { throw new Error("must not run"); },
  });
  assert.equal(h.dnsCalls.length, 1);
  assert.deepEqual(h.requests[0].lookupResults, [
    { error: null, addresses: [{ address: publicAddress, family: 4 }] },
    { error: null, address: publicAddress, family: 4 },
  ]);
  const { options, url } = h.requests[0];
  assert.deepEqual(Object.keys(options.headers).sort(), ["Accept", "Accept-Encoding", "User-Agent"]);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent.options.keepAlive, false);
  assert.deepEqual(options.agent.options.proxyEnv, {});
  assert.equal(options.family, 4);
  assert.equal(url.hash, "");
  assert.deepEqual(result.source, { kind: "https", origin: "https://example.com", redirectCount: 0 });
  assert.equal(result.fileName, "media.png");
  assert.equal(result.sha256, crypto.createHash("sha256").update(png).digest("hex"));
  assert.deepEqual(result.bytes, png);
  assert.doesNotMatch(JSON.stringify(result.source), /secret|hidden|key/u);
});

test("ordinary IPv6 public addresses remain supported with TLS hostname verification", async (t) => {
  const address = "2606:4700:4700::1111";
  const h = mediaHarness(t, [{}], () => [{ address, family: 6 }]);
  await fetchPublicMedia("https://images.example/a", { enabled: true });
  assert.equal(h.requests[0].options.family, 6);
  assert.equal(h.requests[0].url.hostname, "images.example");
  assert.equal(h.requests[0].options.rejectUnauthorized, true);
  assert.deepEqual(h.requests[0].lookupResults[0].addresses, [{ address, family: 6 }]);
});

test("connected peer and TLS authorization are independently checked", async (t) => {
  const h = mediaHarness(t, [{ remoteAddress: "127.0.0.1" }, { authorized: false }]);
  await denied("https://example.com/a", "media.destination_denied");
  await denied("https://example.com/a", "media.destination_denied");
  assert.ok(h.requests.every((record) => record.request.destroyed));
});

test("redirects revalidate destination before opening another connection", async (t) => {
  const h = mediaHarness(t, [
    { status: 302, headers: { location: "https://127.0.0.1/private" } },
    { status: 302, headers: { location: "https://user:secret@public.example/a" } },
    { status: 302, headers: { location: "http://public.example/a" } },
  ]);
  for (let i = 0; i < 3; i += 1) await denied("https://example.com/a", "media.destination_denied");
  assert.equal(h.requests.length, 3);
});

test("same-host redirect cannot rebind its DNS to a private destination", async (t) => {
  const h = mediaHarness(t, [{ status: 302, headers: { location: "/next" } }], (_hostname, call) => [
    { address: call === 1 ? publicAddress : "169.254.169.254", family: 4 },
  ]);
  await denied("https://example.com/a", "media.destination_denied");
  assert.equal(h.dnsCalls.length, 2);
  assert.equal(h.requests.length, 1);
});

test("redirect chains are bounded and successful final origin is recorded", async (t) => {
  const h = mediaHarness(t, [
    { status: 307, headers: { location: "https://images.example/photo?secret=1" } }, {},
    ...Array.from({ length: 4 }, () => ({ status: 302, headers: { location: "/again" } })),
  ]);
  const result = await fetchPublicMedia("https://example.com/start", { enabled: true });
  assert.deepEqual(result.source, { kind: "https", origin: "https://images.example", redirectCount: 1 });
  await denied("https://example.com/a", "media.redirect_limit");
  assert.equal(h.requests.length, 6);
});

test("declared and streamed overages destroy the request without accepting excess bytes", async (t) => {
  const h = mediaHarness(t, [
    { headers: { "content-type": "image/png", "content-length": "10000" } },
    { headers: { "content-type": "image/png" }, chunks: [png, Buffer.alloc(20)] },
  ]);
  await denied("https://example.com/a", "media.too_large", { maxBytes: png.length });
  await denied("https://example.com/a", "media.too_large", { maxBytes: png.length });
  assert.ok(h.requests.every((record) => record.request.destroyed && record.response.destroyed));
});

test("compressed, incomplete, malformed-length and partial-content responses are rejected", async (t) => {
  mediaHarness(t, [
    { headers: { "content-type": "image/png", "content-encoding": "gzip" } },
    { headers: { "content-type": "image/png", "content-length": "invalid" } },
    { headers: { "content-type": "image/png", "content-length": String(png.length + 1) } },
    { complete: false }, { status: 206 }, { status: 502 },
  ]);
  for (const code of ["media.encoding_unsupported", "media.response_invalid", "media.response_invalid",
    "media.response_invalid", "media.http_error", "media.http_error"]) {
    await denied("https://example.com/a", code);
  }
});

test("remote media requires an allowed MIME and matching signature", async (t) => {
  mediaHarness(t, [
    { headers: { "content-type": "image/png" }, body: Buffer.from("<!doctype html><html>login</html>") },
    { headers: { "content-type": "image/svg+xml" }, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    { headers: { "content-type": "text/plain" }, body: Buffer.from("<html>Login</html>") },
    { headers: {} },
  ]);
  for (const code of ["artifact.type_mismatch", "artifact.unsupported_type", "artifact.type_mismatch", "artifact.unsupported_type"]) {
    await denied("https://example.com/a", code);
  }
});

test("total deadline bounds DNS, response and body stalls; connect timeout is separate", async (t) => {
  const h = mediaHarness(t, [{ connectStall: true }, { responseStall: true }, { bodyStall: true }], (hostname) => {
    if (hostname === "dns.example") return new Promise(() => {});
    return [{ address: publicAddress, family: 4 }];
  });
  await denied("https://dns.example/a", "media.timeout", { timeoutMs: 20 });
  await denied("https://example.com/a", "media.timeout", { timeoutMs: 200, connectTimeoutMs: 20 });
  await denied("https://example.com/a", "media.timeout", { timeoutMs: 20 });
  await denied("https://example.com/a", "media.timeout", { timeoutMs: 20 });
  assert.ok(h.requests.every((record) => record.request.destroyed));
});

test("caller cancellation is safe and closes active requests", async (t) => {
  const h = mediaHarness(t, [{ bodyStall: true }]);
  const controller = new AbortController();
  const pending = fetchPublicMedia("https://example.com/a", { enabled: true, signal: controller.signal });
  setImmediate(() => controller.abort(new Error("private cancellation message")));
  await assert.rejects(pending, { code: "media.cancelled", message: "Media retrieval was cancelled." });
  assert.equal(h.requests[0].request.destroyed, true);
  await denied("https://example.com/a", "media.cancelled", { signal: controller.signal });
  assert.equal(h.requests.length, 1);
});

function resolverHarness(t, records = {}) {
  const instances = [];
  t.mock.method(dns, "Resolver", function (options) {
    const instance = {
      options, servers: [], calls: [], cancelled: 0,
      setServers(servers) { this.servers = servers; },
      async resolve4(hostname) {
        this.calls.push([4, hostname]);
        return records.resolve4 ? records.resolve4(hostname) : [publicAddress];
      },
      async resolve6(hostname) {
        this.calls.push([6, hostname]);
        if (records.resolve6) return records.resolve6(hostname);
        throw Object.assign(new Error("no records"), { code: "ENODATA" });
      },
      cancel() { this.cancelled += 1; },
    };
    instances.push(instance);
    return instance;
  });
  return instances;
}

test("explicit operator DNS uses an isolated resolver and still pins validated answers", async (t) => {
  const h = mediaHarness(t, [{}], () => { throw new Error("OS DNS must not run"); });
  const resolvers = resolverHarness(t);
  const result = await fetchPublicMedia("https://example.com/image", {
    enabled: true, dnsServers: ["1.1.1.1", "2606:4700:4700::1111"], timeoutMs: 1000,
  });
  assert.equal(result.mimeType, "image/png");
  assert.equal(h.dnsCalls.length, 0);
  assert.deepEqual(resolvers[0].servers, ["1.1.1.1", "2606:4700:4700::1111"]);
  assert.deepEqual(resolvers[0].options, { timeout: 1000, tries: 1 });
  assert.deepEqual(resolvers[0].calls, [[4, "example.com"], [6, "example.com"]]);
  assert.equal(resolvers[0].cancelled, 1);
  assert.equal(h.requests[0].lookupResults[1].address, publicAddress);
});

test("operator DNS configuration and its answers cannot relax private-address policy", async (t) => {
  const h = mediaHarness(t);
  const resolvers = resolverHarness(t, { resolve6: async () => ["::1"] });
  for (const dnsServers of [[], ["localhost"], ["127.0.0.1"], ["198.18.0.1"], ["1.1.1.1:5353"], ["::ffff:1.1.1.1"],
    ["1.1.1.1", "8.8.8.8", "9.9.9.9", "8.8.4.4"]]) {
    await denied("https://example.com/a", "media.invalid_options", { dnsServers });
  }
  await denied("https://example.com/a", "media.destination_denied", { dnsServers: ["1.1.1.1"] });
  assert.equal(resolvers.length, 1);
  assert.equal(h.requests.length, 0);
});

test("operator DNS timeout shares the total deadline and cancels outstanding queries", async (t) => {
  const h = mediaHarness(t);
  const resolvers = resolverHarness(t, { resolve4: () => new Promise(() => {}) });
  await denied("https://example.com/a", "media.timeout", { dnsServers: ["1.1.1.1"], timeoutMs: 20 });
  assert.ok(resolvers[0].cancelled >= 1);
  assert.equal(h.requests.length, 0);
});

test("operator DNS transport errors are not hidden by the other successful family", async (t) => {
  const h = mediaHarness(t);
  resolverHarness(t, { resolve6: async () => { throw Object.assign(new Error("sensitive DNS detail"), { code: "ETIMEOUT" }); } });
  await denied("https://example.com/a", "media.dns_failed", { dnsServers: ["1.1.1.1"] });
  assert.equal(h.requests.length, 0);
});

function officeZip(extension, extraEntries = [], edits = {}) {
  const parts = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" };
  const entries = [["[Content_Types].xml", "<Types/>"], [parts[extension], "<root/>"], ...extraEntries];
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(edits.flags || 0, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(edits.expandedSize || data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(edits.flags || 0, 8);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(edits.expandedSize || data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(edits.symlink ? 0xa1ff0000 : 0, 38);
    central.writeUInt32LE(localOffset, 42);
    const localEntry = Buffer.concat([local, nameBytes, data]);
    locals.push(localEntry);
    centrals.push(central, nameBytes);
    localOffset += localEntry.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("artifact validation accepts supported opaque files and returns actual integrity metadata", () => {
  const cases = [
    [png, "image/png", "png"],
    [Buffer.from([255, 216, 255, 217]), "image/jpeg", "jpg"],
    [Buffer.from("GIF89a\x01\0\x01\0\0\0\0;", "binary"), "image/gif", "gif"],
    [Buffer.from("RIFF\x0c\0\0\0WEBPVP8 \0\0\0\0", "binary"), "image/webp", "webp"],
    [Buffer.from("%PDF-1.7\n%%EOF\n"), "application/pdf", "pdf"],
    [Buffer.from("hello世界"), "text/plain; charset=utf-8", "txt"],
    [Buffer.from("# title"), "text/markdown", "md"],
    [Buffer.from("{\"ok\":true}"), "application/json", "json"],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "image/svg+xml", "svg"],
  ];
  for (const [bytes, mime, extension] of cases) {
    const result = validateArtifactBytes(bytes, mime);
    assert.equal(result.extension, extension);
    assert.equal(result.byteSize, bytes.length);
    assert.equal(result.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  }
});

test("artifact validation rejects empty, excessive, unsupported and mislabeled bytes", () => {
  assert.throws(() => validateArtifactBytes("text", "text/plain"), { code: "artifact.invalid_bytes" });
  assert.throws(() => validateArtifactBytes(Buffer.alloc(0), "text/plain"), { code: "artifact.invalid_bytes" });
  assert.throws(() => validateArtifactBytes(png, "image/png", { maxBytes: png.length - 1 }), { code: "artifact.too_large" });
  for (const mime of ["application/octet-stream", "application/x-msdownload", "image/avif", "text/unknown"]) {
    assert.throws(() => validateArtifactBytes(png, mime), { code: "artifact.unsupported_type" });
  }
  for (const [bytes, mime] of [[png, "image/jpeg"], [Buffer.from([0xff]), "text/plain"], [Buffer.from("a\0b"), "text/plain"],
    [Buffer.from("not-json"), "application/json"], [Buffer.from("<html/>"), "image/svg+xml"], [Buffer.from("%PDF-1.7"), "application/pdf"]]) {
    assert.throws(() => validateArtifactBytes(bytes, mime), { code: "artifact.type_mismatch" });
  }
});

test("OOXML documents use bounded ZIP envelopes and never enter the remote allowlist", () => {
  const types = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  for (const [extension, mime] of Object.entries(types)) {
    const bytes = officeZip(extension);
    assert.equal(validateArtifactBytes(bytes, mime).extension, extension);
    assert.throws(() => validateArtifactBytes(bytes, mime, { source: "https" }), { code: "artifact.unsupported_type" });
  }
  for (const bytes of [officeZip("xlsx"), officeZip("docx", [["../private", "secret"]]), officeZip("docx", [["/absolute", "secret"]]),
    officeZip("docx", [["C:\\private", "secret"]]), officeZip("docx", [["word/document.xml", "duplicate"]]),
    officeZip("docx", [], { flags: 1 }), officeZip("docx", [], { symlink: true }),
    officeZip("docx", [], { expandedSize: 51 * 1024 * 1024 }), officeZip("docx").subarray(0, 50)]) {
    assert.throws(() => validateArtifactBytes(bytes, types.docx), { code: "artifact.type_mismatch" });
  }
});
