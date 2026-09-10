import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const migrationRoot = path.join(repoRoot, "apps/web/server/migrations");
const migrationNamePattern = /^[0-9]{3}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const schemaNamePattern = /^duallane_coexistence_[a-z0-9_]+$/;
const allowSchemaCreationVariable = "DUALLANE_SCHEMA_COEXISTENCE_ALLOW_SCHEMA_CREATION";
const safeErrorDefinitions = Object.freeze({
  provider: Object.freeze({
    code: "DUALLANE_SCHEMA_COEXISTENCE_PROVIDER_FAILURE",
    message: "schema coexistence provider command failed"
  }),
  migrationEvidence: Object.freeze({
    code: "DUALLANE_SCHEMA_COEXISTENCE_MIGRATION_EVIDENCE_FAILURE",
    message: "schema coexistence migration failure evidence was not accepted"
  }),
  rehearsal: Object.freeze({
    code: "DUALLANE_SCHEMA_COEXISTENCE_REHEARSAL_FAILURE",
    message: "schema coexistence rehearsal failed"
  }),
  cleanup: Object.freeze({
    code: "DUALLANE_SCHEMA_COEXISTENCE_CLEANUP_FAILURE",
    message: "schema coexistence cleanup failed"
  }),
  combined: Object.freeze({
    code: "DUALLANE_SCHEMA_COEXISTENCE_REHEARSAL_CLEANUP_FAILURE",
    message: "schema coexistence rehearsal and cleanup failed"
  })
});

function createSafeError(kind) {
  const definition = safeErrorDefinitions[kind] || safeErrorDefinitions.rehearsal;
  const error = new Error(definition.message);
  error.code = definition.code;
  return error;
}

export function toSafeSchemaCoexistenceError(error, kind = "rehearsal") {
  const knownKind = Object.keys(safeErrorDefinitions).find((key) => (
    error?.code === safeErrorDefinitions[key].code && error?.message === safeErrorDefinitions[key].message
  ));
  // Rebuild even recognized errors: a provider may attach a cause, custom
  // properties or a credential-bearing stack to an otherwise safe label.
  return createSafeError(knownKind ?? kind);
}

export function validateRehearsalEnvironment(environment = process.env) {
  if (environment[allowSchemaCreationVariable] !== "true") {
    throw new Error(`${allowSchemaCreationVariable}=true is required for disposable schema rehearsal`);
  }

  const rawURL = String(environment.TEST_DATABASE_URL ?? "").trim();
  let databaseURL;
  try {
    databaseURL = new URL(rawURL);
  } catch {
    throw new Error("TEST_DATABASE_URL must be an explicit loopback PostgreSQL URL");
  }
  const unsafeDatabase = !["postgres:", "postgresql:"].includes(databaseURL.protocol)
    || !["127.0.0.1", "[::1]"].includes(databaseURL.hostname)
    || !databaseURL.pathname
    || ["/", "/postgres", "/template0", "/template1"].includes(databaseURL.pathname)
    || [...databaseURL.searchParams.keys()].some((key) => key !== "sslmode")
    || databaseURL.hash !== "";
  if (unsafeDatabase) {
    throw new Error("TEST_DATABASE_URL must target an explicit loopback disposable database without runtime overrides");
  }
  return databaseURL;
}

export function createRehearsalSchemaName() {
  const schema = `duallane_coexistence_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!schemaNamePattern.test(schema) || schema.length > 63) {
    throw new Error("generated rehearsal schema name is invalid");
  }
  return schema;
}

export async function loadCanonicalMigrationManifest(directory = migrationRoot) {
  const names = (await readdir(directory))
    .filter((name) => migrationNamePattern.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0 || !names.some((name) => name.startsWith("029_"))
    || !names.some((name) => name.startsWith("030_"))
    || !names.some((name) => name.startsWith("031_"))
    || !names.some((name) => name.startsWith("032_"))
    || !names.some((name) => name.startsWith("033_"))) {
    throw new Error("canonical migrations 029 through 033 are required for schema rehearsal");
  }

  const files = [];
  for (const name of names) {
    const contents = await readFile(path.join(directory, name));
    files.push({
      name,
      number: Number(name.slice(0, 3)),
      sha256: createHash("sha256").update(contents).digest("hex")
    });
  }
  const manifestSha256 = createHash("sha256")
    .update(files.map((file) => `${file.name}:${file.sha256}`).join("\n"))
    .digest("hex");
  return { files, manifestSha256 };
}

export function assertMigrationFailureEvidence(outcome, expected) {
  if (!outcome || outcome.timedOut || outcome.signal || !Number.isInteger(outcome.code) || outcome.code <= 0) {
    throw createSafeError("migrationEvidence");
  }

  const providerText = `${String(outcome.stderr ?? "")}\n${String(outcome.stdout ?? "")}`;
  const migrationMatched = typeof expected?.migrationName === "string"
    && providerText.includes(expected.migrationName);
  const sqlStateMatched = typeof expected?.sqlState === "string"
    && new RegExp(`\\b${expected.sqlState}\\b`).test(providerText);
  const conflictMatched = Array.isArray(expected?.conflictTerms)
    && expected.conflictTerms.length > 0
    && expected.conflictTerms.every((term) => providerText.includes(term));
  if (!migrationMatched && !(sqlStateMatched && conflictMatched)) {
    throw createSafeError("migrationEvidence");
  }
  return Object.freeze({
    normalNonZeroExit: true,
    evidence: migrationMatched ? "migration-name" : "sqlstate-conflict"
  });
}
