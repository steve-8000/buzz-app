// omp agents: an agent type whose agents run Oh My Pi on this computer. Each
// conversation they are in gets its own git worktree and its own omp session,
// and omp's approvals and questions are answered from the conversation. What
// a session does is shown to the whole conversation as it happens.
import { isTauri } from "@tauri-apps/api/core";
import { openSessionCollection } from "../../features/agent-session/collection";
import type {
  SessionAnswer,
  SessionControls,
} from "../../features/agent-session/controls";
import type {
  ApprovalItem,
  QuestionItem,
} from "../../features/agent-session/item";
import { LiveItems } from "../../features/agent-session/live";
import { sessionFlow } from "../../features/agent-session/SessionThread";
import { sessionTranscripts } from "../../features/agent-session/transcripts";
import type { PluginModule } from "../../plugins/api";
import { type Config, config, DEFAULT_CONFIG } from "./config";
import { AskButtons } from "./AskButtons";
import { OmpSettings } from "./OmpSettings";
import { OmpRuntime } from "./runtime";
import type { UiAnswer } from "./rpc";
import { APPROVE, DENY } from "./transcript/notes";

export const TYPE_ID = "omp";
/** A turn's run returns once its work is under way, so this bounds only the
 * hand-over, which includes making the worktree and starting omp. */
const HANDOVER_MS = 2 * 60_000;

/** The reply omp reads for what the card's reader chose. */
function uiAnswer(
  item: ApprovalItem | QuestionItem,
  answer: SessionAnswer,
): UiAnswer {
  if (!("approved" in answer)) return answer;
  return item.kind === "approval"
    ? { value: answer.approved ? APPROVE : DENY }
    : { confirmed: answer.approved };
}

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
  const collection = openSessionCollection(ctx);
  const controls: SessionControls = {
    canAnswer: (channel, root, author, item) =>
      !!runtime.pending(channel, root, author, item.request),
    answer: (channel, root, author, item, answer) => {
      runtime.answer(
        channel,
        root,
        author,
        item.request,
        uiAnswer(item, answer),
      );
    },
  };
  ctx.conversation.registerThreadFlow({
    id: "omp-session",
    title: "omp sessions",
    component: sessionFlow({ collection, live }, controls),
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
