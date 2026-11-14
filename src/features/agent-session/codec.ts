// An item as a NIP-AR artifact (kind 45010): one artifact per item, so a
// rewritten item is a new revision of the same artifact and a reader gets
// the latest copy from sync.
import { ARTIFACT_KIND, uuidv5 } from "../agents/agent-config-artifacts";
import type { AgentEventTemplate } from "../agents/native";
import {
  bound,
  isOpen,
  SESSION_ITEM_TYPE,
  SESSION_ITEM_VERSION,
  type SessionItem,
} from "./item";
import { redact } from "./redact";

const NAMESPACE = "6c2c8a3e-0b8f-4d57-9d5e-6f5a1d2e7b40";

/** Where a conversation's items live, and who writes them. */
export type Anchor = Readonly<{
  agent: string;
  channel: string;
  root?: string | undefined;
}>;

/** An item's artifact identity: the same for every revision of it. */
export function itemId(anchor: Anchor, seq: number) {
  return uuidv5(
    NAMESPACE,
    `${anchor.agent}:${anchor.channel}:${anchor.root ?? ""}:${seq}`,
  );
}

function titleOf(item: SessionItem): string {
  const line = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 100);
  switch (item.kind) {
    case "run":
      return "Agent run";
    case "assistant":
      return line(item.text) || "Reply";
    case "reasoning":
      return "Reasoning";
    case "tool":
      return line(`${item.name}${item.intent ? ` · ${item.intent}` : ""}`);
    case "approval":
      return `Approval · ${item.tool}`;
    case "question":
      return line(`Question · ${item.title}`);
    case "todo":
      return "Todo list";
    case "notice":
      return line(item.text) || "Notice";
    case "compaction":
      return "Context compaction";
  }
}

/** The event that writes this copy of the item: its first revision when
 * `prev` is absent, else one more on top of `prev`. */
export function encode(
  anchor: Anchor,
  item: SessionItem,
  d: string,
  prev: string | undefined,
): AgentEventTemplate {
  const safe = bound(redact(item));
  const tags: string[][] = [
    ["ar", "1"],
    ["d", d],
    ["h", anchor.channel],
    ["type", SESSION_ITEM_TYPE],
    ["title", titleOf(safe) || "Session item"],
    ["op", prev ? "update" : "create"],
    ...(prev ? [["prev", prev]] : []),
    ...(anchor.root
      ? [
          ["root", anchor.root],
          ["thr", anchor.root],
        ]
      : []),
    ["st", isOpen(safe) ? "open" : "done"],
  ];
  return {
    kind: ARTIFACT_KIND,
    content: JSON.stringify({
      v: SESSION_ITEM_VERSION,
      root: anchor.root,
      ...safe,
    }),
    tags,
  };
}

export type Decoded = Readonly<{
  item: SessionItem;
  root: string | undefined;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown) => typeof value === "string";
const oneOf = (value: unknown, allowed: readonly string[]) =>
  typeof value === "string" && allowed.includes(value);

/** Whether the fields a row reads are there; content is any member's to
 * write, so a row never trusts its shape. */
function shaped(item: Record<string, unknown>): boolean {
  if (![item.seq, item.rev, item.at, item.run].every(isNumber)) return false;
  switch (item.kind) {
    case "run":
      return oneOf(item.state, ["running", "done", "failed", "stopped"]);
    case "assistant":
    case "reasoning":
    case "notice":
      return isString(item.text);
    case "tool":
      return (
        isString(item.call) &&
        isString(item.name) &&
        oneOf(item.status, ["running", "completed", "failed", "canceled"]) &&
        isRecord(item.detail) &&
        isString(item.detail.type)
      );
    case "approval":
      return (
        isString(item.request) &&
        oneOf(item.state, ["pending", "approved", "denied", "expired"]) &&
        oneOf(item.tool, ["bash", "edit", "write"]) &&
        isRecord(item.detail) &&
        isString(item.detail.type)
      );
    case "question":
      return (
        isString(item.request) &&
        isString(item.title) &&
        oneOf(item.state, ["pending", "answered", "cancelled", "expired"]) &&
        oneOf(item.method, ["confirm", "select", "input", "editor"])
      );
    case "todo":
      return Array.isArray(item.entries);
    case "compaction":
      return oneOf(item.state, ["loading", "done"]);
    default:
      return false;
  }
}

/** The item an artifact's content holds, or undefined when it is not one
 * this version reads. */
export function decode(content: string): Decoded | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.v !== SESSION_ITEM_VERSION) return undefined;
  const { v: _version, root, ...item } = value;
  if (!shaped(item)) return undefined;
  return {
    item: item as unknown as SessionItem,
    root: typeof root === "string" ? root : undefined,
  };
}
