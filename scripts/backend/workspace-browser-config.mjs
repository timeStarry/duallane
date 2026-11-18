import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Load the real configuration in a separate process so optional sibling-mobile
// coverage cannot leak into the default CI contract through the caller's env.
// Importing the config does not launch browsers, services or database work.
export function readWorkspaceBrowserConfig(mobileRoot) {
  const env = { ...process.env };
  delete env.DUALLANE_MOBILE_E2E_ROOT;
  if (mobileRoot) env.DUALLANE_MOBILE_E2E_ROOT = mobileRoot;
  const output = execFileSync(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e",
    "const {default:config}=await import(process.argv[1]); console.log(JSON.stringify(config));",
    new URL("../../playwright.workspace-go.config.ts", import.meta.url).href,
  ], { cwd: fileURLToPath(new URL("../../", import.meta.url)), env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(output);
}
