// The shared transcript of one agent session: what the agent said and did, as
// items every member of the conversation can read. An item is rewritten as it
// changes, so `rev` says which copy is newer.

export const SESSION_ITEM_TYPE = "gram.session.item";
export const SESSION_ITEM_VERSION = 1;

export type ToolStatus = "running" | "completed" | "failed" | "canceled";

export type ToolDetail =
  | {
      type: "shell";
      command: string;
      output?: string | undefined;
      exitCode?: number | null | undefined;
    }
  | {
      type: "read";
      filePath: string;
      content?: string | undefined;
      offset?: number | undefined;
      limit?: number | undefined;
    }
  | {
      type: "edit";
      filePath: string;
      oldString?: string | undefined;
      newString?: string | undefined;
      unifiedDiff?: string | undefined;
    }
  | { type: "write"; filePath: string; content?: string | undefined }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search" | undefined;
      content?: string | undefined;
    }
  | { type: "fetch"; url: string; result?: string | undefined }
  | {
      type: "sub_agent";
      subAgentType?: string | undefined;
      description?: string | undefined;
    }
  | {
      type: "plain_text";
      label?: string | undefined;
      text?: string | undefined;
    }
  | {
      type: "unknown";
      input?: string | undefined;
      output?: string | undefined;
    };

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoEntry = Readonly<{ text: string; status: TodoStatus }>;

export type RunState = "running" | "done" | "failed" | "stopped";
export type ApprovalState = "pending" | "approved" | "denied" | "expired";
export type QuestionState = "pending" | "answered" | "cancelled" | "expired";
export type QuestionMethod = "confirm" | "select" | "input" | "editor";

type Base = Readonly<{
  /** Place in the thread; items sort by it. Unique per thread. */
  seq: number;
  /** 1 when first written, then one more for every rewrite. */
  rev: number;
  /** When the item began, in milliseconds. */
  at: number;
  /** When it finished, once it has. */
  end?: number | undefined;
  /** The `seq` of the run it belongs to; a run's own `run` is its `seq`. */
  run: number;
}>;

export type RunItem = Base &
  Readonly<{
    kind: "run";
    state: RunState;
    /** The message that asked for the run. */
    trigger?: string | undefined;
    /** The message that posted the run's answer. */
    reply?: string | undefined;
    error?: string | undefined;
  }>;
export type TextItem = Base &
  Readonly<{
    kind: "assistant" | "reasoning";
    text: string;
    streaming?: true | undefined;
  }>;
export type ToolItem = Base &
  Readonly<{
    kind: "tool";
    call: string;
    name: string;
    status: ToolStatus;
    detail: ToolDetail;
    /** What the model said it was doing. */
    intent?: string | undefined;
    error?: string | undefined;
  }>;
export type ApprovalItem = Base &
  Readonly<{
    kind: "approval";
    request: string;
    state: ApprovalState;
    tool: "bash" | "edit" | "write";
    detail: ToolDetail;
    description?: string | undefined;
    /** The message that asks the same question in the conversation. */
    message?: string | undefined;
  }>;
export type QuestionItem = Base &
  Readonly<{
    kind: "question";
    request: string;
    state: QuestionState;
    method: QuestionMethod;
    title: string;
    text?: string | undefined;
    options?: readonly string[] | undefined;
    answer?: string | undefined;
    message?: string | undefined;
  }>;
export type TodoItem = Base &
  Readonly<{ kind: "todo"; entries: readonly TodoEntry[] }>;
export type NoticeItem = Base &
  Readonly<{
    kind: "notice";
    level: "info" | "warning" | "error";
    text: string;
  }>;
export type CompactionItem = Base &
  Readonly<{
    kind: "compaction";
    state: "loading" | "done";
    trigger: "auto" | "manual";
    tokens?: number | undefined;
  }>;

export type SessionItem =
  | RunItem
  | TextItem
  | ToolItem
  | ApprovalItem
  | QuestionItem
  | TodoItem
  | NoticeItem
  | CompactionItem;

/** An item still waiting on something, which a restart leaves behind. */
export function isOpen(item: SessionItem): boolean {
  switch (item.kind) {
    case "run":
      return item.state === "running";
    case "assistant":
    case "reasoning":
      return item.streaming === true;
    case "tool":
      return item.status === "running";
    case "approval":
    case "question":
      return item.state === "pending";
    case "compaction":
      return item.state === "loading";
    default:
      return false;
  }
}

/** The item as a restart finds it: no longer waiting. */
export function interrupted(item: SessionItem, at: number): SessionItem {
  const next = { rev: item.rev + 1, end: at };
  switch (item.kind) {
    case "run":
      return { ...item, ...next, state: "stopped" };
    case "assistant":
    case "reasoning": {
      const { streaming: _streaming, ...rest } = item;
      return { ...rest, ...next };
    }
    case "tool":
      return { ...item, ...next, status: "canceled" };
    case "approval":
      return { ...item, ...next, state: "expired" };
    case "question":
      return { ...item, ...next, state: "cancelled" };
    case "compaction":
      return { ...item, ...next, state: "done" };
    default:
      return item;
  }
}

/** Items in the order they happened. */
export function bySeq(left: SessionItem, right: SessionItem) {
  return left.seq - right.seq;
}

const FILE_CHARS = 4000;
const OUTPUT_CHARS = 6000;
const DIFF_CHARS = 12000;
const TEXT_CHARS = 24000;
const THOUGHT_CHARS = 8000;
const NOTE_CHARS = 4000;
const JSON_CHARS = 3000;

const head = (text: string, limit: number) =>
  text.length > limit
    ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`
    : text;
const tail = (text: string, limit: number) =>
  text.length > limit
    ? `… (${text.length - limit} earlier characters)\n${text.slice(-limit)}`
    : text;

const opt = <T>(value: T | undefined, map: (value: T) => T) =>
  value === undefined ? undefined : map(value);

function boundDetail(detail: ToolDetail, scale: number): ToolDetail {
  const at = (chars: number) => Math.max(200, Math.floor(chars * scale));
  switch (detail.type) {
    case "shell":
      return {
        ...detail,
        command: head(detail.command, at(FILE_CHARS)),
        output: opt(detail.output, (text) => tail(text, at(OUTPUT_CHARS))),
      };
    case "read":
      return {
        ...detail,
        content: opt(detail.content, (text) => head(text, at(FILE_CHARS))),
      };
    case "edit":
      return {
        ...detail,
        oldString: opt(detail.oldString, (text) => head(text, at(FILE_CHARS))),
        newString: opt(detail.newString, (text) => head(text, at(FILE_CHARS))),
        unifiedDiff: opt(detail.unifiedDiff, (text) =>
          head(text, at(DIFF_CHARS)),
        ),
      };
    case "write":
      return {
        ...detail,
        content: opt(detail.content, (text) => head(text, at(FILE_CHARS))),
      };
    case "search":
      return {
        ...detail,
        content: opt(detail.content, (text) => head(text, at(FILE_CHARS))),
      };
    case "fetch":
      return {
        ...detail,
        result: opt(detail.result, (text) => head(text, at(FILE_CHARS))),
      };
    case "plain_text":
      return {
        ...detail,
        text: opt(detail.text, (text) => head(text, at(NOTE_CHARS))),
      };
    case "unknown":
      return {
        ...detail,
        input: opt(detail.input, (text) => head(text, at(JSON_CHARS))),
        output: opt(detail.output, (text) => head(text, at(JSON_CHARS))),
      };
    default:
      return detail;
  }
}

function boundOnce(item: SessionItem, scale: number): SessionItem {
  const at = (chars: number) => Math.max(200, Math.floor(chars * scale));
  switch (item.kind) {
    case "assistant":
      return { ...item, text: head(item.text, at(TEXT_CHARS)) };
    case "reasoning":
      return { ...item, text: tail(item.text, at(THOUGHT_CHARS)) };
    case "tool":
      return { ...item, detail: boundDetail(item.detail, scale) };
    case "approval":
      return { ...item, detail: boundDetail(item.detail, scale) };
    case "notice":
      return { ...item, text: head(item.text, at(NOTE_CHARS)) };
    case "question":
      return {
        ...item,
        text: opt(item.text, (text) => head(text, at(NOTE_CHARS))),
      };
    default:
      return item;
  }
}

const encoder = new TextEncoder();
/** An item's content must fit one event; the relay refuses more than 64 KiB
 * from an agent. */
export const ITEM_BYTES = 56 * 1024;

/** The item cut down so that its JSON fits one event. */
export function bound(item: SessionItem, limit = ITEM_BYTES): SessionItem {
  let scale = 1;
  for (;;) {
    const next = boundOnce(item, scale);
    if (encoder.encode(JSON.stringify(next)).length <= limit || scale < 0.02)
      return next;
    scale /= 2;
  }
}
