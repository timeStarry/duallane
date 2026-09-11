import { existsSync } from "node:fs";
import { readFile as readRawFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

async function readFile(filePath, encoding) {
  return (await readRawFile(filePath, encoding)).replace(/\r\n/g, "\n");
}

async function readGoMessageContentFormat() {
  const source = await readFile(
    path.join(repoRoot, "apps", "backend", "internal", "workspace", "messages", "model.go"),
    "utf8"
  );
  const match = source.match(/MessageContentFormat\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("Go MessageContentFormat constant is missing");
  return match[1];
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
    expect(envExample).toContain("WORKSPACE_NTFY_BASE_URL=https://ntfy.tsio.top");
    expect(envExample).toContain("WORKSPACE_NTFY_WORKER_ENABLED=true");
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

  it("uses the Go-only local runner and keeps the single-origin harness explicit", async () => {
    const rootPackage = await readFile(path.join(repoRoot, "package.json"), "utf8");
    const webPackage = await readFile(path.join(repoRoot, "apps", "web", "package.json"), "utf8");
    const devConfig = await readFile(path.join(repoRoot, "scripts", "dev", "go-dev-config.mjs"), "utf8");
    const devRunner = await readFile(path.join(repoRoot, "scripts", "dev", "go-dev.mjs"), "utf8");
    const defaultPlaywright = await readFile(path.join(repoRoot, "playwright.config.ts"), "utf8");
    const defaultTestServer = await readFile(path.join(repoRoot, "e2e", "support", "test-server.mjs"), "utf8");
    const workspacePlaywright = await readFile(path.join(repoRoot, "playwright.workspace-go.config.ts"), "utf8");
    const rootManifest = JSON.parse(rootPackage);
    const webManifest = JSON.parse(webPackage);

    expect(rootManifest.scripts.dev).toMatch(/go-dev\.mjs|@duallane\/web dev/);
    expect(webManifest.scripts.dev).toContain("go-dev.mjs");
    expect(devConfig).toContain("p2p: 8897");
    expect(devConfig).toContain("workspace: 8898");
    expect(devConfig).toContain("web: 5173");
    expect(devConfig).toContain("DUALLANE_API_ORIGIN");
    expect(devRunner).toContain("never starts the retired Node API");
    expect(devRunner).toContain('go run ./cmd/migrate');
    expect(devRunner).toContain("DUALLANE_API_ORIGIN");
    expect(devRunner).toContain("single-origin");
    expect(defaultPlaywright).toContain('testMatch: ["p2p.spec.ts", "p2p-ime.spec.ts"]');
    expect(defaultPlaywright).toContain("node e2e/support/test-server.mjs");
    expect(defaultTestServer).toContain("./go-p2p-server.mjs");
    expect(defaultTestServer).not.toContain("server/index.mjs");
    expect(workspacePlaywright).toContain('testMatch: "workspace*.spec.ts"');
    expect(workspacePlaywright).toContain("go-workspace-server.mjs");
  });

  it("forwards workspace OAuth and trusted-proxy settings through the Go Compose gateway", async () => {
    const compose = await readFile(path.join(repoRoot, "docker-compose.yml"), "utf8");
    const goCompose = await readFile(path.join(repoRoot, "docker-compose.go-production.yml"), "utf8");
    const envExample = await readFile(path.join(repoRoot, ".env.example"), "utf8");
    const nginx = await readFile(path.join(repoRoot, "deploy", "candidate", "nginx.conf"), "utf8");

    expect(compose).toContain("extends:");
    expect(compose).toContain("file: docker-compose.go-production.yml");
    expect(compose).not.toMatch(/^\s+api:/m);
    expect(goCompose).toContain("GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID:-}");
    expect(goCompose).toContain("GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET:-}");
    expect(goCompose).toContain("GITHUB_OAUTH_TIMEOUT_MS: ${GITHUB_OAUTH_TIMEOUT_MS:-8000}");
    expect(goCompose).toContain("WORKSPACE_FRONTEND_URL: ${WORKSPACE_FRONTEND_URL:-}");
    expect(goCompose).toContain("WORKSPACE_NTFY_BASE_URL: ${WORKSPACE_NTFY_BASE_URL:-https://ntfy.tsio.top}");
    expect(goCompose).toContain("WORKSPACE_NTFY_WORKER_ENABLED: ${WORKSPACE_NTFY_WORKER_ENABLED:-true}");
    expect(goCompose).toContain("TRUST_PROXY: ${TRUST_PROXY:-true}");
    expect(goCompose).toContain("condition: service_completed_successfully");
    expect(goCompose).toContain("DUALLANE_MIGRATIONS_DIR: /app/migrations");
    expect(goCompose).toContain("PGHOST: postgres");
    expect(goCompose).toContain("PGPASSWORD: ${POSTGRES_PASSWORD:?database password is required}");
    expect(goCompose).toContain("DUALLANE_STUN_URLS: ${DUALLANE_STUN_URLS:-stun:stun.l.google.com:19302}");
    expect(goCompose).toContain("DUALLANE_TURN_URLS: ${DUALLANE_TURN_URLS:-}");
    expect(goCompose).toContain("DUALLANE_TURN_SHARED_SECRET: ${DUALLANE_TURN_SHARED_SECRET:-}");
    expect(goCompose).toContain("DUALLANE_TURN_TTL_SECONDS: ${DUALLANE_TURN_TTL_SECONDS:-600}");
    expect(goCompose).toContain("DUALLANE_TURN_USERNAME: ${DUALLANE_TURN_USERNAME:-}");
    expect(goCompose).toContain("DUALLANE_TURN_CREDENTIAL: ${DUALLANE_TURN_CREDENTIAL:-}");
    expect(goCompose).toContain("DUALLANE_EMPTY_ROOM_GRACE_MS: ${DUALLANE_EMPTY_ROOM_GRACE_MS:-10000}");
    expect(goCompose).toContain("healthcheck:");
    expect(goCompose).toContain("http://127.0.0.1:8787/readyz");
    expect(envExample).toContain("WORKSPACE_FRONTEND_URL=\n");
    expect(envExample).not.toContain("WORKSPACE_FRONTEND_URL=http://127.0.0.1:5173");
    expect(envExample).toContain("TRUST_PROXY=true");
    expect(nginx).toContain("map $http_x_forwarded_proto $duallane_forwarded_proto");
    expect(nginx).toContain("proxy_set_header X-Forwarded-Proto $duallane_forwarded_proto");
    const callbackLocation = nginx.match(/location = \/api\/auth\/github\/callback \{([\s\S]*?)\n  \}/)?.[1] ?? "";
    expect(callbackLocation).toContain("error_log /dev/null crit;");
    expect(callbackLocation).toContain("proxy_pass http://workspace:8787;");
    expect(nginx).toContain('"$request_method $uri $server_protocol"');
    expect(nginx).not.toContain("$request_uri");
    expect(nginx).not.toContain("$http_referer");
    expect(nginx).toContain("location /emotes/ {");
    expect(nginx).toContain("expires 7d;");
  });

  it("preflights four Go candidates and keeps the guarded Go-to-Go handoff gates", async () => {
    const deploy = await readFile(path.join(repoRoot, "deploy", "production", "deploy.sh"), "utf8");
    const helper = await readFile(path.join(repoRoot, "deploy", "production", "release-helper.sh"), "utf8");

    expect(deploy).toContain('source "${SCRIPT_DIR}/release-helper.sh"');
    expect(deploy).toContain("only Go-to-Go upgrades");
    expect(deploy).toContain("--go-upgrade");
    expect(deploy).toContain("--previous-release-snapshot");
    expect(deploy).toContain("Node runtime retired");
    expect(deploy).toContain("release_require_drained_runtime");
    expect(deploy).toContain("preflight_candidates");
    expect(deploy).toContain("start_release_backend");
    expect(deploy).toContain("start_release_edge");
    expect(deploy).toMatch(/preflight_candidates[\s\S]*start_release_backend[\s\S]*start_release_edge/);
    expect(helper).toContain("release_start_candidates");
    expect(helper).toContain('release_wait_candidate "${candidate_name}" "${service}" || return 1');
    expect(helper).toContain('release_verify_candidate_mode "${candidate_name}" "${service}" || return 1');
    expect(deploy).toContain("bootstrap");
    expect(deploy).toContain("prepare_go_permissions");
  });

  it("requires verified Go release metadata and removes online Node image/gateway inputs", async () => {
    const deploy = await readFile(path.join(repoRoot, "deploy", "production", "deploy.sh"), "utf8");
    const p2pDockerfile = await readFile(path.join(repoRoot, "Dockerfile.p2p"), "utf8");
    const workspaceDockerfile = await readFile(path.join(repoRoot, "Dockerfile.workspace"), "utf8");
    const webDockerfile = await readFile(path.join(repoRoot, "deploy", "candidate", "Dockerfile.web"), "utf8");
    const goCompose = await readFile(path.join(repoRoot, "docker-compose.go-production.yml"), "utf8");
    const envExample = await readFile(path.join(repoRoot, ".env.example"), "utf8");
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    const agents = await readFile(path.join(repoRoot, "AGENTS.md"), "utf8");

    expect(deploy).toContain("--expected-commit is required for production deployment");
    expect(deploy).toContain("--expected-commit must be a full 40-character lowercase Git SHA");
    expect(deploy).toContain('production_dir="${production_dir:-${HOME}/duallane}"');
    expect(deploy).toContain('if [[ "${PROJECT_DIR}" != "${production_dir}" ]]');
    expect(deploy).toContain('current_branch}" != "main"');
    expect(deploy).toContain("refs/remotes/origin/main");
    expect(deploy).toContain("version_is_greater");
    expect(deploy).toContain('running_app_commit}" != "${current_commit}');
    expect(deploy).toContain('wait_for_app "${health_url}" "${expected_app_version}"');
    expect(deploy).toContain("verify_container_release");
    expect(deploy).toContain('prune_buildx_cache "${buildx_cache_max}"');
    expect(deploy).toContain("trap on_exit EXIT");
    expect(deploy).toContain("stop_buildx_builder");
    for (const dockerfile of [p2pDockerfile, workspaceDockerfile, webDockerfile]) {
      expect(dockerfile).toContain("org.opencontainers.image.version");
      expect(dockerfile).toContain("org.opencontainers.image.revision");
    }
    expect(goCompose).toContain("DUALLANE_APP_VERSION: ${DUALLANE_APP_VERSION:?release version is required}");
    expect(goCompose).toContain("DUALLANE_GIT_COMMIT: ${DUALLANE_GIT_COMMIT:?full release commit is required}");
    expect(goCompose).toContain("image: duallane-go-workspace:${DUALLANE_GIT_COMMIT:?full release commit is required}");
    expect(envExample).toContain("DUALLANE_APP_VERSION=0.19.1");
    expect(envExample).toContain("DUALLANE_GIT_COMMIT=development");
    expect(readme).toMatch(/verified\s+release metadata/);
    expect(readme).toContain("/home/timestarry/duallane");
    expect(agents).toContain("Deploy production only from the local checkout at `/home/timestarry/duallane`");
    expect(agents).toContain("Do not use SSH or SCP");
    expect(existsSync(path.join(repoRoot, "Dockerfile.api"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "Dockerfile.web"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "deploy", "nginx", "default.conf"))).toBe(false);
  });

  it("bounds production container logs", async () => {
    const compose = await readFile(path.join(repoRoot, "docker-compose.production.yml"), "utf8");
    const goCompose = await readFile(path.join(repoRoot, "docker-compose.go-production.yml"), "utf8");
    const envExample = await readFile(path.join(repoRoot, ".env.example"), "utf8");

    expect(compose).toContain("driver: json-file");
    expect(compose).toContain("max-size:");
    expect(compose).toContain("max-file:");
    expect(goCompose).toContain("x-go-logging:");
    expect(goCompose).toContain("logging: *go-logging");
    expect(envExample).toContain("DUALLANE_LOG_MAX_SIZE=10m");
    expect(envExample).toContain("DUALLANE_LOG_MAX_FILE=5");
    expect(envExample).toContain("DUALLANE_BUILDX_CACHE_MAX=4gb");
  });

  it("keeps the isolated Node compatibility storage operators explicit and offline", async () => {
    const compose = await readFile(path.join(repoRoot, "docker-compose.yml"), "utf8");
    const envExample = await readFile(path.join(repoRoot, ".env.example"), "utf8");
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    const caddy = await readFile(path.join(repoRoot, "deploy", "caddy", "fs.tsio.top.caddy"), "utf8");
    const credentialsExample = await readFile(
      path.join(repoRoot, "deploy", "minio", "workspace-s3-credentials.example.json"),
      "utf8"
    );
    const compatPackage = await readFile(path.join(repoRoot, "tools", "node-compat", "package.json"), "utf8");
    const compatDockerfile = await readFile(path.join(repoRoot, "tools", "node-compat", "Dockerfile"), "utf8");
    const compatReadme = await readFile(path.join(repoRoot, "tools", "node-compat", "README.md"), "utf8");

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
    expect(compose).toContain('dockerfile: tools/node-compat/Dockerfile');
    expect(compose).toContain('profiles: ["storage-migration"]');
    expect(compose).toContain('profiles: ["storage-dedupe"]');
    expect(compose).toContain("WORKSPACE_S3_CREDENTIALS_FILE: /run/secrets/workspace-s3");
    expect(compose).toContain("mode: 0600");
    expect(envExample).toContain("WORKSPACE_S3_BUCKET=duallane");
    expect(envExample).toContain("WORKSPACE_S3_PUBLIC_ENDPOINT=https://fs.tsio.top");
    expect(credentialsExample).not.toContain("AKIA");
    expect(compatPackage).toContain('"pg"');
    expect(compatPackage).toContain('"@aws-sdk/client-s3"');
    expect(compatPackage).toContain('"storage:migrate"');
    expect(compatPackage).toContain('"storage:dedupe"');
    expect(compatPackage).toContain('"storage:provision"');
    expect(compatDockerfile).toContain('CMD ["node", "--help"]');
    expect(compatReadme).toContain("not the online API");
    expect(compatReadme).toMatch(/does not run migrations or\s+seed data/);
    expect(readme).toContain("workspace-s3-migration-reports");
    expect(readme).toContain("complete remote GET and SHA-256 verification");

    expect(caddy).toContain("method GET HEAD");
    expect(caddy).toContain("method OPTIONS");
    expect(caddy).toContain("/duallane/workspace/attachments/*");
    expect(caddy).toContain("/duallane/workspace/profile-avatars/*");
    expect(caddy).toContain("/duallane/workspace/custom-emotes/*");
    expect(caddy).not.toContain("migration-archive");
    expect(caddy).toContain("output discard");
  });

  it("documents private-lane relay and room lifecycle settings in the Go P2P implementation", async () => {
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    const config = await readFile(path.join(repoRoot, "apps", "backend", "internal", "platform", "config", "config.go"), "utf8");
    const p2p = await readFile(path.join(repoRoot, "apps", "backend", "internal", "p2p", "transport.go"), "utf8");

    expect(readme).toContain("DUALLANE_TURN_SHARED_SECRET");
    expect(readme).toContain("DUALLANE_STUN_URLS");
    expect(readme).toContain("DUALLANE_TURN_URLS");
    expect(readme).toContain("DUALLANE_TURN_TTL_SECONDS");
    expect(readme).toContain("DUALLANE_TURN_USERNAME");
    expect(readme).toContain("DUALLANE_TURN_CREDENTIAL");
    expect(readme).toContain("DUALLANE_EMPTY_ROOM_GRACE_MS");
    expect(readme).toContain("Prefer `turns:`");
    expect(config).toContain('"DUALLANE_STUN_URLS"');
    expect(config).toContain('"DUALLANE_TURN_URLS"');
    expect(p2p).toContain('router.Get("/api/p2p/ice-servers"');
    expect(p2p).toContain('json:"iceServers"');
  });

  it("uses the Go PostgreSQL migration runner and canonical SQL without an online SQLite fallback", async () => {
    const postgres = await readFile(path.join(repoRoot, "apps", "backend", "internal", "platform", "postgres", "migrations.go"), "utf8");
    const migration = await readFile(path.join(repoRoot, "apps", "web", "server", "migrations", "001_initial.sql"), "utf8");
    const goCompose = await readFile(path.join(repoRoot, "docker-compose.go-production.yml"), "utf8");

    expect(postgres).toContain("github.com/jackc/pgx/v5");
    expect(postgres).toContain("func OpenFromEnv");
    expect(migration).toContain("byte_size BIGINT");
    expect(migration).toContain("workspace_event_cursors");
    expect(migration).not.toContain("PRAGMA");
    expect(goCompose).toContain("DUALLANE_MIGRATIONS_DIR: /app/migrations");
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

  it("keeps documented workspace member-management routes aligned with the Go API", async () => {
    const apiContract = await readFile(path.join(repoRoot, "docs", "WORKSPACE_API_CONTRACT.md"), "utf8");
    const openapi = await readFile(path.join(repoRoot, "apps", "backend", "api", "workspace-core.yaml"), "utf8");
    const routes = await readFile(path.join(repoRoot, "apps", "backend", "internal", "workspace", "httpapi", "core_routes.go"), "utf8");

    expect(apiContract).toContain("PATCH /api/workspace/members/:userId/role");
    expect(apiContract).toContain("DELETE /api/workspace/members/:userId");
    expect(apiContract).not.toContain("POST /api/workspace/members/:userId/remove");
    expect(openapi).toContain("/api/workspace/members/{userId}/role:");
    expect(openapi).toContain("/api/workspace/members/{userId}:");
    expect(routes).toContain('router.Patch("/members/{userId}/role"');
    expect(routes).toContain('router.Delete("/members/{userId}"');
  });

  it("keeps documented workspace message format aligned with the Go implementation", async () => {
    const apiContract = await readFile(path.join(repoRoot, "docs", "WORKSPACE_API_CONTRACT.md"), "utf8");
    const dataModel = await readFile(path.join(repoRoot, "docs", "WORKSPACE_DATA_MODEL_DESIGN.md"), "utf8");
    const messageContentFormat = await readGoMessageContentFormat();

    expect(apiContract).toContain(messageContentFormat);
    expect(dataModel).toContain(messageContentFormat);
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
