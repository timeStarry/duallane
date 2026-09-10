import { provisionWorkspaceS3Bucket } from "../lib/s3-provision.mjs";

export async function runStorageProvision({ env = process.env, stdout = process.stdout } = {}) {
  const result = await provisionWorkspaceS3Bucket({ env });
  stdout.write(
    `Workspace S3 bucket ready: bucket=${result.bucket} versioning=${result.versioning} ` +
    `cors=${result.corsMode} multipartCleanup=${result.multipartCleanupMode} ` +
    `multipartAbortDays=${result.multipartAbortDays}\n`
  );
  return result;
}
