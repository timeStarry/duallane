import { createHash, randomBytes } from "node:crypto";
import { safeText } from "./channel.mjs";
import { gitSha, releaseAgentError, repositoryNames, safeCode, sha256, stableVersion } from "./config.mjs";

function validatedCandidate(candidate, repositories) {
  const summary = safeText(candidate?.summary, 600);
  if (!summary || !Array.isArray(candidate.changes) || candidate.changes.length !== repositories.length ||
      !Array.isArray(candidate.evidence) || !candidate.evidence.length || candidate.evidence.length > 12 ||
      typeof candidate.native !== "boolean") throw releaseAgentError("release_agent.candidate_invalid");
  const seen = new Set();
  const changes = candidate.changes.map(({ repo, number, base, head, tree }) => {
    if (!Object.hasOwn(repositoryNames, repo) || !repositories.includes(repo) || seen.has(repo) ||
        (number !== null && (!Number.isSafeInteger(number) || number < 1)) || ![base, head, tree].every(gitSha)) {
      throw releaseAgentError("release_agent.candidate_change");
    }
    seen.add(repo);
    return { repo, number, base, head, tree };
  }).sort((a, b) => a.repo.localeCompare(b.repo));
  const evidence = candidate.evidence.map((entry) => {
    const value = safeText(entry, 500);
    if (!value) throw releaseAgentError("release_agent.candidate_evidence");
    return value;
  });
  const goWeb = candidate.goWeb ? { version: candidate.goWeb.version } : null;
  if (goWeb && (!seen.has("main") || !stableVersion(goWeb.version))) throw releaseAgentError("release_agent.candidate_go");
  const artifact = candidate.ota;
  let ota = null;
  if (artifact) {
    if (candidate.native || !seen.has("mobile") || !stableVersion(artifact.version) || !sha256(artifact.sha256) ||
        !Number.isSafeInteger(artifact.minNativeVersionCode) || artifact.minNativeVersionCode < 1 ||
        !Array.isArray(artifact.files) || !artifact.files.length || artifact.files.length > 400) {
      throw releaseAgentError("release_agent.candidate_ota");
    }
    const files = artifact.files.map((entry) => {
      if (typeof entry.path !== "string" || entry.path.length > 240 || !/^[a-z0-9_./-]+$/iu.test(entry.path) ||
          entry.path.split("/").some((part) => part === "" || part === "." || part === "..") || !sha256(entry.sha256)) {
        throw releaseAgentError("release_agent.candidate_ota_file");
      }
      return { path: entry.path, sha256: entry.sha256 };
    }).sort((a, b) => a.path.localeCompare(b.path));
    if (new Set(files.map((file) => file.path.toLowerCase())).size !== files.length || !files.some((file) => file.path === "index.html")) {
      throw releaseAgentError("release_agent.candidate_ota_file");
    }
    ota = { version: artifact.version, minNativeVersionCode: artifact.minNativeVersionCode, sha256: artifact.sha256, files };
  }
  if (candidate.native && !seen.has("mobile")) throw releaseAgentError("release_agent.candidate_native");
  return { summary, changes, goWeb, ota, native: candidate.native, evidence };
}

export function approvalFingerprint(id, candidate, approval) {
  return createHash("sha256").update(JSON.stringify([id, candidate, approval.mode, approval.ownerUserId,
    approval.conversationId, approval.expiresAt, approval.baseline])).digest("hex");
}

function feedback(stage, text) {
  return { stage, kind: "group", text };
}

export function createReleaseCoordinator({ config, store, channel, development, production, now = Date.now }) {
  async function deliver() {
    const delivery = store.nextDelivery();
    if (!delivery) return false;
    const ticket = store.get(delivery.ticket_id);
    try {
      if (delivery.kind === "approval" && (ticket.state !== "card_pending" || ticket.approval.expiresAt <= now())) {
        throw releaseAgentError("release_agent.card_expired");
      }
      const receipt = delivery.kind === "approval" ? await channel.sendApproval(ticket, delivery.key)
        : await channel.sendGroup(ticket, delivery.text, delivery.key);
      store.deliverySucceeded(delivery, receipt);
    } catch (error) {
      const retryable = error?.retryable === true || error?.name === "TimeoutError" ||
        [408, 429, 500, 502, 503, 504].includes(error?.statusCode ?? error?.status);
      store.deliveryFailed(delivery, safeCode(error, "release_agent.delivery_failed"), retryable);
    }
    return true;
  }

  async function evaluate(ticket) {
    const claimed = store.transition(ticket, { state: "evaluating" }, { action: "evaluate", exclusive: ["evaluating", "developing"] });
    if (!claimed) return false;
    try {
      const evaluation = await development.evaluate(claimed);
      const reason = safeText(evaluation?.reason, 800);
      const { decision, repositories, estimatedMinutes, acceptance } = evaluation ?? {};
      if (!reason || !["accept", "decline", "needs_info", "duplicate"].includes(decision)) {
        throw releaseAgentError("release_agent.evaluation_invalid");
      }
      if (decision !== "accept") {
        const label = { decline: "未受理", needs_info: "待补充", duplicate: "已有工单" }[decision];
        store.transition(claimed, { state: decision, text: null, context: null },
          { action: "evaluation", delivery: feedback("evaluation", `${ticket.id} ${label}。${reason}`) });
      } else if (estimatedMinutes > config.budgetMinutes) {
        store.transition(claimed, { state: "decline", text: null, context: null, reason: "budget_exceeded" },
          { action: "evaluation", result: "budget_exceeded", delivery: feedback("evaluation", `${ticket.id} 未受理。预计工作量超过当前需求预算，请缩小范围后重新提交。`) });
      } else {
        if (!Array.isArray(repositories) || !repositories.length || repositories.length > 2 || new Set(repositories).size !== repositories.length ||
            repositories.some((repo) => !Object.hasOwn(repositoryNames, repo)) || !Number.isSafeInteger(estimatedMinutes) || estimatedMinutes < 1 ||
            !Array.isArray(acceptance) || !acceptance.length || acceptance.length > 10 || acceptance.some((step) => !safeText(step, 500))) {
          throw releaseAgentError("release_agent.evaluation_invalid");
        }
        store.transition(claimed, { state: "accepted", evaluation: { decision, reason, repositories, estimatedMinutes, acceptance } },
          { action: "evaluation", delivery: feedback("evaluation", `${ticket.id} 已受理，进入研发。${reason}`) });
      }
    } catch (error) {
      store.transition(claimed, { state: "blocked", text: null, context: null, reason: safeCode(error, "release_agent.evaluation_failed") },
        { action: "evaluation", delivery: feedback("evaluation", `${ticket.id} 暂停评估，等待维护者排查。`) });
    }
    return true;
  }

  async function develop(ticket) {
    const claimed = store.transition(ticket, { state: "developing" }, { action: "develop", exclusive: ["evaluating", "developing"] });
    if (!claimed) return false;
    try {
      const options = {};
      if (!config.ota && claimed.evaluation.repositories.includes("mobile")) {
        const base = await production.captureBaseline({ ota: true });
        const [major, minor, patch] = base.ota.version.split(".").map(Number);
        options.ota = { version: `${major}.${minor}.${patch + 1}`, minNativeVersionCode: base.ota.minNativeVersionCode };
      }
      const candidate = validatedCandidate(await development.develop(claimed, claimed.evaluation, options), claimed.evaluation.repositories);
      if (config.mode === "production" && !candidate.native && candidate.changes.some((change) => change.number === null)) {
        throw releaseAgentError("release_agent.pr_required");
      }
      const approval = { mode: config.mode, ownerUserId: config.channel.ownerUserId, conversationId: config.channel.ownerConversationId,
        expiresAt: now() + config.approvalMinutes * 60_000, nonce: randomBytes(24).toString("hex"),
        baseline: config.mode === "production" ? await production.captureBaseline(candidate) : null };
      approval.fingerprint = approvalFingerprint(ticket.id, candidate, approval);
      store.transition(claimed, { state: "card_pending", text: null, context: null, evaluation: null, candidate, approval },
        { action: "develop", delivery: { stage: "approval", kind: "approval" } });
    } catch (error) {
      store.transition(claimed, { state: "blocked", text: null, context: null, evaluation: null, reason: safeCode(error, "release_agent.development_failed") },
        { action: "develop", delivery: feedback("development", `${ticket.id} 的候选未通过研发或验收门禁，等待维护者处理。`) });
    }
    return true;
  }

  async function release(ticket) {
    const { candidate, approval } = ticket;
    if (config.mode !== "production" || approval.mode !== "production") return false;
    function expire(current) {
      store.transition(current, { state: "expired", reason: "approval_stale" }, { action: "release_preflight" });
      return true;
    }
    if (approval.expiresAt <= now() || approval.ownerUserId !== config.channel.ownerUserId ||
        approval.conversationId !== config.channel.ownerConversationId || ticket.actionReceipt?.actor !== approval.ownerUserId ||
        approval.fingerprint !== approvalFingerprint(ticket.id, candidate, approval)) {
      return expire(ticket);
    }
    if (candidate.native) {
      store.transition(ticket, { state: "manual_native" }, { action: "release_preflight",
        delivery: feedback("release", `${ticket.id} 的原生候选已通过验收，等待维护者审查合入并发布签名安装包。`) });
      return true;
    }
    let inspection;
    try {
      inspection = await production.inspect(candidate);
    } catch {
      return false;
    }
    if (approval.expiresAt <= now()) return expire(ticket);
    if (!inspection?.ready) {
      if (["merge_pending", "ci_pending"].includes(inspection?.reason)) return false;
      store.transition(ticket, { state: "blocked", reason: safeCode({ code: inspection?.reason }, "release_agent.release_preflight") }, { action: "release_preflight",
        delivery: feedback("release", `${ticket.id} 的候选已暂停发布，等待重新核对提交或检查结果。`) });
      return true;
    }
    let claimed = store.transition(ticket, { state: "releasing", phases: [] },
      { action: "release", exclusive: ["releasing", "release_attention"] });
    if (!claimed) return false;
    let expiredBeforeWrite = false;
    const onPhase = ({ phase, state, receipt, reason }) => {
      if (!["go-web", "ota"].includes(phase) || !["started", "succeeded", "failed", "uncertain"].includes(state)) {
        throw releaseAgentError("release_agent.release_phase");
      }
      if (state === "started" && claimed.phases.length === 0 && approval.expiresAt <= now()) {
        expiredBeforeWrite = true;
        throw releaseAgentError("release_agent.approval_expired");
      }
      const saved = store.transition(claimed, { phases: [...claimed.phases, { phase, state, receipt, reason }] },
        { action: "release_phase", result: state });
      if (!saved) throw releaseAgentError("release_agent.release_state_changed");
      claimed = saved;
    };
    try {
      const outcome = await production.release(candidate, { baseline: approval.baseline, onPhase });
      if (expiredBeforeWrite) return expire(claimed);
      if (outcome?.status !== "succeeded") {
        const uncertain = outcome?.status !== "blocked";
        const completed = claimed.phases.filter((phase) => phase.state === "succeeded").length;
        store.transition(claimed, { state: uncertain ? "release_attention" : "blocked",
          reason: safeCode({ code: outcome?.reason }, "release_agent.release_failed") }, { action: "release",
          delivery: feedback("release", `${ticket.id} 发布暂停${completed ? `，已核验 ${completed} 个发布步骤` : ""}，等待维护者核对线上状态。`) });
        return true;
      }
      const versions = [candidate.goWeb && `Go/Web ${candidate.goWeb.version}`, candidate.ota && `Android OTA ${candidate.ota.version}`].filter(Boolean);
      store.transition(claimed, { state: "completed" }, { action: "release", delivery: feedback("release", versions.length
        ? `${ticket.id} 已发布并通过在线探测。${versions.join("，")}。` : `${ticket.id} 已合入并通过检查。`) });
    } catch (error) {
      if (expiredBeforeWrite) return expire(claimed);
      store.transition(claimed, { state: "release_attention", reason: safeCode(error, "release_agent.release_failed") },
        { action: "release", delivery: feedback("release", `${ticket.id} 发布状态待核对，已暂停后续发布。`) });
    }
    return true;
  }

  return {
    async tick() {
      if (await deliver()) return true;
      const ticket = store.observe(["accepted", "queued"]);
      if (!ticket) return false;
      return ticket.state === "accepted" ? develop(ticket) : evaluate(ticket);
    },
    async releaseTick() {
      for (const ticket of store.listByState("approved")) {
        if (await release(ticket)) return true;
      }
      return false;
    },
    deliver,
  };
}
