import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const collect = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = resolve(directory, entry.name);
  return entry.isDirectory() ? collect(path) : entry.name.endsWith(".md") ? [path] : [];
});
const files = [...new Set([
  ...["docs/design/ui-ux-rewrite", "apps/web/src/ui", "apps/web/src/features"].flatMap((path) => collect(resolve(root, path))),
  ...["AGENTS.md", "README.md", "DESIGN.md", "docs/development/README.md", "docs/development/UI_UX_STANDARDS.md", "docs/WORKSPACE_DESIGN_INDEX.md", "docs/WORKSPACE_GROUP_TOPIC_DESIGN.md"].map((path) => resolve(root, path))
])];
const withoutFences = (text) => text.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, "");
const anchors = (path) => {
  const source = withoutFences(readFileSync(path, "utf8"));
  const counts = new Map();
  const result = new Set([...source.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = match[1].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").trim().toLowerCase().replace(/\s/g, "-");
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  return result;
};
const failures = [];
let checked = 0;
for (const file of files) {
  const source = withoutFences(readFileSync(file, "utf8")).replace(/`[^`]*`/g, "");
  const definitions = new Map([...source.matchAll(/^\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gm)].map((match) => [match[1].toLowerCase(), match[2]]));
  const targets = [...source.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)].map((match) => match[1]);
  for (const match of source.matchAll(/\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const key = (match[2] || match[1]).toLowerCase();
    if (definitions.has(key)) targets.push(definitions.get(key));
    else failures.push(`${relative(root, file)}: undefined reference [${key}]`);
  }
  for (const target of targets) {
    const clean = target.trim().replace(/^<|>$/g, "");
    if (/^[a-z][a-z\d+.-]*:/i.test(clean) || clean.startsWith("/")) continue;
    const [local, fragment] = clean.split("#");
    const resolved = local ? resolve(dirname(file), decodeURIComponent(local)) : file;
    checked++;
    if (!existsSync(resolved)) failures.push(`${relative(root, file)}: missing ${clean}`);
    else if (fragment && extname(resolved) === ".md" && !anchors(resolved).has(decodeURIComponent(fragment))) failures.push(`${relative(root, file)}: missing anchor ${clean}`);
  }
}
assert.deepEqual(failures, [], failures.join("\n"));
console.log(`${checked} local links and Markdown anchors valid across ${files.length} specification and implementation documents.`);
