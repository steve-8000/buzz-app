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
import { formatQuestion, retryHint } from "./ask";
import { type Config, config } from "./config";
import { intro, slim } from "./prompt";
import {
  type Choice,
  describeRepositories,
  LIST_SCRIPT,
  parseRepositories,
  pickRepository,
  type Repo,
} from "./repos";
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
  /** Where the conversation works: its repository, "" for none, undefined
   * until chosen. */
  repo?: string | undefined;
  repos?: readonly Repo[] | undefined;
  /** A folder of repositories the conversation works in across, when its
   * channel names the folder and the message names no single repository. */
  hub?: string | undefined;
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
    session.conversation = conversation;
    clearTimeout(session.idle);

    if (session.pending) {
      const answer = answerTo(session.pending.request, wordsOf(delivery));
      if (answer) session.pending.settle(answer);
      else await this.say(session, retryHint(session.pending.request));
      return;
    }

    if ((session.busy || session.rpc?.streaming) && session.rpc) {
      const prompt = await this.harness.turnPrompt(
        delivery,
        conversation,
        session.cursor ? { cursor: session.cursor } : undefined,
      );
      try {
        await session.rpc.steer(slim(prompt.text));
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

  /** A run omp began by itself, as after a background job or a queued
   * message: its reply is posted like a turn's. */
  private async continued(session: Session) {
    const rpc = session.rpc;
    if (!rpc) return;
    session.busy = true;
    clearTimeout(session.idle);
    try {
      const end = await rpc.nextEnd();
      const text = end.error ? `⚠️ ${end.error}` : end.text;
      if (text) await this.say(session, text, !!end.error);
    } catch {
      // The process ended; its exit already settled the session.
    } finally {
      session.busy = false;
      if (!session.pending && this.sessions.get(session.id) === session)
        session.idle = setTimeout(() => void this.close(session), IDLE_MS);
    }
  }

  private async turn(session: Session, delivery: Delivery<Config>) {
    const cfg = session.config;
    let release: (() => void) | undefined;
    try {
      const repo = await this.locate(session, cfg);
      release = await this.admission.acquire(
        repo || cfg.workspace,
        cfg.maxConcurrent,
        session.stopped.signal,
      );
      const rpc = await this.ensure(session, cfg);
      const system = session.fresh
        ? intro(delivery.agent.name, [cfg.instructions, this.note(session)])
        : "";
      const prompt = await this.harness.turnPrompt(
        delivery,
        session.conversation,
        session.cursor ? { cursor: session.cursor } : undefined,
      );
      const end = rpc.nextEnd();
      end.catch(() => undefined);
      try {
        const text = slim(prompt.text);
        await rpc.prompt(system ? `${system}\n\n${text}` : text);
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
      release?.();
      session.busy = false;
      session.delivery = undefined;
      if (!session.pending && this.sessions.get(session.id) === session)
        session.idle = setTimeout(() => void this.close(session), IDLE_MS);
    }
  }

  /** The repository this conversation works in: named in the owner's first
   * message, or like its channel, from the agent's folders; else the agent's
   * own repository. Chosen once, so a conversation keeps its worktree. */
  private async locate(session: Session, cfg: Config): Promise<string> {
    if (session.repo === undefined) {
      session.repo = "";
      if (cfg.roots.length) {
        const repos = await this.repositories(cfg.roots);
        session.repos = repos;
        const prior = await this.prior(session);
        const known = prior
          ? repos.find((item) => item.name === prior)
          : undefined;
        const kept = known ? "" : await this.hubOf(session);
        const words = session.delivery ? wordsOf(session.delivery) : "";
        const choice: Choice = known
          ? { repo: known }
          : kept
            ? { hub: kept }
            : pickRepository(repos, session.conversation.where, words);
        const { repo, asked, hub } = choice;
        if (asked && !repo) {
          session.repo = undefined;
          throw new Error(
            `No repository named \`${asked}\` in ${cfg.roots.join(", ")}.`,
          );
        }
        session.repo = repo?.path ?? "";
        if (hub) {
          session.hub = hub;
          if (!kept) await this.markHub(session, hub);
        }
      }
    }
    return session.repo || session.hub || cfg.repo;
  }

  private async shell(script: string, args: readonly string[]) {
    if (!this.host.spawn) throw new Error("This build cannot start processes.");
    let out = "";
    const proc = await this.host.spawn("sh", {
      args: [script, "buzz", ...args],
      cwd: DATA_ROOT,
      onStdout: (data) => {
        out += data;
      },
    });
    await proc.exited;
    return out;
  }

  private async repositories(roots: readonly string[]): Promise<Repo[]> {
    return parseRepositories(await this.shell(LIST_SCRIPT, roots));
  }

  /** The repository whose worktree this conversation already has, so a
   * restart or a later message cannot move it to another repository. */
  private async prior(session: Session): Promise<string | undefined> {
    const out = await this.shell(
      'ls -d "$HOME"/.buzz/omp/worktrees/*/"$1" 2>/dev/null',
      [slug(session.id)],
    );
    return out
      .split("\n")
      .map((line) => line.trim().split("/").slice(-2)[0])
      .find(Boolean);
  }

  /** The folder this conversation works across, kept like its worktree. */
  private async hubOf(session: Session): Promise<string> {
    const out = await this.shell(
      'cat "$HOME"/.buzz/omp/hubs/"$1" 2>/dev/null',
      [slug(session.id)],
    );
    return out.trim();
  }

  private async markHub(session: Session, hub: string) {
    await this.shell(
      'mkdir -p "$HOME"/.buzz/omp/hubs && printf %s "$2" > "$HOME"/.buzz/omp/hubs/"$1"',
      [slug(session.id), hub],
    );
  }

  /** Where the conversation works and what exists, as facts. */
  private note(session: Session) {
    if (!session.repos?.length) return "";
    const where = session.hub
      ? `Your working directory is ${session.hub}, the owner's folder of repositories. They are the owner's own checkouts and can hold uncommitted work.`
      : `Your working directory is a git worktree of ${session.repo || "no repository"}${session.branch ? ` on branch ${session.branch}` : ""}, made for this conversation. The owner's own checkouts are elsewhere and can hold uncommitted work.`;
    return [
      where,
      "Repositories by folder:",
      describeRepositories(session.repos),
      "A thread started with `repo:<name>` works in its own worktree of that repository.",
    ].join("\n");
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
    const picked = session.hub ? "" : session.repo || cfg.repo;
    if (picked) {
      const worktree = await prepareWorktree(
        (args, dir) => this.git(args, dir),
        {
          repo: await this.directory(picked),
          base: cfg.base,
          root: `${root}/worktrees`,
          key: session.id,
        },
      );
      cwd = worktree.path;
      session.branch = worktree.branch;
    } else {
      cwd = await this.directory(session.hub || cfg.workspace);
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
      started: () => {
        if (!session.busy) void this.continued(session);
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
