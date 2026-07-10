export const WORKSPACE_UNDER_DEVELOPMENT_RESPONSE = {
  error: {
    code: "workspace.disabled",
    message: "共享空间暂未开放"
  }
};

export function isWorkspaceEnabled(env = process.env) {
  return env.WORKSPACE_ENABLED === "true";
}

export function blockWorkspace(reply) {
  return reply.code(503).send(WORKSPACE_UNDER_DEVELOPMENT_RESPONSE);
}
