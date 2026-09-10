import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { provisionWorkspaceS3Bucket } from "../lib/s3-provision.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("S3 provisioning enables versioning, restricted CORS, and bucket multipart cleanup", async () => {
  const env = await makeEnv();
  const observed = [];
  let corsRules = [];
  let lifecycleRules = [];
  let versioning = {};
  const client = {
    async send(command) {
      const name = command.constructor.name;
      observed.push(name);
      if (name === "GetBucketPolicyCommand") throw noBucketPolicy();
      if (name === "PutBucketCorsCommand") corsRules = command.input.CORSConfiguration.CORSRules;
      if (name === "PutBucketLifecycleConfigurationCommand") {
        lifecycleRules = command.input.LifecycleConfiguration.Rules;
      }
      if (name === "PutBucketVersioningCommand") versioning = command.input.VersioningConfiguration;
      if (name === "GetBucketCorsCommand") return { CORSRules: corsRules };
      if (name === "GetBucketLifecycleConfigurationCommand") return { Rules: lifecycleRules };
      if (name === "GetBucketVersioningCommand") return versioning;
      return {};
    }
  };

  const result = await provisionWorkspaceS3Bucket({ env, client });
  assert.deepEqual(result, {
    bucket: "duallane",
    versioning: "Enabled",
    corsOrigin: "https://duallane.tsio.top",
    corsMode: "bucket",
    multipartCleanupMode: "bucket",
    multipartAbortDays: 7
  });
  assert.ok(observed.includes("PutBucketVersioningCommand"));
  assert.ok(observed.includes("PutBucketCorsCommand"));
  assert.ok(observed.includes("PutBucketLifecycleConfigurationCommand"));
  assert.equal(observed.filter((name) => name === "GetBucketPolicyCommand").length, 2);
  assert.deepEqual(corsRules[0], {
    AllowedOrigins: ["https://duallane.tsio.top"],
    AllowedMethods: ["GET", "HEAD"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
    MaxAgeSeconds: 300
  });
  assert.deepEqual(lifecycleRules[0], {
    ID: "abort-incomplete-multipart-after-7-days",
    Status: "Enabled",
    Prefix: "",
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }
  });
  assert.deepEqual(versioning, { Status: "Enabled" });
});

test("S3 provisioning uses gateway CORS and canary cleanup when bucket APIs reject them", async () => {
  const env = await makeEnv();
  const observed = [];
  let versioning = {};
  let canaryUploadId;
  const client = {
    async send(command) {
      const name = command.constructor.name;
      observed.push(name);
      if (name === "GetBucketPolicyCommand") throw noBucketPolicy();
      if (name === "PutBucketCorsCommand") throw providerError("NotImplemented");
      if (name === "PutBucketLifecycleConfigurationCommand") throw providerError("InvalidArgument");
      if (name === "PutBucketVersioningCommand") versioning = command.input.VersioningConfiguration;
      if (name === "GetBucketVersioningCommand") return versioning;
      if (name === "CreateMultipartUploadCommand") {
        canaryUploadId = "canary-upload";
        assert.equal(command.input.ContentType, "application/octet-stream");
        assert.equal(command.input.Metadata["duallane-kind"], "multipart-cleanup-canary");
        return { UploadId: canaryUploadId };
      }
      if (name === "ListMultipartUploadsCommand") {
        assert.equal(command.input.Prefix, "workspace/");
        assert.equal(command.input.MaxUploads, 1);
        return { Uploads: [], IsTruncated: false };
      }
      if (name === "AbortMultipartUploadCommand") {
        assert.equal(command.input.UploadId, canaryUploadId);
        return {};
      }
      return {};
    }
  };

  const result = await provisionWorkspaceS3Bucket({ env, client });
  assert.deepEqual(result, {
    bucket: "duallane",
    versioning: "Enabled",
    corsOrigin: "https://duallane.tsio.top",
    corsMode: "gateway",
    multipartCleanupMode: "application",
    multipartAbortDays: 7
  });
  assert.ok(observed.includes("CreateMultipartUploadCommand"));
  assert.ok(observed.includes("ListMultipartUploadsCommand"));
  assert.ok(observed.includes("AbortMultipartUploadCommand"));
});

test("S3 provisioning keeps bucket lifecycle when only bucket CORS is unsupported", async () => {
  const env = await makeEnv();
  let lifecycleRules = [];
  let versioning = {};
  const client = {
    async send(command) {
      const name = command.constructor.name;
      if (name === "GetBucketPolicyCommand") throw noBucketPolicy();
      if (name === "PutBucketCorsCommand") throw providerError("NotImplemented");
      if (name === "PutBucketLifecycleConfigurationCommand") {
        lifecycleRules = command.input.LifecycleConfiguration.Rules;
      }
      if (name === "PutBucketVersioningCommand") versioning = command.input.VersioningConfiguration;
      if (name === "GetBucketVersioningCommand") return versioning;
      if (name === "GetBucketLifecycleConfigurationCommand") return { Rules: lifecycleRules };
      return {};
    }
  };

  const result = await provisionWorkspaceS3Bucket({ env, client });
  assert.equal(result.corsMode, "gateway");
  assert.equal(result.multipartCleanupMode, "bucket");
  assert.equal(lifecycleRules[0].AbortIncompleteMultipartUpload.DaysAfterInitiation, 7);
});

test("S3 provisioning refuses an anonymous policy before any bucket mutation", async () => {
  const env = await makeEnv();
  const observed = [];
  const client = {
    async send(command) {
      const name = command.constructor.name;
      observed.push(name);
      if (name === "GetBucketPolicyCommand") {
        return { Policy: JSON.stringify({
          Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject" }]
        }) };
      }
      return {};
    }
  };

  await assert.rejects(
    provisionWorkspaceS3Bucket({ env, client }),
    (error) => error.code === "storage.public_policy"
  );
  assert.deepEqual(observed, ["HeadBucketCommand", "GetBucketPolicyCommand"]);
});

test("S3 provisioning treats Allow.NotPrincipal as unproven anonymous access", async () => {
  const env = await makeEnv();
  const observed = [];
  const client = {
    async send(command) {
      const name = command.constructor.name;
      observed.push(name);
      if (name === "GetBucketPolicyCommand") {
        return { Policy: JSON.stringify({
          Statement: [{
            Effect: "Allow",
            NotPrincipal: { AWS: "arn:aws:iam::123456789012:role/WorkspaceOnly" },
            Action: "s3:GetObject"
          }]
        }) };
      }
      return {};
    }
  };

  await assert.rejects(
    provisionWorkspaceS3Bucket({ env, client }),
    (error) => error.code === "storage.public_policy"
  );
  assert.deepEqual(observed, ["HeadBucketCommand", "GetBucketPolicyCommand"]);
  assert.equal(observed.some((name) => name.startsWith("Put") || name.startsWith("Create") || name.startsWith("Abort")), false);
});

async function makeEnv() {
  const directory = await mkdtemp(path.join(tmpdir(), "duallane-node-compat-s3-provision-"));
  directories.push(directory);
  const credentialsPath = path.join(directory, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ accessKey: "test-access", secretKey: "test-secret" }));
  return {
    PUBLIC_BASE_URL: "https://duallane.tsio.top",
    WORKSPACE_S3_ENDPOINT: "http://100.99.0.4:9000",
    WORKSPACE_S3_PUBLIC_ENDPOINT: "https://fs.tsio.top",
    WORKSPACE_S3_BUCKET: "duallane",
    WORKSPACE_S3_REGION: "us-east-1",
    WORKSPACE_S3_CREDENTIALS_FILE: credentialsPath
  };
}

function noBucketPolicy() {
  const error = new Error("none");
  error.name = "NoSuchBucketPolicy";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

function providerError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}
