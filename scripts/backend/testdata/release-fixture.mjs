// Pure Compose documents for the isolated Node-to-Go release lifecycle test.
//
// This module deliberately has no filesystem, Docker, or network dependency.
// The caller owns private-file creation, image inspection, labels, and all
// lifecycle operations.  The returned documents are image-pinned fixture
// inputs, not a production deployment entry point.

const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const DOCKER_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/u;
const POSIX_ABSOLUTE_PATH_PATTERN = /^\/(?:[^\u0000-\u001f\u007f/]+\/)*[^\u0000-\u001f\u007f/]*$/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/][^\u0000-\u001f\u007f]*$/u;

const DATABASE_NAME = "duallane";
const DATABASE_USER = "duallane";
const DATABASE_PASSWORD = "duallane-ci-password";
const NODE_SESSION_SECRET = "duallane-release-node-session-secret";
const SYNTHETIC_S3_ENDPOINT = "http://127.0.0.1:9";
const SYNTHETIC_S3_PUBLIC_ENDPOINT = "https://127.0.0.1:9";
const SYNTHETIC_S3_BUCKET = "duallane";
const SYNTHETIC_S3_REGION = "us-east-1";
const S3_SECRET_TARGET = "/run/secrets/workspace-s3";

function invalid(code) {
  throw new TypeError(code);
}

function requireString(value, code) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(code);
  }
  return value;
}

function requireImage(value, code) {
  const image = requireString(value, code);
  if (!IMAGE_ID_PATTERN.test(image)) invalid(code);
  return image;
}

function requireVersion(value, code) {
  const version = requireString(value, code);
  if (!VERSION_PATTERN.test(version)) invalid(code);
  return version;
}

function requireCommit(value, code) {
  const commit = requireString(value, code);
  if (!COMMIT_PATTERN.test(commit)) invalid(code);
  return commit;
}

function requireName(value, code, pattern = DOCKER_NAME_PATTERN) {
  const name = requireString(value, code);
  if (!pattern.test(name)) invalid(code);
  return name;
}

function requireAbsolutePath(value, code) {
  const path = requireString(value, code);
  if (
    (!POSIX_ABSOLUTE_PATH_PATTERN.test(path) && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(path)) ||
    path.includes("..") ||
    path.endsWith("/") ||
    path.endsWith("\\")
  ) {
    invalid(code);
  }
  return path;
}

function requirePort(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    invalid("web_port_invalid");
  }
  return String(value);
}

function buildMetadata(version, commit) {
  return {
    DUALLANE_APP_VERSION: version,
    DUALLANE_GIT_COMMIT: commit,
  };
}

function databaseEnvironment() {
  return {
    PGHOST: "postgres",
    PGPORT: "5432",
    PGDATABASE: DATABASE_NAME,
    PGUSER: DATABASE_USER,
    PGPASSWORD: DATABASE_PASSWORD,
    DATABASE_SSL: "false",
  };
}

function storageEnvironment() {
  return {
    WORKSPACE_STORAGE_DRIVER: "local",
    WORKSPACE_S3_ENDPOINT: SYNTHETIC_S3_ENDPOINT,
    WORKSPACE_S3_PUBLIC_ENDPOINT: SYNTHETIC_S3_PUBLIC_ENDPOINT,
    WORKSPACE_S3_BUCKET: SYNTHETIC_S3_BUCKET,
    WORKSPACE_S3_REGION: SYNTHETIC_S3_REGION,
    WORKSPACE_S3_CREDENTIALS_FILE: S3_SECRET_TARGET,
    WORKSPACE_S3_SIGNED_URL_TTL_SECONDS: "300",
    WORKSPACE_STORAGE_LOCAL_READ_FALLBACK: "false",
    WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE: "false",
  };
}

function secretMount() {
  return [{ source: "workspace-s3", target: "workspace-s3", mode: "0600" }];
}

function dataVolume() {
  return [{ type: "volume", source: "duallane-data", target: "/app/data" }];
}

function postgresVolume() {
  return [{
    type: "volume",
    source: "duallane-postgres",
    target: "/var/lib/postgresql/data",
  }];
}

function postgresService({ image, restart }) {
  return {
    image,
    pull_policy: "never",
    environment: {
      POSTGRES_DB: DATABASE_NAME,
      POSTGRES_USER: DATABASE_USER,
      POSTGRES_PASSWORD: DATABASE_PASSWORD,
    },
    healthcheck: {
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U $$POSTGRES_USER -d $$POSTGRES_DB"],
      interval: "3s",
      timeout: "5s",
      retries: 20,
      start_period: "5s",
    },
    volumes: postgresVolume(),
    networks: ["default"],
    restart,
  };
}

function nodeAPIEnvironment({ version, commit, port }) {
  return {
    HOST: "0.0.0.0",
    PORT: "8787",
    NODE_ENV: "production",
    ...buildMetadata(version, commit),
    DUALLANE_DATA_DIR: "/app/data",
    ...databaseEnvironment(),
    DATABASE_AUTO_MIGRATE: "false",
    DATABASE_POOL_MAX: "10",
    SESSION_SECRET: NODE_SESSION_SECRET,
    PUBLIC_BASE_URL: `http://localhost:${port}`,
    WORKSPACE_ENABLED: "true",
    WORKSPACE_SMTP_ENCRYPTION_KEY: "",
    WORKSPACE_EMAIL_WORKER_ENABLED: "false",
    WORKSPACE_NTFY_BASE_URL: "https://127.0.0.1:9",
    WORKSPACE_NTFY_WORKER_ENABLED: "false",
    WORKSPACE_MAINTENANCE_WORKER_ENABLED: "false",
    WORKSPACE_ECHO_WORKER_ENABLED: "false",
    ...storageEnvironment(),
    WORKSPACE_FRONTEND_URL: `http://localhost:${port}`,
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    GITHUB_PROXY_URL: "",
    GITHUB_OAUTH_TIMEOUT_MS: "8000",
    TRUST_PROXY: "true",
    SERVE_STATIC: "false",
    DUALLANE_STUN_URLS: "",
    DUALLANE_TURN_URLS: "",
    DUALLANE_TURN_SHARED_SECRET: "",
    DUALLANE_TURN_TTL_SECONDS: "600",
    DUALLANE_TURN_USERNAME: "",
    DUALLANE_TURN_CREDENTIAL: "",
    DUALLANE_EMPTY_ROOM_GRACE_MS: "10000",
  };
}

function nodeAPIService({ image, root, version, commit, port }) {
  return {
    image,
    pull_policy: "never",
    build: {
      context: root,
      dockerfile: "Dockerfile.api",
      args: buildMetadata(version, commit),
    },
    depends_on: {
      migrate: { condition: "service_completed_successfully" },
    },
    expose: ["8787"],
    healthcheck: {
      test: [
        "CMD",
        "node",
        "-e",
        "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(v=>{if(v.ok!==true)process.exit(1)}).catch(()=>process.exit(1))",
      ],
      interval: "3s",
      timeout: "3s",
      retries: 20,
      start_period: "5s",
    },
    environment: nodeAPIEnvironment({ version, commit, port }),
    volumes: dataVolume(),
    secrets: secretMount(),
    networks: ["default"],
    restart: "always",
  };
}

function nodeMigrateService({ image, root, version, commit }) {
  return {
    image,
    pull_policy: "never",
    build: {
      context: root,
      dockerfile: "Dockerfile.api",
      args: buildMetadata(version, commit),
    },
    command: ["pnpm", "--filter", "@duallane/web", "db:migrate"],
    depends_on: {
      postgres: { condition: "service_healthy" },
    },
    environment: {
      ...buildMetadata(version, commit),
      ...databaseEnvironment(),
      DATABASE_POOL_MAX: "2",
    },
    networks: ["default"],
    restart: "no",
  };
}

function nodeWebService({ image, root, version, commit, port }) {
  return {
    image,
    pull_policy: "never",
    build: {
      context: root,
      dockerfile: "Dockerfile.web",
      args: buildMetadata(version, commit),
    },
    ports: [`127.0.0.1:${port}:8080`],
    depends_on: {
      api: { condition: "service_healthy" },
    },
    healthcheck: {
      test: [
        "CMD-SHELL",
        "wget -q -O - http://127.0.0.1:8080/api/health | grep -q '\"ok\":true'",
      ],
      interval: "3s",
      timeout: "3s",
      retries: 20,
      start_period: "5s",
    },
    networks: ["default", "gateway"],
    restart: "always",
  };
}

function goP2PService({ image, root, version, commit, port }) {
  return {
    image,
    pull_policy: "never",
    build: {
      context: root,
      dockerfile: "Dockerfile.p2p",
      args: buildMetadata(version, commit),
    },
    user: "65532:65532",
    read_only: true,
    expose: ["8787"],
    environment: {
      HOST: "0.0.0.0",
      PORT: "8787",
      NODE_ENV: "production",
      ...buildMetadata(version, commit),
      PUBLIC_BASE_URL: `http://localhost:${port}`,
      TRUST_PROXY: "true",
      DUALLANE_STUN_URLS: "",
      DUALLANE_TURN_URLS: "",
      DUALLANE_TURN_SHARED_SECRET: "",
      DUALLANE_TURN_TTL_SECONDS: "600",
      DUALLANE_TURN_USERNAME: "",
      DUALLANE_TURN_CREDENTIAL: "",
      DUALLANE_EMPTY_ROOM_GRACE_MS: "10000",
    },
    healthcheck: {
      test: ["CMD", "/usr/local/bin/duallane-healthcheck", "http://127.0.0.1:8787/api/health"],
      interval: "3s",
      timeout: "4s",
      retries: 20,
      start_period: "5s",
    },
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "5" },
    },
    networks: ["default"],
    restart: "always",
  };
}

function goWorkspaceEnvironment({ version, commit, port, worker }) {
  return {
    HOST: "0.0.0.0",
    PORT: "8787",
    NODE_ENV: "production",
    ...buildMetadata(version, commit),
    WORKSPACE_ENABLED: "true",
    DUALLANE_DATA_DIR: "/app/data",
    DUALLANE_MIGRATIONS_DIR: "/app/migrations",
    ...databaseEnvironment(),
    DATABASE_POOL_MAX: worker ? "4" : "10",
    PUBLIC_BASE_URL: `http://localhost:${port}`,
    WORKSPACE_FRONTEND_URL: `http://localhost:${port}`,
    WORKSPACE_SMTP_ENCRYPTION_KEY: "",
    WORKSPACE_NTFY_BASE_URL: "https://127.0.0.1:9",
    WORKSPACE_STORAGE_DRIVER: "local",
    ...storageEnvironment(),
    WORKSPACE_CANDIDATE_HEALTH_ONLY: "false",
    WORKER_VALIDATE_ONLY: "false",
    WORKSPACE_EMAIL_WORKER_ENABLED: "false",
    WORKSPACE_NTFY_WORKER_ENABLED: "false",
    WORKSPACE_MAINTENANCE_WORKER_ENABLED: worker ? "true" : "false",
    WORKSPACE_ECHO_WORKER_ENABLED: "false",
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    GITHUB_PROXY_URL: "",
    GITHUB_OAUTH_TIMEOUT_MS: "8000",
    TRUST_PROXY: "true",
  };
}

function goWorkspaceService({ image, root, version, commit, port }) {
  return {
    image,
    pull_policy: "never",
    build: {
      context: root,
      dockerfile: "Dockerfile.workspace",
      args: buildMetadata(version, commit),
    },
    entrypoint: ["/usr/local/bin/duallane-workspace"],
    user: "65532:65532",
    read_only: true,
    tmpfs: ["/tmp"],
    expose: ["8787"],
    depends_on: {
      postgres: { condition: "service_healthy" },
      migrate: { condition: "service_completed_successfully" },
    },
    environment: goWorkspaceEnvironment({ version, commit, port, worker: false }),
    volumes: dataVolume(),
    secrets: secretMount(),
    healthcheck: {
      test: ["CMD", "/usr/local/bin/duallane-healthcheck", "http://127.0.0.1:8787/readyz"],
      interval: "3s",
      timeout: "4s",
      retries: 20,
      start_period: "10s",
    },
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "5" },
    },
    networks: ["default"],
    restart: "always",
  };
}

function goWorkerService({ image, root, version, commit, port }) {
  return {
    image,
    pull_policy: "never",
    build: {
      context: root,
      dockerfile: "Dockerfile.workspace",
      args: buildMetadata(version, commit),
    },
    entrypoint: ["/usr/local/bin/duallane-worker"],
    user: "65532:65532",
    read_only: true,
    tmpfs: ["/tmp"],
    depends_on: {
      postgres: { condition: "service_healthy" },
      migrate: { condition: "service_completed_successfully" },
    },
    environment: goWorkspaceEnvironment({ version, commit, port, worker: true }),
    volumes: dataVolume(),
    secrets: secretMount(),
    healthcheck: {
      test: ["CMD", "/usr/local/bin/duallane-healthcheck", "http://127.0.0.1:8787/readyz"],
      interval: "3s",
      timeout: "4s",
      retries: 20,
      start_period: "10s",
    },
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "5" },
    },
    networks: ["default"],
    restart: "always",
  };
}

function goMigrateService({ image, root, version, commit }) {
  return {
    image,
    pull_policy: "never",
    build: {
      context: root,
      dockerfile: "Dockerfile.workspace",
      args: buildMetadata(version, commit),
    },
    entrypoint: ["/usr/local/bin/duallane-migrate"],
    command: [],
    user: "65532:65532",
    read_only: true,
    tmpfs: ["/tmp"],
    depends_on: {
      postgres: { condition: "service_healthy" },
    },
    environment: {
      ...buildMetadata(version, commit),
      DUALLANE_MIGRATIONS_DIR: "/app/migrations",
      ...databaseEnvironment(),
    },
    networks: ["default"],
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "5" },
    },
    restart: "no",
  };
}

function goWebService({ image, root, version, commit, port }) {
  return {
    image,
    pull_policy: "never",
    build: {
      context: root,
      dockerfile: "deploy/candidate/Dockerfile.web",
      args: buildMetadata(version, commit),
    },
    user: "101:101",
    read_only: true,
    tmpfs: ["/tmp", "/var/cache/nginx:uid=101,gid=101,mode=0700"],
    ports: [`127.0.0.1:${port}:8080`],
    expose: ["8080"],
    depends_on: {
      p2p: { condition: "service_healthy" },
      workspace: { condition: "service_healthy" },
    },
    healthcheck: {
      test: ["CMD-SHELL", "wget -q -O - http://127.0.0.1:8080/api/health | grep -q '\"ok\":true'"],
      interval: "5s",
      timeout: "3s",
      retries: 12,
      start_period: "5s",
    },
    networks: ["default", "gateway"],
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "5" },
    },
    restart: "always",
  };
}

function topLevel({ project, network, gatewayNetwork, postgresVolumeName, dataVolumeName, secretPath }) {
  return {
    name: project,
    networks: {
      default: {
        external: true,
        name: network,
      },
      gateway: {
        external: true,
        name: gatewayNetwork,
      },
    },
    volumes: {
      "duallane-data": {
        external: true,
        name: dataVolumeName,
      },
      "duallane-postgres": {
        external: true,
        name: postgresVolumeName,
      },
    },
    secrets: {
      "workspace-s3": {
        file: secretPath,
      },
    },
  };
}

function validateInputs(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    invalid("fixture_options_invalid");
  }
  const project = requireName(options.project, "project_invalid", PROJECT_NAME_PATTERN);
  const images = options.images;
  if (images === null || typeof images !== "object" || Array.isArray(images)) {
    invalid("images_invalid");
  }
  const imageValues = {
    node: requireImage(images.node, "node_image_invalid"),
    nodeWeb: requireImage(images.nodeWeb, "node_web_image_invalid"),
    goWorkspace: requireImage(images.goWorkspace, "go_workspace_image_invalid"),
    goP2P: requireImage(images.goP2P, "go_p2p_image_invalid"),
    goWeb: requireImage(images.goWeb, "go_web_image_invalid"),
    postgres: requireImage(images.postgres, "postgres_image_invalid"),
  };
  const versions = options.versions;
  if (versions === null || typeof versions !== "object" || Array.isArray(versions)) {
    invalid("versions_invalid");
  }
  const versionValues = {
    node: requireVersion(versions.node, "node_version_invalid"),
    go: requireVersion(versions.go, "go_version_invalid"),
  };
  const commits = options.commits;
  if (commits === null || typeof commits !== "object" || Array.isArray(commits)) {
    invalid("commits_invalid");
  }
  const commitValues = {
    node: requireCommit(commits.node, "node_commit_invalid"),
    go: requireCommit(commits.go, "go_commit_invalid"),
  };
  const names = options.names;
  if (names === null || typeof names !== "object" || Array.isArray(names)) {
    invalid("names_invalid");
  }
  const nameValues = {
    network: requireName(names.network, "network_invalid"),
    gatewayNetwork: requireName(names.gatewayNetwork, "gateway_network_invalid"),
    postgresVolume: requireName(names.postgresVolume, "postgres_volume_invalid"),
    dataVolume: requireName(names.dataVolume, "data_volume_invalid"),
  };
  const root = requireAbsolutePath(options.root, "root_invalid");
  const secretPath = requireAbsolutePath(options.secretPath, "secret_path_invalid");
  const port = requirePort(options.port);
  return {
    project,
    images: imageValues,
    versions: versionValues,
    commits: commitValues,
    names: nameValues,
    root,
    secretPath,
    port,
  };
}

function buildNodeCompose(input) {
  return {
    ...topLevel({
      project: input.project,
      network: input.names.network,
      gatewayNetwork: input.names.gatewayNetwork,
      postgresVolumeName: input.names.postgresVolume,
      dataVolumeName: input.names.dataVolume,
      secretPath: input.secretPath,
    }),
    services: {
      postgres: postgresService({
        image: input.images.postgres,
        restart: "always",
      }),
      migrate: nodeMigrateService({
        image: input.images.node,
        root: input.root,
        version: input.versions.node,
        commit: input.commits.node,
      }),
      api: nodeAPIService({
        image: input.images.node,
        root: input.root,
        version: input.versions.node,
        commit: input.commits.node,
        port: input.port,
      }),
      web: nodeWebService({
        image: input.images.nodeWeb,
        root: input.root,
        version: input.versions.node,
        commit: input.commits.node,
        port: input.port,
      }),
    },
  };
}

function buildGoCompose(input) {
  const compose = {
    ...topLevel({
      project: input.project,
      network: input.names.network,
      gatewayNetwork: input.names.gatewayNetwork,
      postgresVolumeName: input.names.postgresVolume,
      dataVolumeName: input.names.dataVolume,
      secretPath: input.secretPath,
    }),
    services: {
      postgres: postgresService({
        image: input.images.postgres,
        restart: "always",
      }),
      migrate: goMigrateService({
        image: input.images.goWorkspace,
        root: input.root,
        version: input.versions.go,
        commit: input.commits.go,
      }),
      p2p: goP2PService({
        image: input.images.goP2P,
        root: input.root,
        version: input.versions.go,
        commit: input.commits.go,
        port: input.port,
      }),
      workspace: goWorkspaceService({
        image: input.images.goWorkspace,
        root: input.root,
        version: input.versions.go,
        commit: input.commits.go,
        port: input.port,
      }),
      worker: goWorkerService({
        image: input.images.goWorkspace,
        root: input.root,
        version: input.versions.go,
        commit: input.commits.go,
        port: input.port,
      }),
      api: {
        ...nodeAPIService({
          image: input.images.node,
          root: input.root,
          version: input.versions.node,
          commit: input.commits.node,
          port: input.port,
        }),
        profiles: ["rollback"],
      },
      web: goWebService({
        image: input.images.goWeb,
        root: input.root,
        version: input.versions.go,
        commit: input.commits.go,
        port: input.port,
      }),
    },
  };
  return compose;
}

function buildReleaseFixtures(options) {
  const input = validateInputs(options);
  return {
    nodeCompose: buildNodeCompose(input),
    goCompose: buildGoCompose(input),
  };
}

export { buildReleaseFixtures };
