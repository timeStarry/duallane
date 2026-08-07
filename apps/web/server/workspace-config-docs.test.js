import { readFile as readRawFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MESSAGE_CONTENT_FORMAT } from "./services/workspace.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

async function readFile(filePath, encoding) {
  return (await readRawFile(filePath, encoding)).replace(/\r\n/g, "\n");
}

describe("workspace configuration docs", () => {
  it("does not advertise an unused owner environment variable", async () => {
    const envExample = await readFile(path.join(repoRoot, ".env.example"), "utf8");

    expect(envExample).not.toContain("OWNER_GITHUB_LOGIN");
    expect(envExample).toContain("WORKSPACE_ENABLED=false");
    expect(envExample).toContain("GITHUB_CLIENT_ID=");
    expect(envExample).toContain("GITHUB_CLIENT_SECRET=");
    expect(envExample).toContain("GITHUB_OAUTH_TIMEOUT_MS=8000");
    expect(envExample).toContain("DATABASE_URL=postgresql://");
    expect(envExample).toContain("POSTGRES_IMAGE=docker.m.daocloud.io/library/postgres:17-alpine");
    expect(envExample).toContain("POSTGRES_PASSWORD=");
    expect(envExample).toContain("DUALLANE_STUN_URLS=stun:stun.l.google.com:19302");
    expect(envExample).toContain("DUALLANE_TURN_URLS=");
    expect(envExample).toContain("DUALLANE_TURN_SHARED_SECRET=");
    expect(envExample).toContain("DUALLANE_TURN_TTL_SECONDS=600");
    expect(envExample).toContain("DUALLANE_TURN_USERNAME=");
    expect(envExample).toContain("DUALLANE_TURN_CREDENTIAL=");
    expect(envExample).toContain("DUALLANE_EMPTY_ROOM_GRACE_MS=10000");
  });

  it("documents local fallback and production OAuth requirements", async () => {
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

    expect(readme).toContain("WORKSPACE_ENABLED=true");
    expect(readme).toContain("timeStarry");
    expect(readme).toContain("GITHUB_CLIENT_ID");
    expect(readme).toContain("GITHUB_CLIENT_SECRET");
    expect(readme).toContain("Production GitHub login fails closed");
  });

  it("forwards workspace OAuth and trusted-proxy settings through Compose", async () => {
    const compose = await readFile(path.join(repoRoot, "docker-compose.yml"), "utf8");
    const envExample = await readFile(path.join(repoRoot, ".env.example"), "utf8");
    const nginx = await readFile(path.join(repoRoot, "deploy", "nginx", "default.conf"), "utf8");

    expect(compose).toContain("GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID:-}");
    expect(compose).toContain("GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET:-}");
    expect(compose).toContain("GITHUB_OAUTH_TIMEOUT_MS: ${GITHUB_OAUTH_TIMEOUT_MS:-8000}");
    expect(compose).toContain("WORKSPACE_FRONTEND_URL: ${WORKSPACE_FRONTEND_URL:-}");
    expect(compose).toContain("TRUST_PROXY: ${TRUST_PROXY:-true}");
    expect(compose).toContain("image: ${POSTGRES_IMAGE:-docker.m.daocloud.io/library/postgres:17-alpine}");
    expect(compose).toContain("condition: service_completed_successfully");
    expect(compose).toContain("DATABASE_AUTO_MIGRATE: \"false\"");
    expect(compose).toContain("PGHOST: postgres");
    expect(compose).toContain("PGPASSWORD: ${POSTGRES_PASSWORD:-replace-this-before-production}");
    expect(compose).toContain("DUALLANE_STUN_URLS: ${DUALLANE_STUN_URLS:-stun:stun.l.google.com:19302}");
    expect(compose).toContain("DUALLANE_TURN_URLS: ${DUALLANE_TURN_URLS:-}");
    expect(compose).toContain("DUALLANE_TURN_SHARED_SECRET: ${DUALLANE_TURN_SHARED_SECRET:-}");
    expect(compose).toContain("DUALLANE_TURN_TTL_SECONDS: ${DUALLANE_TURN_TTL_SECONDS:-600}");
    expect(compose).toContain("DUALLANE_TURN_USERNAME: ${DUALLANE_TURN_USERNAME:-}");
    expect(compose).toContain("DUALLANE_TURN_CREDENTIAL: ${DUALLANE_TURN_CREDENTIAL:-}");
    expect(compose).toContain("DUALLANE_EMPTY_ROOM_GRACE_MS: ${DUALLANE_EMPTY_ROOM_GRACE_MS:-10000}");
    expect(envExample).toContain("WORKSPACE_FRONTEND_URL=\n");
    expect(envExample).not.toContain("WORKSPACE_FRONTEND_URL=http://127.0.0.1:5173");
    expect(envExample).toContain("TRUST_PROXY=true");
    expect(nginx).toContain("map $http_x_forwarded_proto $duallane_forwarded_proto");
    expect(nginx).toContain("proxy_set_header X-Forwarded-Proto $duallane_forwarded_proto");
    const callbackLocation = nginx.match(/location = \/api\/auth\/github\/callback \{([\s\S]*?)\n  \}/)?.[1] ?? "";
    expect(callbackLocation).toContain("error_log /dev/null crit;");
    expect(callbackLocation).toContain("proxy_pass http://api:8787;");
    expect(nginx).toContain('"$request_method $uri $server_protocol"');
    expect(nginx).not.toContain("$request_uri");
    expect(nginx).not.toContain("$http_referer");
  });

  it("keeps private S3 storage, migration tooling, and public delivery documented and wired", async () => {
    const compose = await readFile(path.join(repoRoot, "docker-compose.yml"), "utf8");
    const envExample = await readFile(path.join(repoRoot, ".env.example"), "utf8");
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    const caddy = await readFile(path.join(repoRoot, "deploy", "caddy", "fs.tsio.top.caddy"), "utf8");
    const credentialsExample = await readFile(
      path.join(repoRoot, "deploy", "minio", "workspace-s3-credentials.example.json"),
      "utf8"
    );

    for (const source of [compose, envExample]) {
      expect(source).toContain("WORKSPACE_STORAGE_DRIVER");
      expect(source).toContain("WORKSPACE_S3_ENDPOINT");
      expect(source).toContain("WORKSPACE_S3_PUBLIC_ENDPOINT");
      expect(source).toContain("WORKSPACE_S3_BUCKET");
      expect(source).toContain("WORKSPACE_S3_REGION");
      expect(source).toContain("WORKSPACE_S3_CREDENTIALS_FILE");
      expect(source).toContain("WORKSPACE_S3_SIGNED_URL_TTL_SECONDS");
      expect(source).toContain("WORKSPACE_STORAGE_LOCAL_READ_FALLBACK");
      expect(source).toContain("WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE");
    }
    expect(compose).toContain('profiles: ["storage-migration"]');
    expect(compose).toContain("WORKSPACE_S3_CREDENTIALS_FILE: /run/secrets/workspace-s3");
    expect(compose).toContain("mode: 0600");
    expect(compose).toContain("file: ${WORKSPACE_S3_CREDENTIALS_FILE:-./deploy/minio/workspace-s3-credentials.example.json}");
    expect(envExample).toContain("WORKSPACE_S3_BUCKET=duallane");
    expect(envExample).toContain("WORKSPACE_S3_PUBLIC_ENDPOINT=https://fs.tsio.top");
    expect(credentialsExample).not.toContain("AKIA");
    expect(readme).toContain("workspace-s3-migration-reports");
    expect(readme).toContain("complete remote GET and SHA-256 verification");

    expect(caddy).toContain("method GET HEAD");
    expect(caddy).toContain("method OPTIONS");
    expect(caddy).toContain("/duallane/workspace/attachments/*");
    expect(caddy).toContain("/duallane/workspace/profile-avatars/*");
    expect(caddy).not.toContain("migration-archive");
    expect(caddy).toContain("output discard");
  });

  it("documents private-lane relay and room lifecycle settings", async () => {
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    const server = await readFile(path.join(repoRoot, "apps", "web", "server", "index.mjs"), "utf8");

    expect(readme).toContain("DUALLANE_TURN_SHARED_SECRET");
    expect(readme).toContain("DUALLANE_STUN_URLS");
    expect(readme).toContain("DUALLANE_TURN_URLS");
    expect(readme).toContain("DUALLANE_TURN_TTL_SECONDS");
    expect(readme).toContain("DUALLANE_TURN_USERNAME");
    expect(readme).toContain("DUALLANE_TURN_CREDENTIAL");
    expect(readme).toContain("DUALLANE_EMPTY_ROOM_GRACE_MS");
    expect(readme).toContain("Prefer `turns:`");
    expect(server).toContain("iceServers: getIceServers(env)");
  });

  it("uses versioned PostgreSQL migrations without a runtime SQLite fallback", async () => {
    const database = await readFile(path.join(repoRoot, "apps", "web", "server", "services", "db.mjs"), "utf8");
    const migration = await readFile(path.join(repoRoot, "apps", "web", "server", "migrations", "001_initial.sql"), "utf8");

    expect(database).toContain('from "pg"');
    expect(database).not.toContain('from "node:sqlite"');
    expect(migration).toContain("byte_size BIGINT");
    expect(migration).toContain("workspace_event_cursors");
    expect(migration).not.toContain("PRAGMA");
  });

  it("documents production OAuth state matching as a required auth boundary", async () => {
    const apiContract = await readFile(path.join(repoRoot, "docs", "WORKSPACE_API_CONTRACT.md"), "utf8");
    const authDesign = await readFile(path.join(repoRoot, "docs", "WORKSPACE_AUTH_INVITE_DESIGN.md"), "utf8");

    for (const source of [apiContract, authDesign]) {
      expect(source).toContain("missing or mismatched OAuth state");
      expect(source).toContain("exchanging the");
      expect(source).toContain("GitHub authorization code");
    }
  });

  it("keeps documented workspace member-management routes aligned with implementation", async () => {
    const apiContract = await readFile(path.join(repoRoot, "docs", "WORKSPACE_API_CONTRACT.md"), "utf8");
    const server = await readFile(path.join(repoRoot, "apps", "web", "server", "index.mjs"), "utf8");

    expect(apiContract).toContain("PATCH /api/workspace/members/:userId/role");
    expect(apiContract).toContain("DELETE /api/workspace/members/:userId");
    expect(apiContract).not.toContain("POST /api/workspace/members/:userId/remove");
    expect(server).toContain('app.patch("/api/workspace/members/:userId/role"');
    expect(server).toContain('app.delete("/api/workspace/members/:userId"');
  });

  it("keeps documented workspace message format aligned with implementation", async () => {
    const apiContract = await readFile(path.join(repoRoot, "docs", "WORKSPACE_API_CONTRACT.md"), "utf8");
    const dataModel = await readFile(path.join(repoRoot, "docs", "WORKSPACE_DATA_MODEL_DESIGN.md"), "utf8");

    expect(apiContract).toContain(MESSAGE_CONTENT_FORMAT);
    expect(dataModel).toContain(MESSAGE_CONTENT_FORMAT);
    expect(apiContract).not.toContain("workspace.message.v1");
    expect(dataModel).not.toContain("workspace.message.v1");
  });

  it("documents the implemented lightweight workspace response envelopes", async () => {
    const apiContract = await readFile(path.join(repoRoot, "docs", "WORKSPACE_API_CONTRACT.md"), "utf8");
    const bootstrapStart = apiContract.indexOf("Ready response:");
    const bootstrapEnd = apiContract.indexOf("Entry-state responses:", bootstrapStart);
    const bootstrapSource = apiContract.slice(bootstrapStart, bootstrapEnd);

    expect(apiContract).toContain("route-specific resource envelopes");
    expect(apiContract).toContain("There is no\nmandatory top-level `data` or `meta` wrapper");
    expect(bootstrapStart).toBeGreaterThan(-1);
    expect(bootstrapEnd).toBeGreaterThan(bootstrapStart);
    expect(bootstrapSource).toContain('"auth": {');
    expect(bootstrapSource).toContain('"permissions": {');
    expect(bootstrapSource).toContain('"files": []');
    expect(bootstrapSource).not.toContain('"attachments": []');
    expect(apiContract).toContain('"invite": {');
    expect(apiContract).toContain('"message": {');
    expect(apiContract).toContain('"upload": {');
    expect(apiContract).toContain('"remainingBytes"');
    expect(apiContract).not.toContain("Common success envelope");
  });

  it("keeps documented workspace error codes aligned with implemented client codes", async () => {
    const apiContract = await readFile(path.join(repoRoot, "docs", "WORKSPACE_API_CONTRACT.md"), "utf8");
    const stateDesign = await readFile(path.join(repoRoot, "docs", "WORKSPACE_STATE_FEEDBACK_DESIGN.md"), "utf8");
    const client = await readFile(path.join(repoRoot, "apps", "web", "src", "App.tsx"), "utf8");

    for (const source of [apiContract, stateDesign, client]) {
      expect(source).toContain("auth.not_invited");
      expect(source).toContain("auth.identity_conflict");
      expect(source).toContain("message.idempotency_conflict");
    }
    expect(apiContract).not.toContain("workspace.not_invited");
    expect(stateDesign).not.toContain("idempotency.conflict");
  });

  it("keeps shared-space product copy away from stale relay and history labels", async () => {
    const docsToCheck = [
      "DESIGN.md",
      path.join("docs", "O2O_PRODUCT_DESIGN.md"),
      path.join("docs", "WORKSPACE_PRODUCT_DESIGN.md"),
      path.join("docs", "WORKSPACE_MVP_DEVELOPMENT_CONTRACT.md"),
      path.join("docs", "WORKSPACE_IM_PRODUCT_DESIGN.md"),
      path.join("docs", "WORKSPACE_MEMBER_PERMISSION_DESIGN.md"),
      path.join("docs", "WORKSPACE_SPACE_SETTINGS_DESIGN.md"),
      path.join("docs", "WORKSPACE_USER_FLOW_DESIGN.md")
    ];

    for (const doc of docsToCheck) {
      const source = await readFile(path.join(repoRoot, doc), "utf8");
      expect(source, doc).not.toContain("共享空间中转");
      expect(source, doc).not.toContain("工作区中转");
      expect(source, doc).not.toContain("审计留存");
      expect(source, doc).not.toContain("记录查看员");
    }

    const productDocs = await Promise.all(
      docsToCheck
        .filter((doc) => doc !== path.join("docs", "O2O_PRODUCT_DESIGN.md"))
        .map((doc) => readFile(path.join(repoRoot, doc), "utf8"))
    );
    for (const source of productDocs) {
      expect(source).not.toContain("历史记录按会话保留");
    }
  });
});
