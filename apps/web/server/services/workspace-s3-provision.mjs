import {
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { loadWorkspaceS3Config } from "./workspace-object-store.mjs";
import { verifyWorkspaceMultipartCleanupAccess } from "./workspace-object-store.mjs";

const MULTIPART_ABORT_DAYS = 7;

export async function provisionWorkspaceS3Bucket({ env = process.env, client } = {}) {
  const config = await loadWorkspaceS3Config(env);
  const appOrigin = normalizeAppOrigin(env.PUBLIC_BASE_URL || "https://duallane.tsio.top");
  const s3 = client ?? new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey
    }
  });
  let stage = "head_bucket";
  let corsMode = "bucket";
  let multipartCleanupMode = "bucket";

  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.bucket }));
    stage = "private_policy";
    await assertBucketHasNoPublicPolicy(s3, config.bucket);
    stage = "versioning";
    await s3.send(new PutBucketVersioningCommand({
      Bucket: config.bucket,
      VersioningConfiguration: { Status: "Enabled" }
    }));
    stage = "cors";
    try {
      await s3.send(new PutBucketCorsCommand({
        Bucket: config.bucket,
        CORSConfiguration: {
          CORSRules: [{
            AllowedOrigins: [appOrigin],
            AllowedMethods: ["GET", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
            MaxAgeSeconds: 300
          }]
        }
      }));
    } catch (error) {
      if (!isNotImplementedError(error)) throw error;
      corsMode = "gateway";
    }
    stage = "multipart_lifecycle";
    try {
      await s3.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: config.bucket,
        LifecycleConfiguration: {
          Rules: [{
            ID: "abort-incomplete-multipart-after-7-days",
            Status: "Enabled",
            Prefix: "",
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: MULTIPART_ABORT_DAYS }
          }]
        }
      }));
    } catch (error) {
      if (!isLifecycleUnsupportedError(error)) throw error;
      multipartCleanupMode = "application";
    }

    stage = "verify_versioning";
    const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: config.bucket }));
    if (versioning.Status !== "Enabled") throw new Error("Workspace S3 versioning is not enabled");
    if (corsMode === "bucket") {
      stage = "verify_cors";
      const cors = await s3.send(new GetBucketCorsCommand({ Bucket: config.bucket }));
      const corsRule = cors.CORSRules?.find((rule) => rule.AllowedOrigins?.includes(appOrigin));
      if (!corsRule || !corsRule.AllowedMethods?.includes("GET") || !corsRule.AllowedMethods?.includes("HEAD")) {
        throw new Error("Workspace S3 CORS verification failed");
      }
    }
    if (multipartCleanupMode === "bucket") {
      stage = "verify_multipart_lifecycle";
      const lifecycle = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: config.bucket }));
      const lifecycleRule = lifecycle.Rules?.find((rule) => rule.ID === "abort-incomplete-multipart-after-7-days");
      if (lifecycleRule?.AbortIncompleteMultipartUpload?.DaysAfterInitiation !== MULTIPART_ABORT_DAYS) {
        throw new Error("Workspace S3 multipart lifecycle verification failed");
      }
    } else {
      stage = "verify_application_multipart_cleanup";
      await verifyWorkspaceMultipartCleanupAccess({ client: s3, bucket: config.bucket });
    }
    stage = "verify_private_policy";
    await assertBucketHasNoPublicPolicy(s3, config.bucket);
    return {
      bucket: config.bucket,
      versioning: "Enabled",
      corsOrigin: appOrigin,
      corsMode,
      multipartCleanupMode,
      multipartAbortDays: MULTIPART_ABORT_DAYS
    };
  } catch (error) {
    if (error?.code?.startsWith?.("storage.")) throw error;
    const wrapped = new Error(`Workspace S3 provisioning failed at ${stage}: ${safeProviderCode(error)}`);
    wrapped.code = "storage.provision_failed";
    throw wrapped;
  } finally {
    if (!client) s3.destroy?.();
  }
}

async function assertBucketHasNoPublicPolicy(client, bucket) {
  let response;
  try {
    response = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
  } catch (error) {
    if (["NoSuchBucketPolicy", "NoSuchPolicy"].includes(error?.name) || error?.$metadata?.httpStatusCode === 404) return;
    throw error;
  }
  let policy;
  try {
    policy = JSON.parse(response.Policy || "{}");
  } catch {
    throw storagePolicyError("Workspace S3 bucket policy is invalid");
  }
  const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement].filter(Boolean);
  if (statements.some((statement) => statement?.Effect === "Allow" && isPublicPrincipal(statement.Principal))) {
    throw storagePolicyError("Workspace S3 bucket must not allow anonymous access");
  }
}

function isPublicPrincipal(principal) {
  if (principal === "*") return true;
  if (!principal || typeof principal !== "object") return false;
  return Object.values(principal).flat().includes("*");
}

function isNotImplementedError(error) {
  return error?.name === "NotImplemented" || error?.$metadata?.httpStatusCode === 501;
}

function isLifecycleUnsupportedError(error) {
  return isNotImplementedError(error) || error?.name === "InvalidArgument";
}

function normalizeAppOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid HTTPS origin for S3 CORS");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_BASE_URL must be a valid HTTPS origin for S3 CORS");
  }
  return parsed.origin;
}

function storagePolicyError(message) {
  const error = new Error(message);
  error.code = "storage.public_policy";
  return error;
}

function safeProviderCode(error) {
  if (typeof error?.code === "string" && /^storage\.[a-z_]+$/.test(error.code)) return error.code;
  const code = String(error?.name || "storage_error");
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : "storage_error";
}
