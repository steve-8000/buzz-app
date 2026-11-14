// Turns the frames omp writes into the items of a session's transcript. It
// reads the stream and nothing else: who sees the items, and where they are
// kept, is not its concern.
import {
  type ApprovalItem,
  bound,
  type CompactionItem,
  type NoticeItem,
  type QuestionItem,
  type RunItem,
  type RunState,
  type SessionItem,
  type TextItem,
  type TodoEntry,
  type TodoItem,
  type ToolItem,
} from "../../../features/agent-session/item";
import { type Frame, isRecord, type UiRequest } from "../rpc";
import {
  approvalOf,
  delayText,
  goalText,
  noticeOf,
  todoOfReminder,
  todoOfResult,
} from "./notes";
import { clipTo, intentOf, squash } from "./target";
import {
  detailOf,
  failed,
  failureMessage,
  nameOf,
  parseResult,
  textOf,
} from "./tool";

/** Streamed text reaches readers at most this often. */
const STREAM_MS = 120;
const JOB_LIMIT = 20;
const LABEL_LIMIT = 160;

export type Outcome =
  | "approved"
  | "denied"
  | "answered"
  | "cancelled"
  | "expired";

type Tracked = { name: string; args: unknown; seq?: number | undefined };

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

function contentText(content: unknown): string {
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

export class OmpTranscriptBuilder {
  private last = 0;
  private run: RunItem | undefined;
  private text: TextItem | undefined;
  private readonly streamed = new Set<TextItem["kind"]>();
  private todo: TodoItem | undefined;
  private compaction: CompactionItem | undefined;
  private retry: NoticeItem | undefined;
  private readonly tools = new Map<string, Tracked>();
  private readonly open = new Map<number, ToolItem>();
  private readonly requests = new Map<string, ApprovalItem | QuestionItem>();
  private readonly labels = new Map<string, string>();
  private readonly jobs = new Map<string, string>();
  private readonly dirty = new Map<number, SessionItem>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly emit: (item: SessionItem) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** What a `wait` is waiting for: the background jobs still running. */
  waiting(): string | undefined {
    const running = [...this.jobs]
      .slice(-3)
      .map(([id, label]) => (label ? `${id} ${label}` : id));
    return running.length ? running.join(" · ") : undefined;
  }

  /** A run begins; what follows belongs to it. */
  beginRun(trigger?: string) {
    if (this.run) this.endRun({ state: "done" });
    const seq = this.nextSeq();
    this.todo = undefined;
    this.streamed.clear();
    this.run = this.put({
      kind: "run",
      seq,
      run: seq,
      rev: 0,
      at: this.now(),
      state: "running",
      trigger,
    });
  }

  /** The run is over: whatever was still going is closed with it. */
  endRun(result: {
    state: Exclude<RunState, "running">;
    error?: string | undefined;
    reply?: string | undefined;
  }) {
    const run = this.run;
    if (!run) return;
    const at = this.now();
    this.closeText();
    for (const tool of this.open.values())
      this.put({ ...tool, status: "canceled", end: at });
    this.open.clear();
    this.tools.clear();
    if (this.compaction?.state === "loading")
      this.compaction = this.put({
        ...this.compaction,
        state: "done",
        end: at,
      });
    this.compaction = undefined;
    this.retry = undefined;
    this.run = undefined;
    this.put({
      ...run,
      state: result.state,
      end: at,
      error: result.error,
      reply: result.reply ?? run.reply,
    });
    this.flush();
  }

  /** omp asks the person: an approval card or a question. */
  ask(request: UiRequest) {
    const approval = approvalOf(request);
    const base = this.stamp();
    const item = approval
      ? this.put<ApprovalItem>({
          ...base,
          kind: "approval",
          request: request.id,
          state: "pending",
          tool: approval.tool,
          detail: approval.detail,
          description: approval.description,
        })
      : this.put<QuestionItem>({
          ...base,
          kind: "question",
          request: request.id,
          state: "pending",
          method: request.method,
          title: request.title,
          text: request.message,
          options: request.options,
        });
    this.requests.set(request.id, item);
  }

  /** The message that asks the same question in the conversation. */
  asked(id: string, message: string) {
    const item = this.requests.get(id);
    if (item) this.requests.set(id, this.put({ ...item, message }));
  }

  /** The question is settled. */
  answered(id: string, outcome: Outcome, answer?: string) {
    const item = this.requests.get(id);
    if (!item) return;
    this.requests.delete(id);
    const end = this.now();
    if (item.kind === "approval")
      this.put({
        ...item,
        end,
        state:
          outcome === "approved"
            ? "approved"
            : outcome === "denied"
              ? "denied"
              : "expired",
      });
    else
      this.put({
        ...item,
        end,
        state:
          outcome === "answered" ||
          outcome === "approved" ||
          outcome === "denied"
            ? "answered"
            : outcome === "expired"
              ? "expired"
              : "cancelled",
        answer: answer === undefined ? undefined : clipTo(answer, 500),
      });
  }

  feed(frame: Frame) {
    switch (frame.type) {
      case "agent_start":
        this.ensureRun();
        return;
      case "message_start":
        this.closeText();
        this.streamed.clear();
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
        this.progress(frame);
        return;
      case "tool_execution_end":
        this.finish(frame);
        return;
      case "compaction_start":
      case "auto_compaction_start":
        this.compact("loading", frame);
        return;
      case "compaction_end":
      case "auto_compaction_end":
        this.compact("done", frame);
        return;
      case "auto_retry_start":
        this.retrying(frame);
        return;
      case "auto_retry_end":
        this.retried(frame);
        return;
      case "retry_fallback_applied":
        this.notice(
          "info",
          `Switched ${str(frame.role) ?? "model"}: ${str(frame.from) ?? "?"} → ${str(frame.to) ?? "?"}`,
        );
        return;
      case "notice": {
        const text = str(frame.message);
        const level = frame.level;
        if (text)
          this.notice(
            level === "warning" || level === "error" ? level : "info",
            text,
          );
        return;
      }
      case "goal_updated":
        this.notice("info", goalText(frame));
        return;
      case "todo_reminder": {
        const entries = todoOfReminder(frame.todos);
        if (entries) this.setTodo(entries);
        return;
      }
    }
  }

  /** Sends what is waiting to its readers now. */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const items = [...this.dirty.values()];
    this.dirty.clear();
    for (const item of items) this.emit(bound(item));
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty.clear();
  }

  private nextSeq() {
    this.last = Math.max(this.last + 1, this.now());
    return this.last;
  }

  private ensureRun() {
    if (!this.run) this.beginRun();
  }

  private stamp() {
    this.ensureRun();
    const seq = this.nextSeq();
    return { seq, rev: 0, at: this.now(), run: this.run?.seq ?? seq };
  }

  /** Records a new revision of the item and sends it on, at once or soon. */
  private put<T extends SessionItem>(item: T, soon = false): T {
    const next = { ...item, rev: item.rev + 1 };
    this.dirty.set(next.seq, next);
    if (soon) this.timer ??= setTimeout(() => this.flush(), STREAM_MS);
    else this.flush();
    return next;
  }

  private notice(level: NoticeItem["level"], text: string) {
    return this.put<NoticeItem>({
      ...this.stamp(),
      kind: "notice",
      level,
      text,
    });
  }

  private setTodo(entries: readonly TodoEntry[]) {
    this.todo = this.todo
      ? this.put({ ...this.todo, entries })
      : this.put<TodoItem>({ ...this.stamp(), kind: "todo", entries });
  }

  private closeText() {
    const text = this.text;
    if (!text) return;
    this.text = undefined;
    const { streaming: _streaming, ...rest } = text;
    this.put({ ...rest, end: this.now() });
  }

  private append(kind: TextItem["kind"], delta: string) {
    if (!delta) return;
    this.streamed.add(kind);
    if (this.text?.kind !== kind) this.closeText();
    this.text = this.text
      ? this.put({ ...this.text, text: this.text.text + delta }, true)
      : this.put<TextItem>(
          { ...this.stamp(), kind, text: delta, streaming: true },
          true,
        );
  }

  private finishText(kind: TextItem["kind"], content: unknown) {
    const full = str(content);
    if (
      full &&
      (this.text?.kind !== kind || full.length > this.text.text.length)
    ) {
      if (this.text?.kind !== kind) this.closeText();
      this.text = this.text
        ? this.put({ ...this.text, text: full })
        : this.put<TextItem>({
            ...this.stamp(),
            kind,
            text: full,
            streaming: true,
          });
      this.streamed.add(kind);
    }
    if (this.text?.kind === kind) this.closeText();
  }

  private update(event: unknown) {
    if (!isRecord(event)) return;
    const delta = str(event.delta) ?? "";
    switch (event.type) {
      case "text_start":
      case "thinking_start":
        this.closeText();
        return;
      case "text_delta":
        this.append("assistant", delta);
        return;
      case "thinking_delta":
        this.append("reasoning", delta);
        return;
      case "text_end":
        this.finishText("assistant", event.content);
        return;
      case "thinking_end":
        this.finishText("reasoning", event.content);
        return;
    }
  }

  private message(message: unknown) {
    if (!isRecord(message)) return;
    if (message.role === "assistant") {
      this.closeText();
      if (Array.isArray(message.content))
        for (const part of message.content) {
          if (!isRecord(part)) continue;
          const reasoning = part.type === "thinking";
          const kind = reasoning ? "reasoning" : "assistant";
          if (this.streamed.has(kind)) continue;
          const text = reasoning
            ? (str(part.thinking) ?? str(part.text))
            : part.type === "text"
              ? str(part.text)
              : undefined;
          if (text?.trim())
            this.put<TextItem>({
              ...this.stamp(),
              kind,
              text: text.trim(),
              end: this.now(),
            });
        }
      return;
    }
    if (message.role !== "custom" || message.display === false) return;
    if (message.customType === "skill-prompt") return;
    const text = contentText(message.content);
    if (!text.trim()) return;
    for (const [, id] of text.matchAll(/(?:Background job|── Job) (bg_\d+)/g))
      if (id) this.jobs.delete(id);
    const note = noticeOf(text);
    this.notice(note.level, note.text);
  }

  private begin(frame: Frame) {
    const call = str(frame.toolCallId);
    if (!call || this.tools.has(call)) return;
    const name = str(frame.toolName) ?? "tool";
    this.closeText();
    const said = str(frame.intent)?.trim();
    const intent = said ? squash(said) : intentOf(frame.args);
    const command =
      isRecord(frame.args) && typeof frame.args.command === "string"
        ? frame.args.command
        : "";
    this.labels.set(call, clipTo(squash(intent ?? command), LABEL_LIMIT));
    const detail = detailOf(name, frame.args, null);
    if (!detail) {
      this.tools.set(call, { name, args: frame.args });
      return;
    }
    const item = this.put<ToolItem>({
      ...this.stamp(),
      kind: "tool",
      call,
      name: nameOf(name, frame.args, null),
      status: "running",
      detail,
      intent,
    });
    this.open.set(item.seq, item);
    this.tools.set(call, { name, args: frame.args, seq: item.seq });
  }

  private progress(frame: Frame) {
    const tracked = this.tools.get(str(frame.toolCallId) ?? "");
    const item =
      tracked?.seq === undefined ? undefined : this.open.get(tracked.seq);
    if (!tracked || !item) return;
    const result = parseResult(frame.partialResult);
    const detail = detailOf(tracked.name, tracked.args, result);
    if (!detail) return;
    this.open.set(item.seq, this.put({ ...item, detail }, true));
  }

  private finish(frame: Frame) {
    const call = str(frame.toolCallId) ?? "";
    const tracked = this.tools.get(call) ?? {
      name: str(frame.toolName) ?? "tool",
      args: undefined,
    };
    this.tools.delete(call);
    const result = parseResult(frame.result);
    const details =
      isRecord(frame.result) && isRecord(frame.result.details)
        ? frame.result.details
        : {};
    const job = isRecord(details.async) ? details.async : undefined;
    if (job && typeof job.jobId === "string" && job.state === "running") {
      this.jobs.set(job.jobId, this.labels.get(call) ?? "");
      for (const old of [...this.jobs.keys()].slice(0, -JOB_LIMIT))
        this.jobs.delete(old);
    }
    if (tracked.name === "wait")
      for (const [, id] of textOf(result)?.matchAll(
        /### (bg_\d+) \[[^\]]*\] — (?:completed|failed|cancelled|killed)/g,
      ) ?? [])
        if (id) this.jobs.delete(id);
    this.labels.delete(call);
    const item =
      tracked.seq === undefined ? undefined : this.open.get(tracked.seq);
    if (item) {
      this.open.delete(item.seq);
      const isError =
        frame.isError === true ||
        (isRecord(frame.result) && frame.result.isError === true);
      const bad = failed(tracked.name, result, isError);
      this.put({
        ...item,
        name: nameOf(tracked.name, tracked.args, result),
        status: bad ? "failed" : "completed",
        detail: detailOf(tracked.name, tracked.args, result) ?? item.detail,
        end: this.now(),
        error: bad ? failureMessage(result) : undefined,
      });
    }
    if (tracked.name === "todo") {
      const entries = todoOfResult(details);
      if (entries) this.setTodo(entries);
    }
  }

  private compact(state: CompactionItem["state"], frame: Frame) {
    if (state === "loading") {
      if (this.compaction?.state === "loading") return;
      this.compaction = this.put<CompactionItem>({
        ...this.stamp(),
        kind: "compaction",
        state,
        trigger: frame.reason === "manual" ? "manual" : "auto",
      });
      return;
    }
    const tokens =
      isRecord(frame.result) && typeof frame.result.tokensBefore === "number"
        ? frame.result.tokensBefore
        : undefined;
    this.compaction = this.compaction
      ? this.put({ ...this.compaction, state, end: this.now(), tokens })
      : this.put<CompactionItem>({
          ...this.stamp(),
          kind: "compaction",
          state,
          trigger: frame.reason === "manual" ? "manual" : "auto",
          tokens,
        });
    this.compaction = undefined;
  }

  private retrying(frame: Frame) {
    const attempt = typeof frame.attempt === "number" ? frame.attempt : 0;
    const max = typeof frame.maxAttempts === "number" ? frame.maxAttempts : 0;
    const delay = typeof frame.delayMs === "number" ? frame.delayMs : 0;
    this.retry = this.notice(
      "warning",
      `Retrying ${attempt}/${max} in ${delayText(delay)}: ${str(frame.errorMessage) ?? "request failed"}`,
    );
  }

  private retried(frame: Frame) {
    const ok = frame.success === true;
    const attempt = typeof frame.attempt === "number" ? frame.attempt : 0;
    const level: NoticeItem["level"] = ok ? "info" : "error";
    const text = ok
      ? `Recovered after ${attempt} ${attempt === 1 ? "retry" : "retries"}`
      : `Retry failed: ${str(frame.finalError) ?? "request failed"}`;
    if (this.retry) this.put({ ...this.retry, level, text, end: this.now() });
    else this.notice(level, text);
    this.retry = undefined;
  }
}
