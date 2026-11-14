// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { Config } from "../../bundled/omp/config";
import type { HarnessKit } from "../agent-harness/kit";
import type { Delivery } from "../agents/service";
import type { Host } from "../host/service";
import { GramRuntime } from "./runtime";
import { workstreams, type WorkstreamBinding } from "./workstreams";

vi.mock("@tauri-apps/api/path", () => ({
  resolveResource: async () => "/app/gram-runtime/index.mjs",
}));

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("preserves the thread binding and its error when the local runtime fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const owner = "a".repeat(64);
  const conversation = {
    key: "channel/root",
    channel: "channel",
    root: "root",
    topLevel: false,
    where: "#general",
  };
  const host = {
    resolveDirectory: vi.fn(async () => "/home/gram"),
    spawn: vi.fn(async () => {
      throw new Error("Runtime executable is unavailable");
    }),
  } as unknown as Host;
  const harness = {
    conversation: vi.fn(async () => conversation),
    reply: vi.fn(async () => {}),
  } as unknown as HarnessKit;
  let completed: PromiseLike<unknown> | undefined;
  const delivery = {
    agent: {
      key: "agent",
      pubkey: "agent-pubkey",
      owner,
      relay: "wss://relay.example:8447",
      name: "Luna",
    },
    config: { provider: "omp", model: "openai-codex/gpt-6-luna" },
    trigger: {
      type: "mention",
      event: { id: "root", content: "Investigate the build" },
    },
    signal: new AbortController().signal,
    current: () => true,
    workingUntil: (promise: PromiseLike<unknown>) => {
      completed = promise;
    },
  } as unknown as Delivery<Config>;
  const runtime = new GramRuntime(host, harness);
  try {
    await runtime.run(delivery);
    expect(completed).toBeDefined();
    await completed;
    const binding = workstreams.find("agent\nchannel/root");
    expect(binding).toMatchObject({
      root: "root",
      request: "Investigate the build",
      created: false,
    });
    expect(workstreams.error("agent\nchannel/root")).toBe(
      "Runtime executable is unavailable",
    );
    expect(harness.reply).toHaveBeenCalled();
  } finally {
    await runtime.dispose();
  }
});

it("never matches another account, relay, channel, thread, or retired session", async () => {
  const owner = "b".repeat(64);
  const binding: WorkstreamBinding = {
    key: "agent-isolation\nchannel/root",
    owner,
    agentKey: "agent-isolation",
    pubkey: "agent-pubkey",
    community: "wss://relay.example:8447",
    channelId: "channel",
    root: "root",
    name: "Luna",
    agentId: "agent-id",
    serverId: "srv_fixture",
    cwd: "/workspace",
    created: true,
    retired: false,
    privateMessages: false,
    queued: [],
  };
  const runtime = new GramRuntime({} as Host, {} as HarnessKit);
  const scope = `https://relay.example:8447:${owner}`;
  try {
    expect(workstreams.matches(binding, owner, scope, "channel", "root")).toBe(
      true,
    );
    expect(
      workstreams.matches(binding, "other", scope, "channel", "root"),
    ).toBe(false);
    expect(
      workstreams.matches(
        binding,
        owner,
        `https://other.example:8447:${owner}`,
        "channel",
        "root",
      ),
    ).toBe(false);
    expect(
      workstreams.matches(binding, owner, scope, "other-channel", "root"),
    ).toBe(false);
    expect(
      workstreams.matches(binding, owner, scope, "channel", "other-root"),
    ).toBe(false);
    expect(
      workstreams.matches(
        { ...binding, retired: true },
        owner,
        scope,
        "channel",
        "root",
      ),
    ).toBe(false);
  } finally {
    await runtime.dispose();
  }
});

it("promotes an old binding without replacing the existing thread session", async () => {
  const owner = "c".repeat(64);
  const runtime = new GramRuntime({} as Host, {} as HarnessKit);
  const legacy: WorkstreamBinding = {
    key: "agent-legacy\nchannel",
    owner,
    agentKey: "agent-legacy",
    pubkey: "agent-pubkey",
    community: "wss://relay.example:8447",
    channelId: "channel",
    name: "Luna",
    agentId: "older-session",
    serverId: "srv_fixture",
    cwd: "/workspace",
    created: true,
    retired: false,
    privateMessages: true,
    queued: [{ id: "draft", text: "Keep this draft" }],
  };
  const current = {
    ...legacy,
    key: "agent-legacy\nchannel/root",
    root: "root",
    agentId: "current-session",
  };
  try {
    workstreams.save(legacy);
    workstreams.save(current);
    runtime.promoteLegacy(legacy, "root");
    expect(workstreams.find(current.key)).toEqual(current);
    expect(workstreams.find(legacy.key)).toEqual(legacy);
  } finally {
    await runtime.dispose();
  }
});
