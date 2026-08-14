import { ECHO_REQUIREMENT_CARD_DEFINITIONS } from "./echo-requirements.mjs";
import { createCardRegistry } from "./workspace-cards.mjs";
import { TOPIC_CARD_DEFINITION } from "./workspace-topics.mjs";

export function createWorkspaceCardRegistry(extraDefinitions = []) {
  return createCardRegistry([
    ...ECHO_REQUIREMENT_CARD_DEFINITIONS,
    TOPIC_CARD_DEFINITION,
    ...extraDefinitions
  ]);
}
