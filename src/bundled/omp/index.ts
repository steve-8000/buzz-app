// Preserve agent membership identities while replacing their execution owner.
import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { type Config, config, DEFAULT_CONFIG } from "./config";
import { OmpSettings } from "./OmpSettings";
import { GramRuntime } from "../../features/agent-chat/runtime";

export const TYPE_ID = "omp";
// This bounds hand-over, not the background agent turn.
const HANDOVER_MS = 2 * 60_000;

export const inject = ["agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start processes; no unusable type elsewhere.
  if (!isTauri()) return;
  const { agents, host } = ctx;
  if (!host.spawn) return;
  const runtime = new GramRuntime(host, agents.harness);
  ctx.effect(() => () => {
    void runtime.dispose();
  });

  agents.register<Config>({
    id: TYPE_ID,
    title: "Gram Agent",
    description:
      "Paseo agent sessions inside Gram threads, with local tool output, approvals and changes.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    summary: (agent) => {
      const { provider, model, repo, roots } = config(agent.config);
      const where = repo.split("/").pop() || (roots.length ? "any repo" : "");
      return [provider, where, model].filter(Boolean).join(" · ");
    },
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: OmpSettings,
      },
    ],
    retire: (key) => runtime.retire(key),
    run: (delivery) => runtime.run(delivery),
    timeoutMs: HANDOVER_MS,
    // Reopening a saved turn requires its owner's resume action.
    resumes: true,
  });
};
