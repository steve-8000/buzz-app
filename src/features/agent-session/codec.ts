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
  type ToolDetail,
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
const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined => allowed.find((candidate) => candidate === value);

/** A tool's detail, rebuilt field by field: any member can write its text. */
function detailOf(value: unknown): ToolDetail | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case "shell":
      return typeof value.command === "string"
        ? {
            type: "shell",
            command: value.command,
            output: text(value.output),
            exitCode: value.exitCode === null ? null : count(value.exitCode),
          }
        : undefined;
    case "read":
      return typeof value.filePath === "string"
        ? {
            type: "read",
            filePath: value.filePath,
            content: text(value.content),
            offset: count(value.offset),
            limit: count(value.limit),
          }
        : undefined;
    case "edit":
      return typeof value.filePath === "string"
        ? {
            type: "edit",
            filePath: value.filePath,
            oldString: text(value.oldString),
            newString: text(value.newString),
            unifiedDiff: text(value.unifiedDiff),
          }
        : undefined;
    case "write":
      return typeof value.filePath === "string"
        ? {
            type: "write",
            filePath: value.filePath,
            content: text(value.content),
          }
        : undefined;
    case "search":
      return typeof value.query === "string"
        ? {
            type: "search",
            query: value.query,
            toolName: oneOf(value.toolName, [
              "search",
              "grep",
              "glob",
              "web_search",
            ]),
            content: text(value.content),
          }
        : undefined;
    case "fetch":
      return typeof value.url === "string"
        ? { type: "fetch", url: value.url, result: text(value.result) }
        : undefined;
    case "sub_agent":
      return {
        type: "sub_agent",
        subAgentType: text(value.subAgentType),
        description: text(value.description),
      };
    case "plain_text":
      return {
        type: "plain_text",
        label: text(value.label),
        text: text(value.text),
      };
    case "unknown":
      return {
        type: "unknown",
        input: text(value.input),
        output: text(value.output),
      };
    default:
      return undefined;
  }
}

/** The item a record describes, rebuilt from the fields a row reads, or
 * undefined when one it needs is missing. Content is any member's to write,
 * so no row ever sees a value of the wrong type. */
function sanitize(item: Record<string, unknown>): SessionItem | undefined {
  const seq = count(item.seq);
  const rev = count(item.rev);
  const at = count(item.at);
  const run = count(item.run);
  if (
    seq === undefined ||
    rev === undefined ||
    at === undefined ||
    run === undefined
  )
    return undefined;
  const base = { seq, rev, at, end: count(item.end), run };
  const kind = item.kind;
  switch (kind) {
    case "run": {
      const state = oneOf(item.state, ["running", "done", "failed", "stopped"]);
      return state
        ? {
            kind,
            ...base,
            state,
            trigger: text(item.trigger),
            reply: text(item.reply),
            error: text(item.error),
            prompt: text(item.prompt),
          }
        : undefined;
    }
    case "assistant":
    case "reasoning":
      return typeof item.text === "string"
        ? {
            kind,
            ...base,
            text: item.text,
            streaming: item.streaming === true ? true : undefined,
          }
        : undefined;
    case "tool": {
      const status = oneOf(item.status, [
        "running",
        "completed",
        "failed",
        "canceled",
      ]);
      const detail = detailOf(item.detail);
      return typeof item.call === "string" &&
        typeof item.name === "string" &&
        status &&
        detail
        ? {
            kind,
            ...base,
            call: item.call,
            name: item.name,
            status,
            detail,
            intent: text(item.intent),
            error: text(item.error),
          }
        : undefined;
    }
    case "approval": {
      const state = oneOf(item.state, [
        "pending",
        "approved",
        "denied",
        "expired",
      ]);
      const detail = detailOf(item.detail);
      return typeof item.request === "string" &&
        typeof item.tool === "string" &&
        state &&
        detail
        ? {
            kind,
            ...base,
            request: item.request,
            state,
            tool: item.tool,
            detail,
            grant: text(item.grant),
            description: text(item.description),
            message: text(item.message),
          }
        : undefined;
    }
    case "question": {
      const state = oneOf(item.state, [
        "pending",
        "answered",
        "cancelled",
        "expired",
      ]);
      const method = oneOf(item.method, [
        "confirm",
        "select",
        "input",
        "editor",
      ]);
      return typeof item.request === "string" &&
        typeof item.title === "string" &&
        state &&
        method
        ? {
            kind,
            ...base,
            request: item.request,
            state,
            method,
            title: item.title,
            text: text(item.text),
            options:
              Array.isArray(item.options) &&
              item.options.every((option) => typeof option === "string")
                ? (item.options as string[])
                : undefined,
            answer: text(item.answer),
            message: text(item.message),
          }
        : undefined;
    }
    case "todo":
      return Array.isArray(item.entries)
        ? {
            kind,
            ...base,
            entries: item.entries.flatMap((entry: unknown) =>
              isRecord(entry) && typeof entry.text === "string"
                ? [
                    {
                      text: entry.text,
                      status:
                        oneOf(entry.status, [
                          "pending",
                          "in_progress",
                          "completed",
                        ]) ?? "pending",
                    },
                  ]
                : [],
            ),
          }
        : undefined;
    case "notice":
      return typeof item.text === "string"
        ? {
            kind,
            ...base,
            level: oneOf(item.level, ["info", "warning", "error"]) ?? "info",
            text: item.text,
          }
        : undefined;
    case "compaction": {
      const state = oneOf(item.state, ["loading", "done"]);
      return state
        ? {
            kind,
            ...base,
            state,
            trigger: oneOf(item.trigger, ["auto", "manual"]) ?? "auto",
            tokens: count(item.tokens),
          }
        : undefined;
    }
    default:
      return undefined;
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
  const { v: _version, root, ...fields } = value;
  const item = sanitize(fields);
  if (!item) return undefined;
  return { item, root: typeof root === "string" ? root : undefined };
}
