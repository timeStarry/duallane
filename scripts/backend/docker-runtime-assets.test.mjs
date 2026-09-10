import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspaceDockerfile = new URL("../../Dockerfile.workspace", import.meta.url);
const webDockerfile = new URL("../../deploy/candidate/Dockerfile.web", import.meta.url);

function copyDirective(from, to) {
  const escapedFrom = from.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedTo = to.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^COPY --chmod=0644 ${escapedFrom} ${escapedTo}\\r?$`, "mu");
}

test("runtime images make baked-in non-secret files readable to their service users", async () => {
  const [workspace, web] = await Promise.all([
    readFile(workspaceDockerfile, "utf8"),
    readFile(webDockerfile, "utf8"),
  ]);

  assert.match(
    workspace,
    copyDirective(
      "apps/web/server/migrations/*.sql",
      "/app/migrations/",
    ),
    "Workspace migrations must use an explicit file mode and trailing-slash destination",
  );
  assert.match(
    workspace,
    copyDirective(
      "apps/backend/internal/platform/migrations/compatibility.json",
      "/app/schema-compatibility.json",
    ),
    "the embedded schema policy must also be inspectable as a read-only image asset",
  );
  assert.match(
    workspace,
    copyDirective(
      "apps/web/shared/emote-packs.json",
      "/app/assets/emote-packs.json",
    ),
    "the emote catalog must use an explicit non-secret asset mode",
  );
  assert.match(
    workspace,
    copyDirective(
      "apps/web/shared/echo-release-guides.json",
      "/app/assets/echo-release-guides.json",
    ),
    "the Echo release catalog must use an explicit non-secret asset mode",
  );
  assert.match(
    web,
    copyDirective(
      "deploy/candidate/nginx.conf",
      "/etc/nginx/nginx.conf",
    ),
    "candidate Nginx configuration must use an explicit non-secret asset mode",
  );

  const lastAssetCopy = workspace.indexOf("COPY --chmod=0644 apps/web/shared/echo-release-guides.json");
  const directoryMode = workspace.indexOf("RUN chmod 0755 /app/migrations /app/assets");
  assert.ok(
    directoryMode > lastAssetCopy && directoryMode < workspace.indexOf("USER 65532:65532"),
    "COPY-created directories must regain traversal permission before switching to the service user",
  );

  const publicCopy = web.indexOf("COPY --from=build /app/apps/web/dist /usr/share/nginx/html");
  const publicDirectories = web.indexOf("find /usr/share/nginx/html -type d -exec chmod 0755 {} +");
  const publicFiles = web.indexOf("find /usr/share/nginx/html -type f -exec chmod 0644 {} +");
  assert.ok(
    publicCopy >= 0 && publicDirectories > publicCopy && publicFiles > publicDirectories,
    "bundled and copied public static files must be readable independently of source modes",
  );

  assert.doesNotMatch(
    workspace,
    /^COPY apps\/web\/server\/migrations \/app\/migrations$/mu,
    "a directory COPY would reintroduce source mode preservation for migrations",
  );
  assert.doesNotMatch(
    web,
    /^COPY deploy\/candidate\/nginx\.conf \/etc\/nginx\/nginx\.conf$/mu,
    "the Nginx configuration must not rely on source checkout mode bits",
  );
});
