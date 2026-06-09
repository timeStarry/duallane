export function writeAudit(db, event) {
  const now = new Date().toISOString();
  const audit = {
    id: event.id ?? crypto.randomUUID(),
    actorUserId: event.actorUserId ?? null,
    actorGithubLogin: event.actorGithubLogin ?? null,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    result: event.result,
    reason: event.reason ?? null,
    ipAddress: event.ipAddress ?? null,
    userAgent: event.userAgent ?? null,
    requestId: event.requestId ?? null,
    createdAt: event.createdAt ?? now
  };

  db.prepare(`
    INSERT INTO audit_logs (
      id, actor_user_id, actor_github_login, action, target_type, target_id,
      result, reason, ip_address, user_agent, request_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    audit.id,
    audit.actorUserId,
    audit.actorGithubLogin,
    audit.action,
    audit.targetType,
    audit.targetId,
    audit.result,
    audit.reason,
    audit.ipAddress,
    audit.userAgent,
    audit.requestId,
    audit.createdAt
  );

  return audit;
}
