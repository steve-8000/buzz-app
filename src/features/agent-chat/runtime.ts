import { resolveResource } from "@tauri-apps/api/path";
import { z } from "zod";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import type {
  HarnessConversation,
  HarnessKit,
  HarnessPrompt,
} from "../agent-harness/kit";
import type { Delivery } from "../agents/service";
import type { Host, HostProcess } from "../host/service";
import { Admission } from "../../bundled/omp/admission";
import { config, type Config } from "../../bundled/omp/config";
import {
  LIST_SCRIPT,
  parseRepositories,
  pickRepository,
} from "../../bundled/omp/repos";
import { prepareWorktree, type ExecResult } from "../../bundled/omp/worktree";
import {
  workstreams,
  type AgentChatRuntime,
  type WorkstreamBinding,
} from "./workstreams";

const ReadySchema = z.object({
  type: z.literal("ready"),
  url: z.url(),
  serverId: z.string(),
});
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class GramRuntime implements AgentChatRuntime {
  private starting: Promise<DaemonClient> | undefined;
  private driver: DaemonClient | undefined;
  private process: HostProcess | undefined;
  private stopped = false;
  private serverId = "";
  private connection:
    | { endpoint: string; serverId: string; password: string }
    | undefined;
  private opening = new Map<string, Promise<WorkstreamBinding>>();
  private admission = new Admission(8);
  private active = new Map<string, AbortController>();
  private legacyPromotions = new Map<string, string>();
  private unregister: () => void;
  constructor(
    private readonly host: Host,
    private readonly harness: HarnessKit,
  ) {
    this.unregister = workstreams.register(this);
  }
  client(): Promise<DaemonClient> {
    if (this.stopped)
      return Promise.reject(new Error("Gram runtime has stopped"));
    if (!this.starting)
      this.starting = this.start().catch((error: unknown) => {
        this.starting = undefined;
        throw error;
      });
    return this.starting;
  }
  private async start() {
    if (!this.host.spawn || !this.host.resolveDirectory)
      throw new Error("Gram agent execution requires the desktop app");
    const entry = await resolveResource("gram-runtime/index.mjs");
    const cwd = await this.host.resolveDirectory("~/.gram");
    const password = crypto.randomUUID() + crypto.randomUUID();
    let complete!: (ready: z.infer<typeof ReadySchema>) => void;
    let fail!: (error: Error) => void;
    const ready = new Promise<z.infer<typeof ReadySchema>>(
      (resolve, reject) => {
        complete = resolve;
        fail = reject;
      },
    );
    void ready.catch(() => {});
    let buffer = "";
    let stderr = "";
    const timer = window.setTimeout(
      () => fail(new Error(`Gram runtime did not start. ${stderr}`)),
      60_000,
    );
    let process: HostProcess | undefined;
    try {
      process = await this.host.spawn("runtime", {
        args: [entry],
        cwd,
        env: {
          GRAM_RUNTIME_PASSWORD: password,
          GRAM_RUNTIME_ORIGIN: location.origin,
        },
        onStdout: (chunk) => {
          buffer += chunk;
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const parsed = ReadySchema.safeParse(JSON.parse(line));
              if (parsed.success) complete(parsed.data);
            } catch {
              fail(
                new Error("Gram runtime returned an invalid startup message"),
              );
            }
          }
        },
        onStderr: (chunk) => {
          stderr = (stderr + chunk).slice(-4000);
        },
      });
      this.process = process;
      void process.exited.then((code) => {
        fail(new Error(`Gram runtime exited (${code}). ${stderr}`));
        if (this.process === process) {
          void this.driver?.close().catch(console.error);
          this.driver = undefined;
          this.starting = undefined;
          this.connection = undefined;
          this.process = undefined;
        }
      });
      const info = await ready;
      const endpoint = new URL(info.url);
      if (
        endpoint.hostname !== "127.0.0.1" ||
        endpoint.protocol !== "ws:" ||
        endpoint.pathname !== "/ws"
      )
        throw new Error("Gram runtime returned an invalid local endpoint");
      if (this.stopped) throw new Error("Gram runtime stopped during startup");
      const driver = new DaemonClient({
        url: info.url,
        password,
        clientId: `gram-${crypto.randomUUID()}`,
      });
      await driver.connect();
      if (this.stopped) {
        await driver.close();
        throw new Error("Gram runtime stopped during connection");
      }
      this.serverId = info.serverId;
      this.connection = {
        endpoint: `127.0.0.1:${endpoint.port}`,
        serverId: info.serverId,
        password,
      };
      this.driver = driver;
      return driver;
    } catch (error) {
      await process?.kill();
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }
  async openChat(binding: WorkstreamBinding) {
    const driver = await this.client();
    if (
      !this.connection ||
      !binding.created ||
      binding.serverId !== this.connection.serverId
    )
      throw new Error("This thread belongs to a different Gram runtime");
    const found = await driver.fetchAgent(binding.agentId);
    if (!found) throw new Error("The saved agent session is unavailable");
    return {
      ...this.connection,
      workspaceId: found.agent.workspaceId ?? binding.cwd,
    };
  }
  promoteLegacy(binding: WorkstreamBinding, root: string) {
    if (binding.root) return;
    if (this.active.has(binding.key) || this.opening.has(binding.key)) {
      this.legacyPromotions.set(binding.key, root);
      return;
    }
    workstreams.promote(binding.key, root);
  }
  private async exec(
    program: "git" | "sh",
    args: readonly string[],
    cwd: string,
  ): Promise<ExecResult> {
    if (!this.host.spawn)
      throw new Error("Desktop process access is unavailable");
    let out = "";
    let err = "";
    const process = await this.host.spawn(program, {
      args,
      cwd,
      onStdout: (text) => {
        out += text;
      },
      onStderr: (text) => {
        err += text;
      },
    });
    return { code: (await process.exited) ?? 1, out, err };
  }
  private async binding(
    delivery: Delivery<Config>,
    conversation: HarnessConversation,
    cfg: Config,
  ) {
    const key = `${delivery.agent.key}\n${conversation.key}`;
    const pending = this.opening.get(key);
    if (pending) return pending;
    const opened = this.open(delivery, conversation, cfg, key).finally(() => {
      this.opening.delete(key);
    });
    this.opening.set(key, opened);
    return opened;
  }
  private async open(
    delivery: Delivery<Config>,
    conversation: HarnessConversation,
    cfg: Config,
    key: string,
  ) {
    const saved = workstreams.find(key);
    let binding: WorkstreamBinding = saved ?? {
      key,
      agentKey: delivery.agent.key,
      pubkey: delivery.agent.pubkey,
      owner: delivery.agent.owner,
      community: delivery.agent.relay,
      channelId: conversation.channel,
      ...(conversation.root ? { root: conversation.root } : {}),
      name: delivery.agent.name,
      ...(delivery.trigger.type === "mention"
        ? { request: delivery.trigger.event.content }
        : {}),
      agentId: crypto.randomUUID(),
      serverId: "",
      cwd: cfg.workspace,
      created: false,
      retired: false,
      privateMessages: false,
      queued: [],
    };
    if (!saved || (!saved.created && saved.retired)) {
      binding = { ...binding, retired: false };
      workstreams.save(binding);
    }
    workstreams.setError(binding.key, undefined);
    const driver = await this.client();
    if (saved?.created) {
      if (saved.serverId !== this.serverId)
        throw new Error("This thread belongs to a different Gram runtime");
      const found = await driver.fetchAgent(saved.agentId);
      if (!found)
        throw new Error(
          "The saved agent session is unavailable; its binding was not replaced",
        );
      if (saved.retired) {
        const restored = { ...saved, retired: false };
        workstreams.save(restored);
        return restored;
      }
      return saved;
    }
    if (!this.host.resolveDirectory)
      throw new Error("Desktop folder access is unavailable");
    const prepared = !!binding.serverId;
    let repo = cfg.repo;
    let folder = cfg.workspace;
    if (!prepared && cfg.roots.length) {
      const listed = await this.exec(
        "sh",
        [LIST_SCRIPT, "gram", ...cfg.roots],
        "~/.gram",
      );
      if (listed.code !== 0)
        throw new Error(listed.err || "Could not list repository folders");
      const words =
        delivery.trigger.type === "mention"
          ? delivery.trigger.event.content
          : "";
      const choice = pickRepository(
        parseRepositories(listed.out),
        conversation.where,
        words,
      );
      if (choice.asked && !choice.repo)
        throw new Error(`No repository named ${choice.asked}`);
      repo = choice.repo?.path ?? repo;
      if (choice.hub) {
        repo = "";
        folder = choice.hub;
      }
    }
    let cwd = prepared ? binding.cwd : await this.host.resolveDirectory(folder);
    let branch = binding.branch;
    if (!prepared && repo) {
      const tree = await prepareWorktree(
        (args, dir) => this.exec("git", args, dir),
        {
          repo: await this.host.resolveDirectory(repo),
          base: cfg.base,
          root: `${await this.host.resolveDirectory("~/.gram")}/worktrees`,
          key:
            cfg.scope === "channel"
              ? `${delivery.agent.key}\n${conversation.channel}`
              : key,
        },
      );
      cwd = tree.path;
      branch = tree.branch;
    }
    binding = {
      ...binding,
      serverId: this.serverId,
      cwd,
      ...(branch ? { branch } : {}),
    };
    workstreams.save(binding);
    const definition = AGENT_PROVIDER_DEFINITIONS.find(
      (item) => item.id === cfg.provider,
    );
    const mode =
      definition?.modes.find(
        (item) => item.colorTier === "safe" && !item.isUnattended,
      ) ?? definition?.modes.find((item) => !item.isUnattended);
    const systemPrompt = await this.harness.systemPrompt(delivery, {
      scope: conversation.root ? "thread" : cfg.scope,
      cwd,
      instructions: cfg.instructions,
      tools: false,
    });
    const agent = await driver.createAgent({
      agentId: binding.agentId,
      idempotencyKey: `gram:${key}`,
      cwd,
      config: {
        provider: cfg.provider,
        cwd,
        systemPrompt,
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.thinking ? { thinkingOptionId: cfg.thinking } : {}),
        ...(mode ? { modeId: mode.id } : {}),
      },
      labels: {
        "gram.binding": key,
        "gram.owner": binding.owner,
        "gram.community": binding.community,
        "gram.channel": binding.channelId,
        "gram.thread": binding.root ?? "",
      },
    });
    binding = { ...binding, agentId: agent.id, created: true };
    workstreams.save(binding);
    return binding;
  }
  async run(delivery: Delivery<Config>) {
    const cfg = config(delivery.config);
    const conversation = await this.harness.conversation(delivery, cfg.scope, {
      separateThreads: true,
    });
    if (!conversation) {
      delivery.ignored?.();
      return;
    }
    delivery.acknowledged?.();
    const work = this.turn(delivery, conversation, cfg);
    delivery.workingUntil(
      work.then(
        (result) => result,
        () => ({
          ok: false,
          error: "Gram execution failed; see the local agent thread.",
        }),
      ),
    );
  }
  private async turn(
    delivery: Delivery<Config>,
    conversation: HarnessConversation,
    cfg: Config,
  ) {
    const release = await this.admission.acquire(
      cfg.repo || cfg.workspace,
      cfg.maxConcurrent,
      delivery.signal,
    );
    let binding: WorkstreamBinding | undefined;
    let prompt: HarnessPrompt | undefined;
    let sent = false;
    let controller: AbortController | undefined;
    let abort: (() => void) | undefined;
    try {
      binding = await this.binding(delivery, conversation, cfg);
      const target = binding;
      const driver = await this.client();
      const alreadyRunning = this.active.has(target.key);
      if (!alreadyRunning) {
        controller = new AbortController();
        this.active.set(target.key, controller);
        abort = () => {
          controller?.abort(delivery.signal.reason);
          void driver.cancelAgent(target.agentId).catch(console.error);
        };
        delivery.signal.addEventListener("abort", abort, { once: true });
      }
      delivery.interruptible?.(() => this.stop(target));
      const messageId =
        delivery.trigger.type === "mention"
          ? delivery.trigger.event.id
          : undefined;
      const resumed =
        delivery.trigger.type === "mention" &&
        delivery.trigger.resumed &&
        target.lastMessage === messageId;
      if (!resumed) {
        const latest = workstreams.find(target.key) ?? target;
        prompt = await this.harness.turnPrompt(
          delivery,
          conversation,
          latest.cursor ? { cursor: latest.cursor } : undefined,
        );
        if (!delivery.current()) {
          prompt.restore();
          return { ok: true };
        }
        await driver.sendAgentMessage(target.agentId, prompt.text, {
          ...(messageId ? { messageId } : {}),
          activeTurnBehavior: "steer",
        });
        sent = true;
        binding = {
          ...(workstreams.find(target.key) ?? target),
          cursor: prompt.cursor,
          ...(messageId ? { lastMessage: messageId } : {}),
        };
        workstreams.save(binding);
      }
      if (alreadyRunning) return { ok: true };
      if (!controller)
        throw new Error("Gram turn controller was not initialized");
      const signal = controller.signal;
      if (delivery.signal.aborted) abort?.();
      const result = await this.waitForEnd(
        driver,
        binding,
        signal,
        cfg.approvalMinutes,
      );
      if (result.status === "error" || result.status === "timeout")
        throw new Error(result.error ?? "The agent turn did not finish");
      if (result.lastMessage) {
        const reply = workstreams.find(binding.key)?.privateMessages
          ? "Gram session completed. The result is private in the local Thread."
          : result.lastMessage;
        await this.harness.reply(delivery.agent, conversation, reply);
      }
      return { ok: true };
    } catch (error) {
      if (!sent) prompt?.restore();
      if (controller?.signal.aborted) return { ok: true, stopped: true };
      if (binding && controller)
        await this.driver?.cancelAgent(binding.agentId).catch(console.error);
      console.error("Gram agent turn failed", error);
      const failed =
        binding ??
        workstreams.find(`${delivery.agent.key}\n${conversation.key}`);
      if (failed) workstreams.setError(failed.key, errorText(error));
      await this.harness.reply(
        delivery.agent,
        conversation,
        "Gram execution failed. Details are available in the local agent thread.",
        { notifyOwner: true },
      );
      throw error;
    } finally {
      if (abort) delivery.signal.removeEventListener("abort", abort);
      if (binding && controller && this.active.get(binding.key) === controller)
        this.active.delete(binding.key);
      const key = `${delivery.agent.key}\n${conversation.key}`;
      const root = this.legacyPromotions.get(key);
      if (root) {
        this.legacyPromotions.delete(key);
        const current = workstreams.find(key);
        if (current) this.promoteLegacy(current, root);
      }
      release();
    }
  }
  private async waitForEnd(
    driver: DaemonClient,
    binding: WorkstreamBinding,
    signal: AbortSignal,
    approvalMinutes: number,
  ) {
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const cancel = () => rejectAbort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const result = await Promise.race([
          driver.waitForFinish(binding.agentId, 24 * 60 * 60_000),
          aborted,
        ]);
        if (result.status !== "permission") return result;
        await new Promise<void>((resolve, reject) => {
          const observation = driver.observeAgents({
            filter: { labels: { "gram.binding": binding.key } },
            page: { limit: 1 },
          });
          let settled = false;
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", stopped);
            window.clearTimeout(timer);
            void observation.release().catch(console.error);
            if (error) reject(error);
            else resolve();
          };
          const stopped = () => finish(signal.reason);
          const timer = window.setTimeout(
            () => finish(new Error("The pending approval expired")),
            approvalMinutes * 60_000,
          );
          signal.addEventListener("abort", stopped, { once: true });
          observation.subscribe({
            snapshot: (snapshot) => {
              const agent = snapshot.entries.find(
                (entry) => entry.agent.id === binding.agentId,
              )?.agent;
              if (agent && agent.pendingPermissions.length === 0) finish();
            },
            update: (message) => {
              if (
                message.type === "agent_update" &&
                message.payload.kind === "upsert" &&
                message.payload.agent.id === binding.agentId &&
                message.payload.agent.pendingPermissions.length === 0
              )
                finish();
            },
            error: finish,
          });
          void observation.ready
            .then(async () => {
              const current = await driver.fetchAgent(binding.agentId);
              if (current && current.agent.pendingPermissions.length === 0)
                finish();
            })
            .catch(finish);
        });
      }
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  async stop(binding: WorkstreamBinding) {
    if (binding.created)
      await (await this.client()).cancelAgent(binding.agentId);
    this.active.get(binding.key)?.abort(new Error("Stopped by the owner"));
  }
  async retire(agentKey: string) {
    const owned = workstreams
      .snapshot()
      .filter((binding) => binding.agentKey === agentKey);
    for (const binding of owned) {
      await this.stop(binding);
      workstreams.save({
        ...(workstreams.find(binding.key) ?? binding),
        retired: true,
      });
    }
  }
  async dispose() {
    this.stopped = true;
    this.unregister();
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.legacyPromotions.clear();
    await this.driver?.close();
    this.driver = undefined;
    this.connection = undefined;
    await this.process?.kill();
    this.process = undefined;
  }
}
