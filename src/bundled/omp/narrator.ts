// Turns omp's events into log lines and says what a tool call is doing. It
// reads the stream and nothing else.
import type { SessionLog } from "./log";
import { type Frame, isRecord } from "./rpc";

/** A step names its call in this many characters, enough for a few lines. */
const TARGET_LIMIT = 400;
/** Output lines logged for one call; the session keeps the rest. */
const OUTPUT_LINES = 300;
const COMMAND_LINES = 60;
const RESULT_CHARS = 8000;
const JOB_LIMIT = 20;
const SUBJECTS = [
  "path",
  "file",
  "pattern",
  "query",
  "url",
  "title",
  "description",
] as const;

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const clipTo = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

function describe(args: unknown) {
  if (!isRecord(args)) return {};
  const text = (key: string) => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const command = text("command");
  const subject =
    command ??
    SUBJECTS.map(text).find(Boolean) ??
    (Object.keys(args).length ? JSON.stringify(args) : undefined);
  return { intent: text("i") ?? text("intent"), command, subject };
}

/** What a tool call is doing: the model's own intent and what it acts on. */
export function targetOf(args: unknown): string | undefined {
  const { intent, subject } = describe(args);
  const what = subject && squash(subject);
  const line =
    intent && what ? `${squash(intent)} — ${what}` : (what ?? intent);
  return line ? clipTo(squash(line), TARGET_LIMIT) : undefined;
}

/** The part of `next` that `previous` has not shown: output arrives as the
 * whole tail so far, and the tail's start moves once it is cut. */
function appended(previous: string, next: string) {
  if (next.startsWith(previous)) return next.slice(previous.length);
  const anchor = previous.slice(-200);
  const at = anchor ? next.lastIndexOf(anchor) : -1;
  return at >= 0 ? next.slice(at + anchor.length) : next;
}

export class Narrator {
  private readonly shown = new Map<string, { text: string; lines: number }>();
  private readonly labels = new Map<string, string>();
  private readonly jobs = new Map<string, string>();
  private streamed = false;

  constructor(private readonly log: SessionLog) {}

  /** What a `wait` is waiting for: the background jobs still running. */
  waiting(): string | undefined {
    const running = [...this.jobs]
      .slice(-3)
      .map(([id, label]) => (label ? `${id} ${label}` : id));
    return running.length ? running.join(" · ") : undefined;
  }

  feed(frame: Frame) {
    switch (frame.type) {
      case "agent_start":
        this.log.add("note", "── run started");
        return;
      case "agent_end":
        this.log.add("note", "── run ended");
        return;
      case "message_start":
        this.streamed = false;
        return;
      case "message_update":
        this.update(frame.assistantMessageEvent);
        return;
      case "message_end":
        this.message(frame.message);
        return;
      case "tool_execution_start":
        this.begin(frame);
        return;
      case "tool_execution_update":
        this.output(frame, frame.partialResult);
        return;
      case "tool_execution_end":
        this.finish(frame);
        return;
    }
  }

  private update(event: unknown) {
    if (!isRecord(event)) return;
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (event.type === "text_delta") {
      this.streamed = true;
      this.log.stream("text", delta);
    } else if (event.type === "thinking_delta") this.log.stream("think", delta);
    else if (event.type === "text_end" || event.type === "thinking_end")
      this.log.end();
  }

  private message(message: unknown) {
    if (!isRecord(message)) return;
    const text = textOf(message.content);
    if (message.role === "assistant") {
      this.log.end();
      if (!this.streamed && text.trim()) this.log.add("text", text.trim());
    } else if (message.role === "user") {
      const said = squash(text.replace(/<([a-z-]+)>\n[\s\S]*?\n<\/\1>/g, " "));
      if (said) this.log.add("user", `▷ ${clipTo(said, 600)}`);
    } else if (message.role === "custom" && text.includes("Background job")) {
      for (const [, id] of text.matchAll(/(?:Background job|── Job) (bg_\d+)/g))
        if (id) this.jobs.delete(id);
      this.log.add("note", `⏎ ${clipTo(squash(text), 300)}`);
    }
  }

  private begin(frame: Frame) {
    const name = typeof frame.toolName === "string" ? frame.toolName : "tool";
    const { intent, command, subject } = describe(frame.args);
    this.log.add(
      "tool",
      `▶ ${name}${intent ? ` · ${clipTo(squash(intent), 300)}` : ""}`,
    );
    if (command)
      this.log.add(
        "tool",
        command
          .split("\n")
          .slice(0, COMMAND_LINES)
          .map((line) => `$ ${line}`)
          .join("\n"),
      );
    else if (subject) this.log.add("tool", clipTo(subject, 600));
    if (typeof frame.toolCallId === "string") {
      this.labels.set(
        frame.toolCallId,
        clipTo(squash(intent ?? command ?? ""), 160),
      );
      this.shown.set(frame.toolCallId, { text: "", lines: 0 });
    }
  }

  /** New output of a call since it was last shown, within its line budget. */
  private output(frame: Frame, result: unknown) {
    const id = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
    if (!id || !isRecord(result)) return;
    const text = textOf(result.content);
    const before = this.shown.get(id) ?? { text: "", lines: 0 };
    const chunk = appended(before.text, text);
    let lines = before.lines;
    if (chunk) {
      const room = OUTPUT_LINES - lines;
      if (room > 0) {
        const kept = chunk
          .split("\n")
          .slice(0, room + 1)
          .join("\n");
        const cut = kept.length < chunk.length;
        this.log.stream("out", clipTo(kept, RESULT_CHARS));
        lines += kept.split("\n").length - 1;
        if (cut) {
          this.log.add(
            "note",
            "… more output than the log shows; the session has it",
          );
          lines = OUTPUT_LINES;
        }
      }
    }
    this.shown.set(id, { text, lines });
  }

  private finish(frame: Frame) {
    const name = typeof frame.toolName === "string" ? frame.toolName : "tool";
    const id = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
    const result = isRecord(frame.result) ? frame.result : undefined;
    this.output(frame, result);
    this.log.end();
    const details = result && isRecord(result.details) ? result.details : {};
    const job = isRecord(details.async) ? details.async : undefined;
    if (job && typeof job.jobId === "string" && job.state === "running") {
      this.jobs.set(job.jobId, this.labels.get(id) ?? "");
      for (const old of [...this.jobs.keys()].slice(0, -JOB_LIMIT))
        this.jobs.delete(old);
      this.log.add("note", `⏵ background job ${job.jobId}`);
    }
    if (name === "wait" && result)
      for (const [, jobId] of textOf(result.content).matchAll(
        /### (bg_\d+) \[[^\]]*\] — (?:completed|failed|cancelled|killed)/g,
      ))
        if (jobId) this.jobs.delete(jobId);
    const seconds =
      typeof details.wallTimeMs === "number"
        ? ` ${(details.wallTimeMs / 1000).toFixed(1)}s`
        : "";
    if (frame.isError === true || result?.isError === true)
      this.log.add("error", `✗ ${name} failed${seconds}`);
    else this.log.add("note", `◀ ${name}${seconds}`);
    this.shown.delete(id);
    this.labels.delete(id);
  }
}
