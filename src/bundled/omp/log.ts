// What an omp session has said and done, as log lines the activity bubble
// opens: tool calls, their output as it streams, the reply as it is written.
// It is read off omp's events and kept in memory, so it costs the model nothing
// and starts empty after a reload.

export type LogKind =
  | "tool"
  | "out"
  | "text"
  | "think"
  | "note"
  | "error"
  | "user";
export type LogLine = Readonly<{ kind: LogKind; text: string }>;

/** Lines kept per session; the oldest go first. */
export const LOG_LIMIT = 5000;
/** The log may run this far over before the oldest are trimmed in one go. */
const TRIM_SLACK = 250;
const LINE_LIMIT = 2000;
/** Sessions whose logs are kept, least recently used out first. */
const SESSION_LIMIT = 24;
/** Streaming text reaches the panel this often, not on every delta. */
const FLUSH_MS = 120;

const clip = (text: string) =>
  text.length > LINE_LIMIT ? `${text.slice(0, LINE_LIMIT)}…` : text;

export class SessionLog {
  private rows: LogLine[] = [];
  /** The row a stream is still adding to. */
  private open: number | undefined;
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(readonly title: string) {}

  lines = (): readonly LogLine[] => this.rows;
  snapshot = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Whole lines, one row for each line of `text`. */
  add(kind: LogKind, text: string) {
    this.open = undefined;
    for (const line of text.split("\n")) this.push({ kind, text: clip(line) });
    this.changed();
  }

  /** Text as it arrives: it continues the open line until a newline ends it. */
  stream(kind: LogKind, delta: string) {
    const parts = delta.split("\n");
    parts.forEach((part, at) => {
      if (at > 0) this.open = undefined;
      if (part === "" && at === parts.length - 1) return;
      const row = this.open === undefined ? undefined : this.rows[this.open];
      if (this.open !== undefined && row?.kind === kind)
        this.rows[this.open] = { kind, text: clip(row.text + part) };
      else this.open = this.push({ kind, text: clip(part) });
    });
    this.changed();
  }

  /** Ends the line a stream was adding to. */
  end() {
    this.open = undefined;
  }

  private push(line: LogLine) {
    this.rows.push(line);
    if (this.rows.length > LOG_LIMIT + TRIM_SLACK) {
      const drop = this.rows.length - LOG_LIMIT;
      this.rows.splice(0, drop);
      if (this.open !== undefined)
        this.open = this.open >= drop ? this.open - drop : undefined;
    }
    return this.rows.length - 1;
  }

  private changed() {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.version++;
      for (const listener of this.listeners) listener();
    }, FLUSH_MS);
  }
}

const logs = new Map<string, SessionLog>();

/** A session's log key: its agent and conversation. */
export const logKey = (agent: string, channel: string, root?: string) =>
  `${agent}|${channel}|${root ?? ""}`;

/** The log of a session, made when it first speaks. */
export function sessionLog(key: string, title: string): SessionLog {
  const kept = logs.get(key);
  if (kept) {
    logs.delete(key);
    logs.set(key, kept);
    return kept;
  }
  const made = new SessionLog(title);
  logs.set(key, made);
  for (const old of [...logs.keys()].slice(0, -SESSION_LIMIT)) logs.delete(old);
  return made;
}

export const peekLog = (key: string) => logs.get(key);

const ORIGIN = "https://log.omp.buzz.invalid";
const KEY = /^[0-9a-f]{64}\|[^|]+\|[^|]*$/;

/** A panel link to one session's log. It looks like a link so the host can
 * open it beside the chat. */
export const logTarget = (key: string) =>
  `${ORIGIN}/?key=${encodeURIComponent(key)}`;

export function parseLogTarget(target: string): string | undefined {
  if (!target.startsWith(`${ORIGIN}/?`)) return undefined;
  const key = new URL(target).searchParams.get("key");
  return key && KEY.test(key) ? key : undefined;
}

/** The link to an agent's log for a conversation, when omp kept one: its
 * thread's, or else its channel-level one. */
export function logLinkFor(agent: string, channel: string, root?: string) {
  for (const key of [logKey(agent, channel, root), logKey(agent, channel)])
    if (logs.has(key)) return logTarget(key);
  return undefined;
}
