import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionWorkspaceS3Bucket } from "./workspace-s3-provision.mjs";

describe("workspace S3 provisioning", () => {
  const directories = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("enables versioning, restricted CORS, and multipart cleanup", async () => {
    const env = await makeEnv();
    const observed = [];
    let corsRules = [];
    let lifecycleRules = [];
    let versioning = {};
    const client = {
      async send(command) {
        observed.push(command.constructor.name);
        if (command.constructor.name === "GetBucketPolicyCommand") {
          const error = new Error("none");
          error.name = "NoSuchBucketPolicy";
          error.$metadata = { httpStatusCode: 404 };
          throw error;
        }
        if (command.constructor.name === "PutBucketCorsCommand") corsRules = command.input.CORSConfiguration.CORSRules;
        if (command.constructor.name === "PutBucketLifecycleConfigurationCommand") lifecycleRules = command.input.LifecycleConfiguration.Rules;
        if (command.constructor.name === "PutBucketVersioningCommand") versioning = command.input.VersioningConfiguration;
        if (command.constructor.name === "GetBucketCorsCommand") return { CORSRules: corsRules };
        if (command.constructor.name === "GetBucketLifecycleConfigurationCommand") return { Rules: lifecycleRules };
        if (command.constructor.name === "GetBucketVersioningCommand") return versioning;
        return {};
      }
    };

    await expect(provisionWorkspaceS3Bucket({ env, client })).resolves.toMatchObject({
      bucket: "duallane",
      versioning: "Enabled",
      corsOrigin: "https://duallane.tsio.top",
      corsMode: "bucket",
      multipartCleanupMode: "bucket",
      multipartAbortDays: 7
    });
    expect(observed).toEqual(expect.arrayContaining([
      "PutBucketVersioningCommand",
      "PutBucketCorsCommand",
      "PutBucketLifecycleConfigurationCommand"
    ]));
    expect(lifecycleRules[0]).toMatchObject({ Prefix: "", AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } });
  });

  it("verifies application cleanup access when MinIO rejects multipart lifecycle rules", async () => {
    const env = await makeEnv();
    let versioning = {};
    let canaryUploadId = null;
    const observed = [];
    const client = {
      async send(command) {
        const name = command.constructor.name;
        observed.push(name);
        if (name === "GetBucketPolicyCommand") {
          const error = new Error("none");
          error.name = "NoSuchBucketPolicy";
          error.$metadata = { httpStatusCode: 404 };
          throw error;
        }
        if (name === "PutBucketCorsCommand") {
          const error = new Error("unsupported");
          error.name = "NotImplemented";
          throw error;
        }
        if (name === "PutBucketLifecycleConfigurationCommand") {
          const error = new Error("unsupported rule");
          error.name = "InvalidArgument";
          throw error;
        }
        if (name === "PutBucketVersioningCommand") versioning = command.input.VersioningConfiguration;
        if (name === "GetBucketVersioningCommand") return versioning;
        if (name === "CreateMultipartUploadCommand") {
          canaryUploadId = "canary-upload";
          return { UploadId: canaryUploadId };
        }
        if (name === "ListMultipartUploadsCommand") return { Uploads: [], IsTruncated: false };
        if (name === "AbortMultipartUploadCommand") {
          expect(command.input.UploadId).toBe(canaryUploadId);
          return {};
        }
        return {};
      }
    };
    await expect(provisionWorkspaceS3Bucket({ env, client })).resolves.toMatchObject({
      corsMode: "gateway",
      multipartCleanupMode: "application",
      multipartAbortDays: 7
    });
    expect(observed).toEqual(expect.arrayContaining([
      "CreateMultipartUploadCommand",
      "ListMultipartUploadsCommand",
      "AbortMultipartUploadCommand"
    ]));
  });

  it("uses the restricted gateway CORS path when MinIO lacks bucket CORS APIs", async () => {
    const env = await makeEnv();
    let lifecycleRules = [];
    let versioning = {};
    const client = {
      async send(command) {
        const name = command.constructor.name;
        if (name === "GetBucketPolicyCommand") {
          const error = new Error("none");
          error.name = "NoSuchBucketPolicy";
          error.$metadata = { httpStatusCode: 404 };
          throw error;
        }
        if (name === "PutBucketCorsCommand") {
          const error = new Error("unsupported");
          error.name = "NotImplemented";
          error.$metadata = { httpStatusCode: 501 };
          throw error;
        }
        if (name === "PutBucketLifecycleConfigurationCommand") lifecycleRules = command.input.LifecycleConfiguration.Rules;
        if (name === "PutBucketVersioningCommand") versioning = command.input.VersioningConfiguration;
        if (name === "GetBucketLifecycleConfigurationCommand") return { Rules: lifecycleRules };
        if (name === "GetBucketVersioningCommand") return versioning;
        return {};
      }
    };

    await expect(provisionWorkspaceS3Bucket({ env, client })).resolves.toMatchObject({
      corsMode: "gateway",
      versioning: "Enabled",
      multipartAbortDays: 7
    });
  });

  it("refuses a bucket policy with an anonymous principal", async () => {
    const env = await makeEnv();
    const client = {
      async send(command) {
        if (command.constructor.name === "GetBucketPolicyCommand") {
          return { Policy: JSON.stringify({ Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject" }] }) };
        }
        return {};
      }
    };
    await expect(provisionWorkspaceS3Bucket({ env, client })).rejects.toMatchObject({ code: "storage.public_policy" });
  });

  async function makeEnv() {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-s3-provision-"));
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
});
