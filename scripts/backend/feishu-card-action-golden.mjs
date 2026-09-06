import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  convertFeishuCard,
  FEISHU_CARD_DEFINITION
} from "../../apps/web/server/services/workspace-feishu-card-converter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const casesPath = path.join(root, "apps/backend/internal/workspace/feishucards/testdata/feishu-card-cases.json");
const goldenPath = path.join(root, "apps/backend/internal/workspace/feishucards/testdata/feishu-card-action-golden.json");
const shouldWrite = process.argv.includes("--write");

export async function materializeActionGolden() {
  const cases = JSON.parse(await readFile(casesPath, "utf8"));
  const source = cases.success.find((fixture) => fixture.name === "all-elements-and-button-styles");
  if (!source) throw new Error("missing synthetic Feishu action fixture");
  const converted = convertFeishuCard(source.input);
  const action = FEISHU_CARD_DEFINITION.actions.confirm;
  const actor = { id: "actor-synthetic" };
  const card = {
    id: "card-synthetic",
    spaceId: "space-synthetic",
    conversationId: "conversation-synthetic"
  };

  const successfulDB = new ActionDB({ bot: { botId: "bot-synthetic", botUserId: "bot-user-synthetic" } });
  const successfulResult = await action.execute({
    db: successfulDB,
    actor,
    card,
    payload: converted.payload,
    clientActionId: "client-synthetic"
  });
  const successfulEvent = successfulDB.events[0];
  if (!successfulEvent) throw new Error("Node action did not write an event");

  const missingBotDB = new ActionDB({ bot: null });
  let missingBotCode = null;
  try {
    await action.execute({
      db: missingBotDB,
      actor,
      card,
      payload: converted.payload,
      clientActionId: "client-missing-bot"
    });
  } catch (error) {
    missingBotCode = error?.code ?? "unknown";
  }

  let nonEmptyInputCode = null;
  try {
    action.validateInput({ unexpected: "synthetic" });
  } catch (error) {
    nonEmptyInputCode = error?.code ?? "unknown";
  }

  return [
    {
      name: "node-confirm-action-success",
      ok: true,
      result: successfulResult.result,
      event: {
        type: successfulEvent.type,
        spaceId: successfulEvent.spaceId,
        actorId: successfulEvent.actorId,
        conversationId: successfulEvent.conversationId,
        targetType: successfulEvent.targetType,
        targetId: successfulEvent.targetId,
        payloadJSON: successfulEvent.payloadJSON
      }
    },
    {
      name: "node-action-no-active-bot",
      ok: false,
      errorCode: missingBotCode,
      eventCount: missingBotDB.events.length
    },
    {
      name: "node-action-input-rejects-content",
      ok: false,
      errorCode: nonEmptyInputCode
    }
  ];
}

class ActionDB {
  constructor({ bot }) {
    this.bot = bot;
    this.events = [];
    this.nextSeq = 7;
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    if (normalized.startsWith("SELECT b.id AS botId")) {
      return { get: async () => this.bot };
    }
    if (normalized.startsWith("INSERT INTO workspace_event_cursors")) {
      return { get: async () => ({ nextSeq: this.nextSeq++ }) };
    }
    if (normalized.startsWith("INSERT INTO workspace_events")) {
      return {
        run: async (...values) => {
          const [id, spaceId, seq, type, actorId, conversationId, targetType, targetId, payloadJSON] = values;
          this.events.push({ id, spaceId, seq, type, actorId, conversationId, targetType, targetId, payloadJSON });
        }
      };
    }
    throw new Error("unexpected synthetic Node action query");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await materializeActionGolden();
  if (shouldWrite) {
    await writeFile(goldenPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  } else {
    const expected = JSON.parse(await readFile(goldenPath, "utf8"));
    if (JSON.stringify(expected) !== JSON.stringify(output)) {
      throw new Error("Feishu action golden drift");
    }
  }
  process.stdout.write(`feishu-card-action-golden ${shouldWrite ? "written" : "verified"} ${output.length}\n`);
}
