import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStorageMigrate } from "./commands/storage-migrate.mjs";

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await runStorageMigrate();
}
