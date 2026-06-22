export const WORKSPACE_UNDER_DEVELOPMENT_RESPONSE = {
  error: "workspace under development",
  message: "工作区功能正在开发中"
};

export function isWorkspaceEnabled(env = process.env) {
  return env.WORKSPACE_ENABLED === "true";
}

export function blockWorkspace(reply) {
  return reply.code(503).send(WORKSPACE_UNDER_DEVELOPMENT_RESPONSE);
}
