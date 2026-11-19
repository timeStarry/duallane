import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9_:-]{1,128}$/u.test(value);
export const stableVersion = (value) => typeof value === "string" && /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/u.test(value);
export const sha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const gitSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
export const repositoryNames = Object.freeze({ main: "timeStarry/duallane", mobile: "timeStarry/duallane-mobile" });

export function releaseAgentError(code, options = {}) {
  return Object.assign(new Error(code), { code, ...options });
}

export function safeCode(error, fallback) {
  const code = error?.code;
  return typeof code === "string" && /^[a-z][a-z0-9_.]{1,63}$/u.test(code) ? code : fallback;
}

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

export function loadReleaseAgentConfig(file) {
  if (typeof file !== "string" || !isAbsolute(file)) throw releaseAgentError("release_agent.config_path");
  const config = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
  const channel = config?.channel;
  if (!channel || !httpsOrigin(channel.origin) || !/^[a-zA-Z0-9_-]{1,50}$/u.test(channel.profile || "") ||
      ![channel.spaceId, channel.botId, channel.ownerUserId, channel.ownerConversationId, channel.groupConversationId].every(identifier) ||
      channel.ownerConversationId === channel.groupConversationId) throw releaseAgentError("release_agent.channel_config");
  if (!["pilot", "production"].includes(config.mode) || ![config.stateDirectory, config.workDirectory, config.artifactDirectory].every(
    (directory) => typeof directory === "string" && isAbsolute(directory))) throw releaseAgentError("release_agent.config");
  const directories = [config.stateDirectory, config.workDirectory, config.artifactDirectory].map((directory) => resolve(directory));
  if (new Set(directories).size !== directories.length) throw releaseAgentError("release_agent.directories");
  const maxDailyTickets = config.maxDailyTickets ?? 8;
  const approvalMinutes = config.approvalMinutes ?? 24 * 60;
  const budgetMinutes = config.budgetMinutes ?? 90;
  if (!Number.isSafeInteger(maxDailyTickets) || maxDailyTickets < 1 || maxDailyTickets > 100 ||
      !Number.isSafeInteger(approvalMinutes) || approvalMinutes < 1 || approvalMinutes > 48 * 60 ||
      !Number.isSafeInteger(budgetMinutes) || budgetMinutes < 1 || budgetMinutes > 240) {
    throw releaseAgentError("release_agent.config_limits");
  }
  if (config.production && config.production.origin !== channel.origin) throw releaseAgentError("release_agent.production_origin");
  return { ...config, maxDailyTickets, approvalMinutes, budgetMinutes, maintainerLogin: "timestarry" };
}
