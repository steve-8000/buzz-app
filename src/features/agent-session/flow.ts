// Lays a thread out as one flow: its messages, and between them the steps of
// the agent runs that happened. Both are in time order, with three
// exceptions that keep a run together: the message that asked for a run comes
// before it, the one that posted its answer comes after it, and a question's
// own message is replaced by the question the run shows.
import type { ChannelMessage } from "../relay/contracts";
import type { Published } from "./collection";
import { bySeq, type RunItem, type SessionItem } from "./item";

type Message = Pick<ChannelMessage, "id" | "createdAt" | "content">;

/** Steps of one run, in a stretch with no message among them. */
export type Segment = {
  readonly type: "segment";
  readonly key: string;
  readonly author: string;
  /** The run's own item, in the first stretch of the run. */
  run: RunItem | undefined;
  readonly items: SessionItem[];
};
export type FlowNode = Readonly<{ type: "reply"; id: string }> | Segment;

type Group = {
  key: string;
  author: string;
  run: RunItem | undefined;
  steps: SessionItem[];
};
type Event =
  | { stamp: number; order: number; reply: string }
  | { stamp: number; order: number; group: Group; item: SessionItem };

/** The steps a reader sees: not the closing text the run also posted as its
 * answer, which the thread shows as that message. */
function shown(group: Group, answer: Message | undefined): SessionItem[] {
  const steps = [...group.steps].sort(bySeq);
  const said = answer?.content;
  if (said)
    for (let at = steps.length - 1; at >= 0; at--) {
      const step = steps[at];
      if (step?.kind === "reasoning") continue;
      if (step?.kind !== "assistant" || !said.includes(step.text.trim())) break;
      steps.splice(at, 1);
    }
  return steps;
}

export function buildFlow(
  messages: readonly Message[],
  entries: readonly Published[],
): { nodes: FlowNode[]; replaced: ReadonlySet<string> } {
  const groups = new Map<string, Group>();
  const replaced = new Set<string>();
  for (const { author, item } of entries) {
    const key = `${author}:${item.run}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, author, run: undefined, steps: [] };
      groups.set(key, group);
    }
    if (item.kind === "run") group.run = item;
    else group.steps.push(item);
    if ((item.kind === "approval" || item.kind === "question") && item.message)
      replaced.add(item.message);
  }

  const byId = new Map(messages.map((message) => [message.id, message]));
  const stamps = new Map(
    messages.map((message) => [message.id, message.createdAt * 1000]),
  );
  const events: Event[] = [];
  for (const group of groups.values()) {
    const { run } = group;
    const answer = run?.reply ? byId.get(run.reply) : undefined;
    const steps = shown(group, answer);
    const start = run?.at ?? steps[0]?.at ?? 0;
    const end = Math.max(
      run?.end ?? 0,
      ...steps.map((step) => step.end ?? step.at),
    );
    if (run?.trigger && stamps.has(run.trigger))
      stamps.set(
        run.trigger,
        Math.min(stamps.get(run.trigger) ?? 0, start - 1),
      );
    if (run?.reply && stamps.has(run.reply))
      stamps.set(run.reply, Math.max(stamps.get(run.reply) ?? 0, end + 1));
    if (run) events.push({ stamp: run.at, order: run.seq, group, item: run });
    for (const step of steps)
      events.push({ stamp: step.at, order: step.seq, group, item: step });
  }
  for (const message of messages)
    if (!replaced.has(message.id))
      events.push({
        stamp: stamps.get(message.id) ?? 0,
        order: -1,
        reply: message.id,
      });
  events.sort(
    (left, right) => left.stamp - right.stamp || left.order - right.order,
  );

  const nodes: FlowNode[] = [];
  let open: Segment | undefined;
  let openGroup: Group | undefined;
  for (const event of events) {
    if ("reply" in event) {
      open = undefined;
      openGroup = undefined;
      nodes.push({ type: "reply", id: event.reply });
      continue;
    }
    if (!open || openGroup !== event.group) {
      open = {
        type: "segment",
        key: `${event.group.key}:${event.item.seq}`,
        author: event.group.author,
        run: undefined,
        items: [],
      };
      openGroup = event.group;
      nodes.push(open);
    }
    if (event.item.kind === "run") open.run = event.item;
    else open.items.push(event.item);
  }
  return { nodes, replaced };
}
