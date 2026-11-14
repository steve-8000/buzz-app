// omp agents: an agent type whose agents run Oh My Pi on this computer. Each
// conversation they are in gets its own git worktree and its own omp session,
// and omp's approvals and questions are answered from the conversation. What
// a session does is shown to the whole conversation as it happens.
import { isTauri } from "@tauri-apps/api/core";
import { LiveItems } from "../../features/agent-session/live";
import { sessionTranscripts } from "../../features/agent-session/transcripts";
import type { PluginModule } from "../../plugins/api";
import { type Config, config, DEFAULT_CONFIG } from "./config";
import { AskButtons } from "./AskButtons";
import { OmpSettings } from "./OmpSettings";
import { OmpRuntime } from "./runtime";

export const TYPE_ID = "omp";
/** A turn's run returns once its work is under way, so this bounds only the
 * hand-over, which includes making the worktree and starting omp. */
const HANDOVER_MS = 2 * 60_000;

export const inject = [
  "agents",
  "host",
  "conversation",
  "artifactStorage",
  "communityReader",
];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start processes; no unusable type elsewhere.
  if (!isTauri()) return;
  const { agents, host } = ctx;
  if (!host.spawn) return;
  const live = new LiveItems();
  const runtime = new OmpRuntime(
    host,
    agents.harness,
    sessionTranscripts(live),
  );
  ctx.effect(() => () => {
    void runtime.dispose();
  });

  ctx.conversation.registerAccessory({
    id: "omp-ask",
    title: "omp questions",
    placement: "message",
    component: AskButtons,
  });
  agents.register<Config>({
    id: TYPE_ID,
    title: "Oh My Pi",
    description:
      "Oh My Pi on this computer. Each conversation works in its own git worktree, and its work is shown in the thread as a session everyone in the conversation can follow.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    summary: (agent) => {
      const { model, repo, roots } = config(agent.config);
      const where = repo.split("/").pop() || (roots.length ? "any repo" : "");
      return [where, model].filter(Boolean).join(" · ") || "omp";
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
    // A reload ends omp's process, so Buzz asks the owner to resume its turns.
    resumes: true,
  });
};
