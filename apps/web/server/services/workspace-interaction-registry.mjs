import {
  createWorkspaceCommandRegistry,
  createWorkspaceWorkflowRegistry
} from "./workspace-command-registry.mjs";

export function createWorkspaceInteractionRegistries({ commands = [], workflows = [] } = {}) {
  return {
    commandRegistry: createWorkspaceCommandRegistry(commands),
    workflowRegistry: createWorkspaceWorkflowRegistry(workflows)
  };
}
