import { z } from "zod";
import { splitPartition } from "../relay/partition";

const BindingSchema = z.object({
  key: z.string(),
  agentKey: z.string(),
  pubkey: z.string(),
  owner: z.string(),
  community: z.string(),
  channelId: z.string(),
  root: z.string().optional(),
  name: z.string(),
  request: z.string().optional(),
  agentId: z.string(),
  serverId: z.string(),
  cwd: z.string(),
  branch: z.string().optional(),
  created: z.boolean(),
  cursor: z.string().optional(),
  lastMessage: z.string().optional(),
  retired: z.boolean().default(false),
  privateMessages: z.boolean().default(false),
  queued: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
});
export type WorkstreamBinding = z.infer<typeof BindingSchema>;
export interface AgentChatRuntime {
  openChat(binding: WorkstreamBinding): Promise<{
    endpoint: string;
    serverId: string;
    workspaceId: string;
    password: string;
  }>;
  promoteLegacy(binding: WorkstreamBinding, root: string): void;
}
const STORAGE_KEY = "gram.workstreams.v1";
const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

class Workstreams {
  private value: readonly WorkstreamBinding[] = [];
  private listeners = new Set<() => void>();
  private errors = new Map<string, string>();
  private loaded = false;
  runtime: AgentChatRuntime | undefined;
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  load() {
    if (this.loaded) return;
    const raw = localStorage.getItem(STORAGE_KEY);
    this.value = raw ? z.array(BindingSchema).parse(JSON.parse(raw)) : [];
    this.loaded = true;
  }
  register(runtime: AgentChatRuntime) {
    this.load();
    if (this.runtime)
      throw new Error("Another runtime already owns Gram workstreams");
    this.runtime = runtime;
    this.changed();
    return () => {
      if (this.runtime !== runtime) return;
      this.errors.clear();
      this.runtime = undefined;
      this.changed();
    };
  }
  save(binding: WorkstreamBinding) {
    const next = this.value
      .filter((item) => item.key !== binding.key)
      .concat(binding);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    this.value = next;
    this.changed();
  }
  find(key: string) {
    return this.value.find((item) => item.key === key);
  }
  error(key: string) {
    return this.errors.get(key);
  }
  setError(key: string, error: string | undefined) {
    if (this.errors.get(key) === error) return;
    if (error) this.errors.set(key, error);
    else this.errors.delete(key);
    this.value = [...this.value];
    this.changed();
  }
  promote(key: string, root: string) {
    const binding = this.find(key);
    if (!binding || binding.root) return;
    const nextKey = `${binding.agentKey}\n${binding.channelId}/${root}`;
    if (this.find(nextKey)) return;
    const next = this.value.map((item) =>
      item.key === key ? { ...item, key: nextKey, root } : item,
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    const error = this.errors.get(key);
    if (error) this.errors.set(nextKey, error);
    this.errors.delete(key);
    this.value = next;
    this.changed();
  }
  matches(
    binding: WorkstreamBinding,
    owner: string | undefined,
    community: string,
    channelId: string,
    root?: string,
  ) {
    const partition = splitPartition(community);
    return (
      !!this.runtime &&
      !binding.retired &&
      binding.owner === owner &&
      !!partition &&
      partition.viewer === owner &&
      hostOf(binding.community) === hostOf(partition.communityOrigin) &&
      binding.channelId === channelId &&
      binding.root === root
    );
  }
  private changed() {
    for (const listener of this.listeners) listener();
  }
}
export const workstreams = new Workstreams();
