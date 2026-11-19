import { setTimeout as wait } from "node:timers/promises";
import { createCometChannel } from "./channel.mjs";
import { loadReleaseAgentConfig, releaseAgentError, safeCode } from "./config.mjs";
import { createReleaseCoordinator } from "./coordinator.mjs";
import { openReleaseStore } from "./store.mjs";

const [command, configPath, ...args] = process.argv.slice(2);

async function main() {
  const config = loadReleaseAgentConfig(configPath);
  if (command === "check") {
    await createCometChannel({ config }).check();
    console.log(JSON.stringify({ status: "ok", comet: "authorized", mode: config.mode }));
    return;
  }
  if (command === "notify") {
    if (args.length !== 2) throw releaseAgentError("release_agent.usage");
    console.log(JSON.stringify(await createCometChannel({ config }).notifyOwner(args[1], args[0])));
    return;
  }

  const store = openReleaseStore(config.stateDirectory);
  try {
    if (command === "status") {
      const rows = store.list().map(({ id, state, revision, reason, phases }) => (
        { id, state, revision, reason, phases: phases?.length }));
      console.log(JSON.stringify(rows));
      return;
    }
    if (command === "audit" && args.length === 1) {
      console.log(JSON.stringify(store.listAudit(args[0])));
      return;
    }
    if (command === "acknowledge-interruption" && args.length === 2) {
      const ticket = store.get(args[0]);
      if (!ticket || String(ticket.revision) !== args[1] ||
          !["evaluating", "developing", "releasing", "release_attention"].includes(ticket.state)) {
        throw releaseAgentError("release_agent.interruption_state");
      }
      const result = store.transition(ticket, { state: "blocked", text: null, context: null, evaluation: null,
        reason: "operator_reconciled" }, { actor: "operator", action: "interruption_reconciled" });
      if (!result) throw releaseAgentError("release_agent.interruption_state");
      console.log(JSON.stringify({ id: result.id, state: result.state, revision: result.revision }));
      return;
    }
    if (!["run", "tick", "release", "release-tick"].includes(command)) throw releaseAgentError("release_agent.usage");
    const releasing = command === "release" || command === "release-tick";
    if (releasing && config.mode !== "production") throw releaseAgentError("release_agent.production_disabled");
    const { createProduction } = await import("./production.mjs");
    const productionConfig = releasing || !config.production ? config : {
      ...config, production: { origin: config.production.origin, goCommand: config.production.goInspectCommand,
        otaAuthority: config.production.otaAuthority },
    };
    const production = createProduction({ config: productionConfig });
    let channel;
    let development;
    if (!releasing) {
      const { createDevelopment } = await import("./development.mjs");
      channel = createCometChannel({ config });
      await channel.check();
      development = createDevelopment({ config });
    }
    const coordinator = createReleaseCoordinator({ config, store, channel, production, development });
    const tick = releasing ? coordinator.releaseTick : coordinator.tick;
    if (command.endsWith("tick")) {
      console.log(JSON.stringify({ progressed: await tick() }));
      return;
    }
    let stopped = false;
    const stop = () => { stopped = true; };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(JSON.stringify({ status: "ready", role: releasing ? "release" : "coordinator", mode: config.mode }));
    try {
      while (!stopped) {
        if (!await tick()) await wait(releasing ? 10000 : 3000);
      }
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    store.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(safeCode(error, "release_agent.failed"));
  process.exitCode = 1;
}
