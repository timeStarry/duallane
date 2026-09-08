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
