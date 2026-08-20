import {
  ECHO_REQUIREMENT_CARD_DEFINITIONS,
  ECHO_SOLICITATION_CARD_DEFINITION
} from "./echo-requirements.mjs";
import { ECHO_RELEASE_CARD_DEFINITION } from "./echo-releases.mjs";
import { createCardRegistry } from "./workspace-cards.mjs";
import { FEISHU_CARD_DEFINITION } from "./workspace-feishu-card-converter.mjs";
import { TOPIC_CARD_DEFINITION } from "./workspace-topics.mjs";
import { TOPIC_SYNC_CARD_DEFINITION } from "./workspace-topic-messages.mjs";

export function createWorkspaceCardRegistry(extraDefinitions = []) {
  return createCardRegistry([
    ECHO_SOLICITATION_CARD_DEFINITION,
    ...ECHO_REQUIREMENT_CARD_DEFINITIONS,
    ECHO_RELEASE_CARD_DEFINITION,
    TOPIC_CARD_DEFINITION,
    TOPIC_SYNC_CARD_DEFINITION,
    FEISHU_CARD_DEFINITION,
    ...extraDefinitions
  ]);
}
