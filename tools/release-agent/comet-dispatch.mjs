import { existsSync } from "node:fs";
import { handleReleaseBridge, isReleaseBridgeIntent } from "./bridge.mjs";
import { createCometChannel } from "./channel.mjs";
import { loadReleaseAgentConfig } from "./config.mjs";
import { openReleaseStore } from "./store.mjs";

// Called inside the existing credential-stripping Comet bridge, before any
// prompt is built. The installer supplies a private, operator-owned file path.
export async function dispatchReleaseAgent(request, configPath) {
  if (!isReleaseBridgeIntent(request) || !existsSync(configPath)) return null;
  try {
    const config = loadReleaseAgentConfig(configPath);
    const conversationId = request.event.conversationId;
    if (![config.channel.groupConversationId, config.channel.ownerConversationId].includes(conversationId)) return null;
    const store = openReleaseStore(config.stateDirectory);
    try {
      return await handleReleaseBridge(request, { config, store,
        authorizeOwner: () => createCometChannel({ config }).authorizeOwner() });
    } finally {
      store.close();
    }
  } catch {
    return { status: "completed", text: "需求与发布流程暂不可用，请稍后再试。" };
  }
}
