import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import {
  AVATAR_INPUT_MIME_TYPES,
  AVATAR_MAX_INPUT_BYTES,
  AVATAR_MAX_INPUT_EDGE,
  AVATAR_MAX_INPUT_PIXELS,
  removeProfileAvatar,
  saveProfileAvatar
} from "../../apps/web/server/services/profile-avatar.mjs";
import {
  CUSTOM_EMOTE_MAX_INPUT_BYTES,
  CUSTOM_EMOTE_MAX_OUTPUT_BYTES,
  createWorkspaceCustomEmoteService
} from "../../apps/web/server/services/workspace-custom-emotes.mjs";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { createWorkspaceStorageObjectRegistry } from "../../apps/web/server/services/workspace-storage-objects.mjs";
import {
  spawnOwnedProcess,
  stopOwnedProcess,
  waitForExit
} from "../../e2e/support/owned-process.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const requireFromWeb = createRequire(path.join(repositoryRoot, "apps/web/package.json"));
const sharp = requireFromWeb("sharp");
const testdataPath = path.join(repositoryRoot, "apps/backend/internal/platform/media/testdata/cases.json");

export const MEDIA_LIMITS = Object.freeze({
  avatar: Object.freeze({
    maxInputBytes: AVATAR_MAX_INPUT_BYTES,
    maxInputPixels: AVATAR_MAX_INPUT_PIXELS,
    maxInputEdge: AVATAR_MAX_INPUT_EDGE,
    maxFrames: 180,
    maxDurationMs: 30_000,
    maxOutputBytes: 0,
    targetSize: 256,
    fallbackSize: 0,
    staticQuality: 82,
    animatedQuality: 82
  }),
  custom_emote: Object.freeze({
    maxInputBytes: CUSTOM_EMOTE_MAX_INPUT_BYTES,
    maxInputPixels: 40 * 1024 * 1024,
    maxInputEdge: 4096,
    maxFrames: 180,
    maxDurationMs: 30_000,
    maxOutputBytes: CUSTOM_EMOTE_MAX_OUTPUT_BYTES,
    targetSize: 256,
    fallbackSize: 192,
    staticQuality: 82,
    animatedQuality: 76,
    fallbackQuality: 62
  })
});

const MIME_TYPES = Object.freeze({
  avatar: AVATAR_INPUT_MIME_TYPES,
  custom_emote: new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"])
});

const MIME_BY_FORMAT = Object.freeze({
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp"
});

const MAX_GO_WAIT_MS = 120_000;
const DOCKER_CONTROL_TIMEOUT_MS = 15_000;
const DOCKER_RUN_LABEL = "com.duallane.media-compat-run";
const GO_IMAGE_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PROBE_ENV_MAX_BYTES = 4 * 1024;
const PIXEL_SAMPLE_GRID = 7;
const MAX_PIXEL_MEAN_ABS = 32;
const MAX_PIXEL_ALPHA_ABS = 16;
const OWNER_ERROR_NAMES = new Set([
  "ProfileAvatarError",
  "WorkspaceError",
  "WorkspaceValidationError",
  "WorkspacePermissionError"
]);

export async function runMediaCompatibility({ jsonOutput = false, goImage = undefined } = {}) {
  const normalizedGoImage = parseGoImageReference(goImage);
  const testdata = JSON.parse(await readFile(testdataPath, "utf8"));
  if (testdata.version !== 1 || !Array.isArray(testdata.cases) || testdata.cases.length === 0) {
    throw new Error("media compatibility corpus has an unsupported shape");
  }
  validateCaseSpecs(testdata.cases);

  const workDirectory = await mkdtemp(path.join(tmpdir(), "duallane-media-compat-"));
  let nodeEmoteOwner;
  try {
    const nodeEmoteDirectory = path.join(workDirectory, "node-emotes");
    await mkdir(nodeEmoteDirectory, { recursive: true });
    nodeEmoteOwner = createCustomEmoteOwner(nodeEmoteDirectory);
    const generated = new Map();
    const manifestCases = [];
    const nodeResults = new Map();
    for (const spec of testdata.cases) {
      trace(`case ${spec.id}: generate`);
      const input = await generateFixture(spec, generated);
      generated.set(spec.id, input);
      const inputPath = path.join(workDirectory, `${spec.id}.input`);
      const outputPath = path.join(workDirectory, `${spec.id}.go.webp`);
      await writeFile(inputPath, input, { mode: 0o600 });
      const nodeResult = await processWithNodeOwner(input, spec, workDirectory, nodeEmoteOwner);
      nodeResults.set(spec.id, nodeResult);
      trace(`case ${spec.id}: Node ${nodeResult.accepted ? "accepted" : nodeResult.error.code}`);
      manifestCases.push({
        id: spec.id,
        kind: spec.kind,
        mime: spec.mime,
        outputMaxBytes: spec.outputMaxBytes ?? 0,
        inputPath,
        outputPath
      });
    }

    const manifestPath = path.join(workDirectory, "manifest.json");
    const goReportPath = path.join(workDirectory, "go-report.json");
    await writeFile(manifestPath, JSON.stringify({ version: 1, cases: manifestCases }), { mode: 0o600 });
    const probe = await runGoProbe({
      manifestPath,
      goReportPath,
      workDirectory,
      goImage: normalizedGoImage
    });
    trace("Go probe complete");
    const goReport = JSON.parse(await readFile(goReportPath, "utf8"));
    if (goReport.version !== 1 || !Array.isArray(goReport.cases)) {
      throw new Error("Go compatibility probe returned an unsupported report");
    }

    const comparison = await compareReports(testdata.cases, nodeResults, goReport.cases, workDirectory);
    const report = {
      version: 1,
      baseCommit: await gitRevision(),
      environment: await environmentReport({ probe, goImage: normalizedGoImage }),
      budgets: {
        processingConcurrency: 2,
        vipsConcurrency: 1,
        vipsCacheMemoryBytes: 64 * 1024 * 1024,
        avatar: MEDIA_LIMITS.avatar,
        customEmote: MEDIA_LIMITS.custom_emote
      },
      pixelComparison: {
        gridPerPage: PIXEL_SAMPLE_GRID,
        maxColorMeanAbs: MAX_PIXEL_MEAN_ABS,
        maxAlphaMeanAbs: MAX_PIXEL_ALPHA_ABS,
        maxAlphaAbs: MAX_PIXEL_ALPHA_ABS
      },
      cases: comparison.cases,
      summary: comparison.summary,
      resourceEvidence: comparison.resourceEvidence
    };

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      printReport(report);
    }
    if (comparison.failures.length > 0) {
      const labels = comparison.failures.map((failure) => `${failure.id}: ${failure.reason}`);
      throw new Error(`media compatibility mismatches (${labels.join(", ")})`);
    }
    return report;
  } finally {
    nodeEmoteOwner?.db.close();
    await rm(workDirectory, { recursive: true, force: true });
  }
}

function trace(message) {
  if (process.env.DUALLANE_MEDIA_COMPAT_TRACE === "1") process.stderr.write(`[media-compat] ${message}\n`);
}

function validateCaseSpecs(cases) {
  const ids = new Set();
  for (const spec of cases) {
    if (!/^[a-z0-9-]+$/.test(spec.id) || ids.has(spec.id)) {
      throw new Error("media compatibility case IDs must be unique lowercase names");
    }
    ids.add(spec.id);
    if (!MIME_TYPES[spec.kind]) throw new Error(`unsupported media kind in corpus: ${spec.kind}`);
    if (spec.fixture === "truncated" && !spec.source) throw new Error(`truncated case has no source: ${spec.id}`);
    if (spec.fixture === "animation" && (!Number.isInteger(spec.frames) || spec.frames < 1)) {
      throw new Error(`animation case has invalid frame count: ${spec.id}`);
    }
  }
}

async function generateFixture(spec, generated) {
  switch (spec.fixture) {
    case "image":
      return await encodeImage(spec);
    case "animation":
      return await encodeAnimation(spec);
    case "bmp":
      return encodeBMP(spec);
    case "invalid":
      return Buffer.from("synthetic-media-fixture-not-an-image", "ascii");
    case "oversize":
      return Buffer.alloc(spec.bytes, 0x61);
    case "patched-png":
      return await encodePatchedPNG(spec.width, spec.height);
    case "truncated": {
      const source = generated.get(spec.source);
      if (!source) throw new Error(`truncated fixture source was not generated: ${spec.id}`);
      const end = Math.max(1, Math.min(source.length, spec.truncateAt ?? Math.floor(source.length / 2)));
      return source.subarray(0, end);
    }
    default:
      throw new Error(`unsupported fixture generator: ${spec.fixture}`);
  }
}

function makePattern(width, height, { frame = 0, pattern = "quadrants", channels = 4 } = {}) {
  const output = Buffer.alloc(width * height * channels);
  let noise = (0x6d2b79f5 ^ frame) >>> 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      let red;
      let green;
      let blue;
      if (pattern === "noise") {
        // Fixed-seed high entropy exercises the actual owner's output limit
        // without patching Sharp or substituting a smaller production limit.
        noise ^= noise << 13;
        noise ^= noise >>> 17;
        noise ^= noise << 5;
        red = noise & 255;
        green = (noise >>> 8) & 255;
        blue = (noise >>> 16) & 255;
      } else if (pattern === "stripes") {
        const stripe = Math.floor((x * 7) / Math.max(1, width)) % 4;
        red = [224, 30, 30, 220][stripe];
        green = [40, 190, 70, 130][stripe];
        blue = [50, 70, 210, 180][stripe];
      } else if (pattern === "frames") {
        red = (frame * 67 + x * 19) % 256;
        green = (frame * 31 + y * 29) % 256;
        blue = (frame * 13 + x * 7 + y * 11) % 256;
      } else {
        const left = x < width / 2;
        const top = y < height / 2;
        [red, green, blue] = top
          ? (left ? [228, 48, 48] : [44, 180, 76])
          : (left ? [42, 92, 220] : [232, 190, 42]);
      }
      output[offset] = red;
      output[offset + 1] = green;
      output[offset + 2] = blue;
      if (channels === 4) {
        output[offset + 3] = pattern === "quadrants-alpha"
          ? (x < width / 2 && y >= height / 2 ? 0 : 255)
          : 255;
      }
    }
  }
  return output;
}

async function encodeImage(spec) {
  const channels = spec.format === "jpeg" ? 3 : 4;
  let image = sharp(makePattern(spec.width, spec.height, { pattern: spec.pattern, channels }), {
    raw: { width: spec.width, height: spec.height, channels }
  });
  if (spec.metadata || spec.orientation) {
    image = image.withMetadata({ orientation: spec.orientation ?? 1, density: 300 });
  }
  switch (spec.format) {
    case "jpeg":
      return await image.jpeg({ quality: 91, chromaSubsampling: "4:4:4" }).toBuffer();
    case "png":
      return await image.png({ compressionLevel: 6 }).toBuffer();
    case "webp":
      return await image.webp({ quality: 91, effort: 4 }).toBuffer();
    default:
      throw new Error(`unsupported static fixture format: ${spec.format}`);
  }
}

async function encodeAnimation(spec) {
  const delays = Array.from({ length: spec.frames }, (_, index) => Number(spec.delays?.[index] ?? spec.delays?.at(-1) ?? 0));
  const raw = Buffer.concat(Array.from({ length: spec.frames }, (_, frame) => makePattern(
    spec.width,
    spec.height,
    { frame, pattern: spec.pattern, channels: 4 }
  )));
  const image = sharp(raw, {
    raw: { width: spec.width, height: spec.height * spec.frames, channels: 4, pageHeight: spec.height }
  });
  if (spec.format === "gif") {
    return await image.gif({ delay: delays, pageHeight: spec.height, loop: 0, dither: 0 }).toBuffer();
  }
  if (spec.format === "webp") {
    return await image.webp({ delay: delays, pageHeight: spec.height, loop: 0, effort: 4, quality: 82 }).toBuffer();
  }
  throw new Error(`unsupported animated fixture format: ${spec.format}`);
}

function encodeBMP(spec) {
  const bytesPerPixel = spec.bitsPerPixel / 8;
  const rowStride = Math.ceil(spec.width * bytesPerPixel / 4) * 4;
  const dataSize = rowStride * spec.height;
  const output = Buffer.alloc(54 + dataSize);
  output.write("BM", 0, "ascii");
  output.writeUInt32LE(output.length, 2);
  output.writeUInt32LE(54, 10);
  output.writeUInt32LE(40, 14);
  output.writeInt32LE(spec.width, 18);
  output.writeInt32LE(spec.topDown ? -spec.height : spec.height, 22);
  output.writeUInt16LE(1, 26);
  output.writeUInt16LE(spec.bitsPerPixel, 28);
  output.writeUInt32LE(0, 30);
  output.writeUInt32LE(dataSize, 34);
  const pixels = makePattern(spec.width, spec.height, { pattern: spec.pattern, channels: 4 });
  for (let sourceY = 0; sourceY < spec.height; sourceY += 1) {
    const logicalY = spec.topDown ? sourceY : spec.height - 1 - sourceY;
    for (let x = 0; x < spec.width; x += 1) {
      const source = (logicalY * spec.width + x) * 4;
      const target = 54 + sourceY * rowStride + x * bytesPerPixel;
      output[target] = pixels[source + 2];
      output[target + 1] = pixels[source + 1];
      output[target + 2] = pixels[source];
      if (bytesPerPixel === 4) output[target + 3] = pixels[source + 3];
    }
  }
  return output;
}

async function encodePatchedPNG(width, height) {
  const base = await sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } }
  }).png().toBuffer();
  const output = Buffer.from(base);
  output.writeUInt32BE(width, 16);
  output.writeUInt32BE(height, 20);
  output.writeUInt32BE(crc32(output.subarray(12, 29)) >>> 0, 29);
  return output;
}

async function processWithNodeOwner(input, spec, workDirectory, nodeEmoteOwner) {
  if (spec.kind === "avatar") return await processWithProfileAvatar(input, spec, workDirectory);
  return await processWithWorkspaceCustomEmote(input, spec, nodeEmoteOwner);
}

async function processWithProfileAvatar(input, spec, workDirectory) {
  let stored;
  try {
    stored = await saveProfileAvatar(path.join(workDirectory, "node-avatar"), {
      stream: Readable.from(input),
      mimeType: spec.mime,
      contentLength: input.length,
      userId: `media-compat-${spec.id}`
    });
    const output = await readFile(stored.path);
    const inputMetadata = await sharp(input, {
      failOn: "error",
      limitInputPixels: AVATAR_MAX_INPUT_PIXELS
    }).metadata();
    return await acceptedNodeResult(output, {
      detectedMimeType: MIME_BY_FORMAT[inputMetadata.format] ?? "",
      frameCount: Math.max(1, Number(inputMetadata.pages) || 1),
      durationMs: sumDelays(inputMetadata.delay)
    });
  } catch (error) {
    return rejected(ownerError(error));
  } finally {
    if (stored?.storageKey) await removeProfileAvatar(path.join(workDirectory, "node-avatar"), stored.storageKey).catch(() => {});
  }
}

async function processWithWorkspaceCustomEmote(input, spec, owner) {
  const actorId = `usr_media_${spec.id}`;
  try {
    ensureSyntheticActor(owner.db, actorId);
    const result = await owner.service.upload({
      actorId,
      stream: Readable.from(input),
      contentType: spec.mime,
      fileName: `${spec.id}.${extensionForMime(spec.mime)}`
    });
    const row = owner.db.prepare(`
      SELECT e.original_mime_type AS detectedMimeType,
        e.frame_count AS frameCount, e.duration_ms AS durationMs,
        so.sha256 AS sha256
      FROM workspace_custom_emotes e
      INNER JOIN workspace_storage_objects so ON so.id = e.storage_object_id
      WHERE e.id = ?
    `).get(result.id);
    const output = row ? owner.stored.get(row.sha256) : null;
    if (!output) throw new Error("synthetic Node storage object missing");
    return await acceptedNodeResult(output, {
      detectedMimeType: String(row.detectedMimeType ?? ""),
      frameCount: Math.max(1, Number(row.frameCount) || 1),
      durationMs: Number(row.durationMs) || 0
    });
  } catch (error) {
    return rejected(ownerError(error));
  }
}

function createCustomEmoteOwner(ownerDirectory) {
  const db = openTestDatabase(ownerDirectory);
  const stored = new Map();
  const objectStore = {
    async ensureObject(item) {
      if (stored.has(item.sha256)) return { ...item, created: false };
      const chunks = [];
      for await (const chunk of item.stream) chunks.push(Buffer.from(chunk));
      const buffer = Buffer.concat(chunks);
      if (buffer.byteLength !== item.byteSize) throw new Error("synthetic object size mismatch");
      const actualSha256 = createHash("sha256").update(buffer).digest("hex");
      if (actualSha256 !== item.sha256) throw new Error("synthetic object digest mismatch");
      stored.set(item.sha256, buffer);
      return { ...item, created: true };
    },
    async deleteObject(item) {
      stored.delete(item.sha256);
    }
  };
  const storageObjects = createWorkspaceStorageObjectRegistry({ db, objectStore });
  const service = createWorkspaceCustomEmoteService({ db, objectStore, storageObjects });
  return { db, service, stored };
}

function ensureSyntheticActor(db, actorId) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (
      id, github_id, github_login, email, display_name, nickname, avatar_url, kind, created_at, last_login_at
    ) VALUES (?, NULL, ?, NULL, ?, ?, NULL, 'human', ?, NULL)
    ON CONFLICT(id) DO NOTHING
  `).run(actorId, actorId, actorId, actorId, now);
  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
    VALUES ('spc_default', ?, 'member', ?, NULL)
    ON CONFLICT(space_id, user_id) DO NOTHING
  `).run(actorId, now);
}

async function acceptedNodeResult(output, input) {
  const outputMetadata = await sharp(output, { animated: input.frameCount > 1 }).metadata();
  return {
    accepted: true,
    output,
    outputInfo: {
      width: Number(outputMetadata.width) || 0,
      height: Number(outputMetadata.height) || 0,
      pages: Math.max(1, Number(outputMetadata.pages) || 1),
      pageHeight: Number(outputMetadata.pageHeight) || 0,
      delay: outputMetadata.delay ?? []
    },
    input
  };
}

function ownerError(error) {
  if (!OWNER_ERROR_NAMES.has(error?.name)) {
    return { code: "internal.error", message: "媒体处理失败", status: 500 };
  }
  return {
    code: typeof error?.code === "string" ? error.code : "internal.error",
    message: typeof error?.message === "string" && error.message.length > 0 ? error.message : "媒体处理失败",
    status: Number.isInteger(error?.statusCode) ? error.statusCode : 500
  };
}

function sumDelays(delays) {
  return Array.isArray(delays)
    ? delays.reduce((total, delay) => total + Math.max(0, Number(delay) || 0), 0)
    : 0;
}

function extensionForMime(mimeType) {
  return String(mimeType ?? "").split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
}

function rejected(error) {
  return { accepted: false, error };
}

export function parseGoImageReference(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !GO_IMAGE_PATTERN.test(value)) {
    throw new Error("--go-image must be an exact sha256:<64 lowercase hex> image ID");
  }
  return value;
}

export function buildNativeProbeContainerSpec({
  image,
  label,
  manifestPath,
  goReportPath,
  workDirectory,
  environmentPaths,
  containerUser = nativeProbeContainerUser()
}) {
  const probeCommand = [
    'mkdir -p "$GOCACHE"',
    'go version > "$DUALLANE_MEDIA_COMPATIBILITY_GO_VERSION"',
    'go env CGO_ENABLED > "$DUALLANE_MEDIA_COMPATIBILITY_GO_CGO"',
    'pkg-config --modversion vips-cpp > "$DUALLANE_MEDIA_COMPATIBILITY_LIBVIPS"',
    'exec go test -count=1 ./internal/platform/media -run "^TestMediaCompatibilityProbe$"'
  ].join(" && ");
  return {
    image,
    label,
    environmentPaths,
    args: [
      "create",
      "--rm",
      "--label", `${DOCKER_RUN_LABEL}=${label}`,
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      // The build-target test binary executes from Go's temporary directory.
      // This does not change the separate production runtime filesystem policy.
      "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=2g",
      "--user", containerUser,
      "--mount", `type=bind,src=${workDirectory},dst=${workDirectory}`,
      "--workdir", "/src/apps/backend",
      "--env", "GOPROXY=off",
      "--env", "GOCACHE=/tmp/duallane-go-build",
      "--env", `DUALLANE_MEDIA_COMPATIBILITY_MANIFEST=${manifestPath}`,
      "--env", `DUALLANE_MEDIA_COMPATIBILITY_OUTPUT=${goReportPath}`,
      "--env", `DUALLANE_MEDIA_COMPATIBILITY_WORKDIR=${workDirectory}`,
      "--env", `DUALLANE_MEDIA_COMPATIBILITY_GO_VERSION=${environmentPaths.goVersion}`,
      "--env", `DUALLANE_MEDIA_COMPATIBILITY_GO_CGO=${environmentPaths.goCgo}`,
      "--env", `DUALLANE_MEDIA_COMPATIBILITY_LIBVIPS=${environmentPaths.libvips}`,
      image,
      "/bin/sh",
      "-c",
      probeCommand
    ]
  };
}

export async function runGoProbe({ manifestPath, goReportPath, workDirectory, goImage, dockerRunner } = {}) {
  const normalizedGoImage = parseGoImageReference(goImage);
  if (normalizedGoImage) {
    return await runNativeGoProbe({
      manifestPath,
      goReportPath,
      workDirectory,
      goImage: normalizedGoImage,
      dockerRunner
    });
  }

  const goBinary = process.env.GO_BIN || "go";
  const environment = {
    ...process.env,
    GOPROXY: process.env.GOPROXY || "https://goproxy.cn,direct",
    DUALLANE_MEDIA_COMPATIBILITY_MANIFEST: manifestPath,
    DUALLANE_MEDIA_COMPATIBILITY_OUTPUT: goReportPath,
    DUALLANE_MEDIA_COMPATIBILITY_WORKDIR: workDirectory
  };
  const result = await spawnBounded(goBinary, ["test", "-count=1", "./internal/platform/media", "-run", "^TestMediaCompatibilityProbe$"], {
    cwd: path.join(repositoryRoot, "apps/backend"),
    env: environment,
    timeoutMs: MAX_GO_WAIT_MS
  });
  if (result.code !== 0) throw new Error(`Go compatibility probe failed with exit ${result.code ?? "signal"}`);
  return { mode: "host", environmentPaths: null };
}

async function runNativeGoProbe({ manifestPath, goReportPath, workDirectory, goImage, dockerRunner }) {
  const containerUser = nativeProbeContainerUser();
  const runner = dockerRunner ?? createDockerRunner();
  const imageID = await runner.inspectImage(goImage);
  if (imageID !== goImage) {
    throw new Error("Go image inspect did not confirm the requested image ID");
  }

  const environmentPaths = {
    goVersion: path.join(workDirectory, "go-version.txt"),
    goCgo: path.join(workDirectory, "go-cgo.txt"),
    libvips: path.join(workDirectory, "libvips-version.txt")
  };
  const label = randomUUID();
  const spec = buildNativeProbeContainerSpec({
    image: imageID,
    label,
    manifestPath,
    goReportPath,
    workDirectory,
    environmentPaths,
    containerUser
  });
  let containerID;
  try {
    const createdContainerID = await runner.create(spec);
    if (!/^[a-f0-9]{64}$/.test(createdContainerID)) {
      throw new Error("native Go probe returned an invalid container ID");
    }
    containerID = createdContainerID;
    const inspected = await runner.inspectContainer(containerID, label);
    if (inspected.missing || inspected.id !== containerID || inspected.image !== imageID || inspected.label !== label) {
      throw new Error("native Go probe container ownership could not be confirmed");
    }
    await runner.start(containerID, MAX_GO_WAIT_MS);
  } finally {
    if (containerID) await runner.remove(containerID, label);
  }
  return { mode: "native-container", environmentPaths, imageID };
}

function nativeProbeContainerUser() {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new Error("native Go probe requires Linux host UID/GID");
  }
  const uid = process.getuid();
  const gid = process.getgid();
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("native Go probe requires valid host UID/GID");
  }
  return `${uid}:${gid}`;
}

function createDockerRunner() {
  const invoke = (args, timeoutMs = DOCKER_CONTROL_TIMEOUT_MS) => spawnBounded("docker", args, {
    cwd: repositoryRoot,
    env: process.env,
    timeoutMs
  });

  return {
    async inspectImage(image) {
      const result = await invoke(["image", "inspect", "--format", "{{.Id}}", image]);
      if (result.code !== 0 || result.stdout.trim() !== image) {
        throw new Error("Go image inspect failed to confirm the exact local image ID");
      }
      return result.stdout.trim();
    },

    async create(spec) {
      const result = await invoke(["create", ...spec.args.slice(1)]);
      if (result.code !== 0) throw new Error("native Go probe container creation failed");
      const containerID = result.stdout.trim();
      if (!/^[a-f0-9]{64}$/.test(containerID)) {
        throw new Error("native Go probe returned an invalid container ID");
      }
      return containerID;
    },

    async inspectContainer(containerID) {
      const result = await invoke([
        "container", "inspect", "--format",
        `{{.Id}}\t{{.Image}}\t{{index .Config.Labels "${DOCKER_RUN_LABEL}"}}`,
        containerID
      ]);
      if (result.code === 0) {
        const fields = result.stdout.trim().split("\t");
        if (fields.length !== 3 || !/^[a-f0-9]{64}$/.test(fields[0]) || !GO_IMAGE_PATTERN.test(fields[1])) {
          throw new Error("native Go probe container inspection was malformed");
        }
        return { missing: false, id: fields[0], image: fields[1], label: fields[2] };
      }

      const listing = await invoke([
        "container", "ls", "--all", "--no-trunc", "--filter", `id=${containerID}`, "--format", "{{.ID}}"
      ]);
      if (listing.code !== 0) throw new Error("native Go probe container inspection failed");
      if (listing.stdout.trim() === "") return { missing: true };
      throw new Error("native Go probe container inspection failed");
    },

    async start(containerID, timeoutMs) {
      const result = await invoke(["start", "--attach", containerID], timeoutMs);
      if (result.code !== 0) throw new Error("native Go probe container failed");
    },

    async remove(containerID, label) {
      const before = await this.inspectContainer(containerID, label);
      if (before.missing) return;
      if (before.id !== containerID || before.label !== label) {
        throw new Error("native Go probe cleanup ownership check failed");
      }
      const result = await invoke(["rm", "--force", containerID]);
      if (result.code === 0) return;

      const after = await this.inspectContainer(containerID, label);
      if (after.missing) return;
      throw new Error("native Go probe container cleanup failed");
    }
  };
}

async function compareReports(specs, nodeResults, goCases, workDirectory) {
  const goByID = new Map(goCases.map((entry) => [entry.id, entry]));
  const cases = [];
  const failures = [];
  let accepted = 0;
  let rejected = 0;
  let pixelChecks = 0;
  const resourceEvidence = [];

  for (const spec of specs) {
    const node = nodeResults.get(spec.id);
    const go = goByID.get(spec.id);
    if (!go) {
      failures.push({ id: spec.id, reason: "Go result missing" });
      continue;
    }
    const result = { id: spec.id, kind: spec.kind, accepted: Boolean(node.accepted), node: summarizeNode(node), go };
    if (spec.expectedErrorCode && (node.accepted || node.error?.code !== spec.expectedErrorCode)) {
      failures.push({ id: spec.id, reason: "fixture did not reach its required owner rejection" });
    }
    if (spec.fixture === "oversize" || spec.fixture === "patched-png" || spec.id.includes("frames-over") || spec.id.includes("duration-over") || spec.id.includes("frames-at") || spec.id.includes("duration-at") || spec.id.includes("output")) {
      resourceEvidence.push({ id: spec.id, node: summarizeNode(node), go: summarizeGo(go) });
    }
    if (node.accepted !== go.accepted) {
      failures.push({ id: spec.id, reason: "accepted/rejected status differs" });
      cases.push(result);
      continue;
    }
    if (!node.accepted) {
      rejected += 1;
      if (!sameError(node.error, go.error)) failures.push({ id: spec.id, reason: "public failure code/status/message differs" });
      cases.push(result);
      continue;
    }
    accepted += 1;
    const goOutputPath = path.join(workDirectory, `${spec.id}.go.webp`);
    // The probe writes to the path supplied in the manifest. Resolve it from
    // the process-local naming convention rather than keeping bytes in JSON.
    const goBytes = await readFile(goOutputPath);
    const nodeMeta = await sharp(node.output).metadata();
    const goMeta = await sharp(goBytes, { animated: node.input.frameCount > 1 }).metadata();
    const metadataResult = compareOutputMetadata(node, go, nodeMeta, goMeta);
    const outputLimit = spec.outputMaxBytes || MEDIA_LIMITS[spec.kind].maxOutputBytes;
    if (outputLimit > 0 && (node.output.length > outputLimit || go.output.byteSize > outputLimit)) {
      metadataResult.failure = metadataResult.failure
        ? `${metadataResult.failure}; normalized output exceeds byte limit`
        : "normalized output exceeds byte limit";
    }
    result.output = metadataResult;
    if (metadataResult.failure) failures.push({ id: spec.id, reason: metadataResult.failure });
    const pixels = await comparePixels(node.output, goBytes, node.input.frameCount > 1);
    result.pixels = pixels;
    pixelChecks += 1;
    if (pixels.failure) failures.push({ id: spec.id, reason: pixels.failure });
    cases.push(result);
  }
  return {
    cases,
    failures,
    summary: { total: specs.length, accepted, rejected, pixelChecks, failures: failures.length },
    resourceEvidence
  };
}

function sameError(nodeError, goError) {
  return Boolean(nodeError && goError)
    && nodeError.code === goError.code
    && nodeError.message === goError.message
    && nodeError.status === goError.status;
}

function summarizeNode(node) {
  if (!node.accepted) return { accepted: false, error: node.error };
  return {
    accepted: true,
    byteSize: node.output.length,
    width: node.outputInfo.width,
    height: node.outputInfo.height,
    frameCount: node.input.frameCount,
    durationMs: node.input.durationMs,
    detectedMimeType: node.input.detectedMimeType,
    normalizedMimeType: "image/webp"
  };
}

function summarizeGo(go) {
  return go.accepted ? { accepted: true, output: go.output } : { accepted: false, error: go.error };
}

function compareOutputMetadata(node, go, nodeMeta, goMeta) {
  const expectedPages = Math.max(1, Number(nodeMeta.pages) || 1);
  const actualPages = Math.max(1, Number(goMeta.pages) || 1);
  const nodePageHeight = Number(node.outputInfo.pageHeight || (node.outputInfo.height / expectedPages));
  const goPageHeight = Number(goMeta.pageHeight || (goMeta.height / actualPages));
  const metadataFree = (meta) => ({
    exif: Boolean(meta.exif),
    icc: Boolean(meta.icc),
    iptc: Boolean(meta.iptc),
    xmp: Boolean(meta.xmp),
    tifftag: Boolean(meta.tifftag),
    hasProfile: Boolean(meta.hasProfile)
  });
  const result = {
    node: {
      format: nodeMeta.format,
      width: node.outputInfo.width,
      height: node.outputInfo.height,
      pages: expectedPages,
      pageHeight: nodePageHeight,
      delay: nodeMeta.delay ?? [],
      metadataFree: metadataFree(nodeMeta)
    },
    go: {
      format: goMeta.format,
      width: goMeta.width,
      height: goMeta.height,
      pages: actualPages,
      pageHeight: goPageHeight,
      delay: goMeta.delay ?? [],
      metadataFree: metadataFree(goMeta)
    }
  };
  const failures = [];
  if (nodeMeta.format !== "webp" || goMeta.format !== "webp") failures.push("normalized format is not WebP");
  if (expectedPages !== actualPages) failures.push("normalized frame count differs");
  if (node.outputInfo.width !== goMeta.width || nodePageHeight !== goPageHeight) failures.push("normalized page dimensions differ");
  if (JSON.stringify(nodeMeta.delay ?? []) !== JSON.stringify(goMeta.delay ?? [])) failures.push("normalized frame delays differ");
  if (JSON.stringify(result.node.metadataFree) !== JSON.stringify(result.go.metadataFree)) failures.push("metadata stripping differs");
  if (Object.values(result.node.metadataFree).some(Boolean) || Object.values(result.go.metadataFree).some(Boolean)) failures.push("normalized output retains metadata");
  // The public Go result is compared separately to the Node service's output
  // info, because animated Sharp reports the stacked canvas height while the
  // WebP header reports the per-page canvas height.
  if (go.output.detectedMimeType !== node.input.detectedMimeType) failures.push("detected MIME differs");
  if (go.output.normalizedMimeType !== "image/webp") failures.push("normalized MIME differs");
  if (go.output.frameCount !== node.input.frameCount || go.output.durationMS !== node.input.durationMs) failures.push("input animation metadata differs");
  if (failures.length > 0) result.failure = failures.join("; ");
  return result;
}

async function comparePixels(nodeBytes, goBytes, animated) {
  const nodePixels = await decodePixels(nodeBytes, animated);
  const goPixels = await decodePixels(goBytes, animated);
  if (nodePixels.pages !== goPixels.pages || nodePixels.pageHeight !== goPixels.pageHeight || nodePixels.width !== goPixels.width) {
    return {
      node: pixelSummary(nodePixels),
      go: pixelSummary(goPixels),
      failure: "decoded pixel dimensions differ"
    };
  }
  const samples = [];
  let colorAbs = 0;
  let alphaAbs = 0;
  let maxAbs = 0;
  let maxAlphaAbs = 0;
  for (let page = 0; page < nodePixels.pages; page += 1) {
    for (let gy = 0; gy < PIXEL_SAMPLE_GRID; gy += 1) {
      for (let gx = 0; gx < PIXEL_SAMPLE_GRID; gx += 1) {
        const x = Math.min(nodePixels.width - 1, Math.round(gx * (nodePixels.width - 1) / (PIXEL_SAMPLE_GRID - 1)));
        const y = Math.min(nodePixels.pageHeight - 1, Math.round(gy * (nodePixels.pageHeight - 1) / (PIXEL_SAMPLE_GRID - 1)));
        const nodeOffset = ((page * nodePixels.pageHeight + y) * nodePixels.width + x) * 4;
        const goOffset = ((page * goPixels.pageHeight + y) * goPixels.width + x) * 4;
        const nodePixel = nodePixels.data.subarray(nodeOffset, nodeOffset + 4);
        const goPixel = goPixels.data.subarray(goOffset, goOffset + 4);
        for (let channel = 0; channel < 3; channel += 1) {
          const difference = Math.abs(nodePixel[channel] - goPixel[channel]);
          colorAbs += difference;
          maxAbs = Math.max(maxAbs, difference);
        }
        const alphaDifference = Math.abs(nodePixel[3] - goPixel[3]);
        alphaAbs += alphaDifference;
        maxAlphaAbs = Math.max(maxAlphaAbs, alphaDifference);
        samples.push({ node: [...nodePixel], go: [...goPixel] });
      }
    }
  }
  const colorMeanAbs = colorAbs / (samples.length * 3);
  const alphaMeanAbs = alphaAbs / samples.length;
  const result = {
    sampleCount: samples.length,
    colorMeanAbs: Number(colorMeanAbs.toFixed(3)),
    alphaMeanAbs: Number(alphaMeanAbs.toFixed(3)),
    maxColorAbs: maxAbs,
    maxAlphaAbs,
    node: pixelSummary(nodePixels),
    go: pixelSummary(goPixels)
  };
  if (colorMeanAbs > MAX_PIXEL_MEAN_ABS || alphaMeanAbs > MAX_PIXEL_ALPHA_ABS || maxAlphaAbs > MAX_PIXEL_ALPHA_ABS) {
    result.failure = "decoded feature pixels differ beyond tolerance";
  }
  return result;
}

async function decodePixels(buffer, animated) {
  const metadata = await sharp(buffer, animated ? { animated: true } : {}).metadata();
  const decoded = await sharp(buffer, animated ? { animated: true } : {})
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pages = Math.max(1, Number(decoded.info.pages || metadata.pages) || 1);
  const pageHeight = Number(decoded.info.pageHeight || metadata.pageHeight || (decoded.info.height / pages));
  return {
    data: decoded.data,
    width: decoded.info.width,
    height: decoded.info.height,
    pages,
    pageHeight
  };
}

function pixelSummary(pixels) {
  const samplePoints = [];
  for (const [xFraction, yFraction] of [[0, 0], [0.5, 0.5], [1, 1]]) {
    const x = Math.min(pixels.width - 1, Math.round(xFraction * (pixels.width - 1)));
    const y = Math.min(pixels.pageHeight - 1, Math.round(yFraction * (pixels.pageHeight - 1)));
    const offset = (y * pixels.width + x) * 4;
    samplePoints.push([...pixels.data.subarray(offset, offset + 4)]);
  }
  return { width: pixels.width, height: pixels.height, pages: pixels.pages, pageHeight: pixels.pageHeight, samples: samplePoints };
}

export async function environmentReport({ probe = null, goImage = undefined } = {}) {
  if (probe?.mode === "native-container") {
    return {
      node: process.version,
      sharp: sharp.versions,
      platform: `${process.platform}/${process.arch}`,
      go: await readProbeEnvironmentValue(probe.environmentPaths.goVersion, "Go version", (value) => /^go version go\d+(?:\.\d+)+(?:[a-z]+\d*)?\s+\S+\/\S+$/.test(value)),
      systemLibvips: await readProbeEnvironmentValue(probe.environmentPaths.libvips, "libvips version", (value) => /^\d+\.\d+(?:\.\d+)?(?:[-+~][0-9A-Za-z.-]+)?$/.test(value)),
      goCgo: await readProbeEnvironmentValue(probe.environmentPaths.goCgo, "CGO_ENABLED", (value) => value === "1"),
      goSource: "container",
      goImage
    };
  }

  const goBinary = process.env.GO_BIN || "go";
  const go = await commandOutput(goBinary, ["version"], repositoryRoot);
  const cgo = await commandOutput(goBinary, ["env", "CGO_ENABLED"], repositoryRoot);
  const pkgConfig = await commandOutput("pkg-config", ["--modversion", "vips-cpp"], repositoryRoot);
  return {
    node: process.version,
    sharp: sharp.versions,
    platform: `${process.platform}/${process.arch}`,
    go: go.trim(),
    systemLibvips: pkgConfig.trim(),
    goCgo: cgo.trim() || "unavailable"
  };
}

async function readProbeEnvironmentValue(filePath, fieldName, validate) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > PROBE_ENV_MAX_BYTES) {
      throw new Error("oversized or non-file evidence");
    }
    const buffer = Buffer.alloc(PROBE_ENV_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > PROBE_ENV_MAX_BYTES) {
      throw new Error("oversized evidence");
    }
    const value = buffer.subarray(0, bytesRead).toString("utf8").trim();
    if (!value || value.includes("\u0000") || !validate(value)) {
      throw new Error("invalid evidence");
    }
    return value;
  } catch {
    throw new Error(`native Go probe ${fieldName} evidence is invalid`);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function gitRevision() {
  const result = await commandOutput("git", ["rev-parse", "HEAD"], repositoryRoot);
  return result.trim();
}

async function commandOutput(command, args, cwd) {
  const result = await spawnBounded(command, args, { cwd, env: process.env, timeoutMs: 15_000 });
  if (result.code !== 0) return "unavailable";
  return result.stdout;
}

async function spawnBounded(command, args, { cwd, env, timeoutMs }) {
  const child = spawnOwnedProcess(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let startError = null;
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.once("error", (error) => { startError = error; });
  const exit = waitForExit(child);
  let timer;
  try {
    const result = await Promise.race([
      exit,
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          try {
            await stopOwnedProcess(child, 1_000);
          } catch {
            // The helper owns the process group; cleanup remains bounded even
            // when the child exits between the timeout and the signal.
          }
          reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
    if (startError) throw new Error(`${command} could not start: ${startError.code ?? "error"}`);
    return {
      code: result.code,
      signal: result.signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child, 1_000).catch(() => {});
  }
}

function printReport(report) {
  console.log(`Media compatibility: ${report.summary.failures === 0 ? "PASS" : "FAIL"}`);
  console.log(`Base commit: ${report.baseCommit}`);
  const goSource = report.environment.goSource === "container"
    ? `container ${report.environment.goImage}`
    : "host";
  console.log(`Environment: Node ${report.environment.node}, Sharp ${report.environment.sharp.sharp}, Sharp/libvips ${report.environment.sharp.vips}, Go ${report.environment.go} (${goSource}), system libvips ${report.environment.systemLibvips}`);
  console.log(`Cases: ${report.summary.total}; accepted ${report.summary.accepted}; rejected ${report.summary.rejected}; pixel checks ${report.summary.pixelChecks}; failures ${report.summary.failures}`);
  console.log(`Pixel comparison: ${report.pixelComparison.gridPerPage}x${report.pixelComparison.gridPerPage} samples per page; color mean <= ${report.pixelComparison.maxColorMeanAbs}; alpha mean/max <= ${report.pixelComparison.maxAlphaMeanAbs}`);
  console.log(`Budgets: avatar input ${report.budgets.avatar.maxInputBytes}B/${report.budgets.avatar.maxInputPixels}px/${report.budgets.avatar.maxInputEdge}px; emote input ${report.budgets.customEmote.maxInputBytes}B/${report.budgets.customEmote.maxInputPixels}px/${report.budgets.customEmote.maxInputEdge}px/${report.budgets.customEmote.maxFrames} frames/${report.budgets.customEmote.maxDurationMs}ms; output ${report.budgets.customEmote.maxOutputBytes}B; processing concurrency ${report.budgets.processingConcurrency}`);
  for (const evidence of report.resourceEvidence) {
    const node = evidence.node.accepted ? `accepted/${evidence.node.byteSize}B` : `${evidence.node.error.code}/${evidence.node.error.status}`;
    const go = evidence.go.accepted ? `accepted/${evidence.go.output.byteSize}B` : `${evidence.go.error.code}/${evidence.go.error.status}`;
    console.log(`Limit evidence ${evidence.id}: Node ${node}; Go ${go}`);
  }
}

export function parseMediaCompatibilityArguments(argv) {
  const options = { jsonOutput: false, goImage: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.jsonOutput = true;
      continue;
    }
    if (argument === "--go-image") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--go-image requires an exact sha256:<64 lowercase hex> image ID");
      options.goImage = parseGoImageReference(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--go-image=")) {
      options.goImage = parseGoImageReference(argument.slice("--go-image=".length));
      continue;
    }
    throw new Error("unsupported media compatibility option");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const jsonOutput = process.argv.includes("--json");
  Promise.resolve()
    .then(() => parseMediaCompatibilityArguments(process.argv.slice(2)))
    .then((options) => runMediaCompatibility(options))
    .catch((error) => {
      if (jsonOutput) {
        process.stderr.write(`${error.message}\n`);
      } else {
        console.error(`Media compatibility: FAIL (${error.message})`);
      }
      process.exitCode = 1;
    });
}
