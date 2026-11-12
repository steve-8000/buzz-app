// Turns Agents deliveries into omp turns. Each Buzz conversation is one omp
// session in its own git worktree, run as `omp --mode rpc-ui` on this
// computer. omp's questions (approvals, choices) are posted into the
// conversation and answered by the owner's next message; a message that is
// not an answer steers the run that is under way.
import type {
  HarnessConversation,
  HarnessKit,
} from "../../features/agent-harness/kit";
import type { AgentHandle, Delivery } from "../../features/agents/service";
import type { Host, HostProcess } from "../../features/host/service";
import { Admission } from "./admission";
import { type Config, config } from "./config";
import {
  answerTo,
  type Frame,
  isRecord,
  OmpRpc,
  type UiAnswer,
  type UiRequest,
} from "./rpc";
import { type ExecResult, prepareWorktree, slug } from "./worktree";

/** A conversation's omp process stops after this long without a turn. */
const IDLE_MS = 15 * 60_000;
/** Turns running at once across every omp agent in the app. */
export const GLOBAL_LIMIT = 8;
const DATA_ROOT = "~/.buzz/omp";
/** Posts are cut here; the relay refuses very long messages. */
const REPLY_LIMIT = 6000;

type Pending = {
  request: UiRequest;
  settle(answer: UiAnswer): void;
  timer: ReturnType<typeof setTimeout>;
};

type Session = {
  id: string;
  agent: AgentHandle;
  conversation: HarnessConversation;
  config: Config;
  rpc?: OmpRpc | undefined;
  proc?: HostProcess | undefined;
  starting?: Promise<OmpRpc> | undefined;
  cwd: string;
  branch?: string | undefined;
  cursor?: string | undefined;
  busy: boolean;
  /** omp's session has no messages yet, so the first prompt carries Buzz's
   * instructions. */
  fresh: boolean;
  announced: boolean;
  stopRequested: boolean;
  pending?: Pending | undefined;
  asking: Promise<unknown>;
  idle?: ReturnType<typeof setTimeout> | undefined;
  delivery?: Delivery<Config> | undefined;
  stderr: string;
  stopped: AbortController;
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string) {
  return text.length > REPLY_LIMIT
    ? `${text.slice(0, REPLY_LIMIT)}\n\n… (cut at ${REPLY_LIMIT} characters)`
    : text;
}

/** The owner's words in a mention, or empty for any other trigger. */
function wordsOf(delivery: Delivery<Config>) {
  return delivery.trigger.type === "mention"
    ? delivery.trigger.event.content
    : "";
}

function formatQuestion(request: UiRequest, minutes: number) {
  const lines = [`🔐 **${request.title || "omp asks"}**`];
  if (request.message) lines.push("", request.message);
  if (request.method === "confirm")
    lines.push("", "Reply `approve` or `deny` (mention me).");
  else if (request.method === "select")
    lines.push(
      "",
      ...(request.options ?? []).map((option, at) => `${at + 1}. ${option}`),
      "",
      "Reply with a number, or `deny` (mention me).",
    );
  else lines.push("", "Reply with the text, or `deny` (mention me).");
  lines.push(`Refused automatically after ${minutes} minutes.`);
  return lines.join("\n");
}

function target(frame: Frame) {
  const args = frame.args;
  if (!isRecord(args)) return undefined;
  for (const key of ["path", "file", "command", "pattern", "query"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value.slice(0, 120);
  }
  return undefined;
}

export class OmpRuntime {
  private readonly sessions = new Map<string, Session>();
  private readonly admission = new Admission(GLOBAL_LIMIT);
  private root: Promise<string> | undefined;

  constructor(
    private readonly host: Host,
    private readonly harness: HarnessKit,
  ) {}

  async run(delivery: Delivery<Config>): Promise<void> {
    const cfg = config(delivery.config);
    const conversation = await this.harness.conversation(delivery, cfg.scope);
    if (!conversation) {
      delivery.ignored?.();
      return;
    }
    delivery.acknowledged?.();
    const id = `${delivery.agent.key}\n${conversation.key}`;
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        agent: delivery.agent,
        conversation,
        config: cfg,
        cwd: "",
        busy: false,
        fresh: true,
        announced: false,
        stopRequested: false,
        asking: Promise.resolve(),
        stderr: "",
        stopped: new AbortController(),
      };
      this.sessions.set(id, session);
    }
    session.config = cfg;
    clearTimeout(session.idle);

    if (session.pending) {
      const answer = answerTo(session.pending.request, wordsOf(delivery));
      if (answer) session.pending.settle(answer);
      else
        await this.say(
          session,
          "Reply `approve` or `deny` to the question above.",
        );
      return;
    }

    if (session.busy && session.rpc) {
      const prompt = await this.harness.turnPrompt(
        delivery,
        conversation,
        session.cursor ? { cursor: session.cursor } : undefined,
      );
      try {
        await session.rpc.steer(prompt.text);
        session.cursor = prompt.cursor;
      } catch (error) {
        prompt.restore();
        throw error;
      }
      return;
    }

    session.busy = true;
    session.stopRequested = false;
    session.delivery = delivery;
    const target = session;
    delivery.interruptible?.(async () => {
      target.stopRequested = true;
      await target.rpc?.abort();
    });
    delivery.workingUntil(
      this.turn(session, delivery).then(
        () =>
          target.stopRequested ? { ok: true, stopped: true } : { ok: true },
        (error: unknown) => ({ ok: false, error: errorText(error) }),
      ),
    );
  }

  /** Stops every omp process of one agent. */
  async retire(agentKey: string) {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.agent.key === agentKey)
        .map((session) => this.close(session)),
    );
  }

  async dispose() {
    await Promise.all([...this.sessions.values()].map((s) => this.close(s)));
  }

  private async turn(session: Session, delivery: Delivery<Config>) {
    const cfg = session.config;
    const release = await this.admission.acquire(
      cfg.repo || cfg.workspace,
      cfg.maxConcurrent,
      session.stopped.signal,
    );
    try {
      const rpc = await this.ensure(session, cfg);
      const system = session.fresh
        ? await this.harness.systemPrompt(delivery, {
            scope: cfg.scope,
            cwd: session.cwd,
            instructions: cfg.instructions,
            tools: false,
          })
        : "";
      const prompt = await this.harness.turnPrompt(
        delivery,
        session.conversation,
        session.cursor ? { cursor: session.cursor } : undefined,
      );
      const end = rpc.nextEnd();
      end.catch(() => undefined);
      try {
        await rpc.prompt(system ? `${system}\n\n${prompt.text}` : prompt.text);
      } catch (error) {
        prompt.restore();
        throw error;
      }
      session.fresh = false;
      session.cursor = prompt.cursor;
      const result = await end;
      if (result.error) {
        await this.say(session, `⚠️ ${result.error}`, true);
        return;
      }
      let text = result.text || "(omp finished without a reply.)";
      if (!session.announced && session.branch) {
        session.announced = true;
        text += `\n\n🌿 \`${session.branch}\` · \`${session.cwd}\``;
      }
      await this.say(session, text);
    } catch (error) {
      await this.say(session, `⚠️ ${errorText(error)}`, true);
      throw error;
    } finally {
      release();
      session.busy = false;
      session.delivery = undefined;
      if (!session.pending && this.sessions.get(session.id) === session)
        session.idle = setTimeout(() => void this.close(session), IDLE_MS);
    }
  }

  private async directory(path: string) {
    if (!this.host.resolveDirectory)
      throw new Error("This build cannot resolve directories.");
    return this.host.resolveDirectory(path);
  }

  private async git(args: readonly string[], cwd: string): Promise<ExecResult> {
    if (!this.host.spawn) throw new Error("This build cannot start processes.");
    let out = "";
    let err = "";
    const proc = await this.host.spawn("git", {
      args,
      cwd,
      onStdout: (data) => {
        out += data;
      },
      onStderr: (data) => {
        err += data;
      },
    });
    const code = await proc.exited;
    return { code: code ?? -1, out, err };
  }

  private ensure(session: Session, cfg: Config): Promise<OmpRpc> {
    if (session.rpc) return Promise.resolve(session.rpc);
    session.starting ??= this.start(session, cfg).finally(() => {
      session.starting = undefined;
    });
    return session.starting;
  }

  private async start(session: Session, cfg: Config): Promise<OmpRpc> {
    if (!this.host.spawn) throw new Error("This build cannot start processes.");
    this.root ??= this.directory(DATA_ROOT);
    const root = await this.root;
    let cwd: string;
    if (cfg.repo) {
      const worktree = await prepareWorktree(
        (args, dir) => this.git(args, dir),
        {
          repo: await this.directory(cfg.repo),
          base: cfg.base,
          root: `${root}/worktrees`,
          key: session.id,
        },
      );
      cwd = worktree.path;
      session.branch = worktree.branch;
    } else {
      cwd = await this.directory(cfg.workspace);
    }
    session.cwd = cwd;

    const args = [
      "--cwd",
      cwd,
      "--no-title",
      "--session-dir",
      `${root}/sessions/${slug(session.id)}`,
      "--continue",
      ...(cfg.model ? ["--model", cfg.model] : []),
      ...(cfg.thinking ? ["--thinking", cfg.thinking] : []),
    ];
    let rpc: OmpRpc | undefined;
    const early: string[] = [];
    const proc = await this.host.spawn("omp", {
      args,
      cwd,
      onStdout: (data) => (rpc ? rpc.feed(data) : early.push(data)),
      onStderr: (data) => {
        session.stderr = (session.stderr + data).slice(-4000);
      },
    });
    const client = new OmpRpc(proc, {
      ask: (request) => this.ask(session, request),
      withdrawn: (id) => {
        if (session.pending?.request.id === id)
          session.pending.settle(
            session.pending.request.method === "confirm"
              ? { confirmed: false }
              : { cancelled: true },
          );
      },
      event: (frame) => {
        if (frame.type === "tool_execution_start") {
          const tool =
            typeof frame.toolName === "string" ? frame.toolName : "tool";
          session.delivery?.step?.(tool, target(frame));
        }
      },
      exited: () => {
        if (session.rpc === client) {
          session.rpc = undefined;
          session.proc = undefined;
        }
        session.pending?.settle({ cancelled: true });
      },
    });
    rpc = client;
    for (const data of early) client.feed(data);
    session.proc = proc;
    try {
      await client.waitReady();
      const state = await client.command<{ messageCount?: number }>({
        type: "get_state",
      });
      session.fresh = (state.messageCount ?? 0) === 0;
    } catch (error) {
      await proc.kill().catch(() => undefined);
      const detail = session.stderr.trim().split("\n").slice(-3).join("\n");
      throw new Error(`${errorText(error)}${detail ? `\n${detail}` : ""}`);
    }
    session.rpc = client;
    return client;
  }

  /** Posts a question and waits for the owner's answer, one at a time. */
  private ask(session: Session, request: UiRequest): Promise<UiAnswer> {
    const next = session.asking.then(
      () =>
        new Promise<UiAnswer>((resolve) => {
          const refused: UiAnswer =
            request.method === "confirm"
              ? { confirmed: false }
              : { cancelled: true };
          const minutes = session.config.approvalMinutes;
          const pending: Pending = {
            request,
            settle: (answer) => {
              clearTimeout(pending.timer);
              if (session.pending === pending) session.pending = undefined;
              resolve(answer);
            },
            timer: setTimeout(() => {
              pending.settle(refused);
              void this.say(session, "⏱ No answer in time; refused.");
            }, minutes * 60_000),
          };
          session.pending = pending;
          void this.say(session, formatQuestion(request, minutes), true);
        }),
    );
    session.asking = next.catch(() => undefined);
    return next;
  }

  private async say(session: Session, text: string, notifyOwner = false) {
    await this.harness
      .reply(session.agent, session.conversation, clip(text), { notifyOwner })
      .catch(() => undefined);
  }

  private async close(session: Session) {
    clearTimeout(session.idle);
    session.stopped.abort();
    session.pending?.settle({ cancelled: true });
    if (this.sessions.get(session.id) === session)
      this.sessions.delete(session.id);
    await session.rpc?.kill().catch(() => undefined);
    session.rpc = undefined;
    session.proc = undefined;
  }
}
