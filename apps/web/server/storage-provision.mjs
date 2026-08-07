import { provisionWorkspaceS3Bucket } from "./services/workspace-s3-provision.mjs";

const result = await provisionWorkspaceS3Bucket({ env: process.env });
process.stdout.write(
  `Workspace S3 bucket ready: bucket=${result.bucket} versioning=${result.versioning} multipartAbortDays=${result.multipartAbortDays}\n`
);
