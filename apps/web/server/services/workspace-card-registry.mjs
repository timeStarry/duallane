import {
  ECHO_REQUIREMENT_CARD_DEFINITIONS,
  ECHO_SOLICITATION_CARD_DEFINITION
} from "./echo-requirements.mjs";
import { createCardRegistry } from "./workspace-cards.mjs";
import { TOPIC_CARD_DEFINITION } from "./workspace-topics.mjs";
import { TOPIC_SYNC_CARD_DEFINITION } from "./workspace-topic-messages.mjs";

export function createWorkspaceCardRegistry(extraDefinitions = []) {
  return createCardRegistry([
    ECHO_SOLICITATION_CARD_DEFINITION,
    ...ECHO_REQUIREMENT_CARD_DEFINITIONS,
    TOPIC_CARD_DEFINITION,
    TOPIC_SYNC_CARD_DEFINITION,
    ...extraDefinitions
  ]);
}
