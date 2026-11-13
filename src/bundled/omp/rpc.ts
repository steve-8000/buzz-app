// A JSONL client for `omp --mode rpc-ui`: commands go in, and events and the
// questions an extension asks the person (`extension_ui_request`) come out.
// It knows nothing of Buzz; the runtime decides who answers a question.

/** Any frame omp writes: a command response, an event, or a UI request. */
export type Frame = Readonly<Record<string, unknown> & { type: string }>;

/** A question omp asks the person: an approval, a choice or a line of text. */
export type UiRequest = Readonly<{
  id: string;
  method: "confirm" | "select" | "input" | "editor";
  title: string;
  message?: string;
  options?: readonly string[];
  placeholder?: string;
  prefill?: string;
}>;

export type UiAnswer =
  | Readonly<{ confirmed: boolean }>
  | Readonly<{ value: string }>
  | Readonly<{ cancelled: true }>;

/** What a finished agent run left: the last assistant text, or why it failed. */
export type RunEnd = Readonly<{ text: string; error?: string }>;

export type Pipe = Readonly<{
  write(data: string): Promise<void>;
  kill(): Promise<void>;
  exited: Promise<number | null>;
}>;

export type Hooks = Readonly<{
  /** Answers a question; omp waits for it. */
  ask(request: UiRequest): Promise<UiAnswer>;
  /** A question omp gave up on, so its answer is no longer wanted. */
  withdrawn?(id: string): void;
  /** Every other event, such as a tool starting. */
  event?(frame: Frame): void;
  /** The process ended, with its exit code. */
  exited?(code: number | null): void;
  /** A run began, whoever asked for it: a prompt, or omp on its own. */
  started?(): void;
}>;

const QUESTIONS: Record<string, UiRequest["method"]> = {
  confirm: "confirm",
  select: "select",
  input: "input",
  editor: "editor",
};
const RESPONSE_MS = 30_000;
/** omp can begin the next run by itself right after one ends, as for a
 * steering message that came last; a run is over once none follows this soon. */
const SETTLE_MS = 800;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFrame(value: unknown): value is Frame {
  return isRecord(value) && typeof value.type === "string";
}

/** Rejects after `ms`; `stop` cancels the timer. */
function deadline(ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return { promise, stop: () => clearTimeout(timer) };
}

export class OmpRpc {
  private buffer = "";
  private sequence = 0;
  private done = false;
  private readonly responses = new Map<
    string,
    { resolve(frame: Frame): void; reject(error: Error): void }
  >();
  private readonly ends: Array<{
    resolve(end: RunEnd): void;
    reject(error: Error): void;
  }> = [];
  /** The last assistant message omp finished, kept because a long run's
   * `agent_end` is cut to fit the 1 MiB frame limit and may carry none. */
  private streamed: RunEnd | undefined;
  private running = false;
  private settling: ReturnType<typeof setTimeout> | undefined;
  private readonly readied: Promise<void>;
  private ready!: () => void;

  constructor(
    private readonly pipe: Pipe,
    private readonly hooks: Hooks,
  ) {
    this.readied = new Promise((resolve) => {
      this.ready = resolve;
    });
    void pipe.exited.then((code) => {
      this.done = true;
      clearTimeout(this.settling);
      const gone = new Error(`omp exited${code === null ? "" : ` (${code})`}`);
      for (const waiter of this.responses.values()) waiter.reject(gone);
      this.responses.clear();
      for (const waiter of this.ends.splice(0)) waiter.reject(gone);
      this.hooks.exited?.(code);
    });
  }

  /** Stdout data, in pieces of any size. */
  feed(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) return;
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.frame(line);
    }
  }

  /** Resolves once omp has announced it reads commands. */
  async waitReady(timeoutMs = 30_000) {
    const limit = deadline(timeoutMs, "omp did not become ready");
    try {
      await Promise.race([
        this.readied,
        limit.promise,
        this.pipe.exited.then(() => {
          throw new Error("omp exited before it was ready");
        }),
      ]);
    } finally {
      limit.stop();
    }
  }

  /** Sends a command and resolves with its successful response's data. */
  async command<T = unknown>(
    command: Readonly<Record<string, unknown> & { type: string }>,
    timeoutMs = RESPONSE_MS,
  ): Promise<T> {
    if (this.done) throw new Error("omp has exited");
    const id = `c${++this.sequence}`;
    const response = new Promise<Frame>((resolve, reject) => {
      this.responses.set(id, { resolve, reject });
    });
    const limit = deadline(timeoutMs, `omp did not answer ${command.type}`);
    try {
      await this.pipe.write(`${JSON.stringify({ ...command, id })}\n`);
      const frame = await Promise.race([response, limit.promise]);
      if (frame.success !== true)
        throw new Error(String(frame.error ?? `${command.type} failed`));
      return frame.data as T;
    } finally {
      limit.stop();
      this.responses.delete(id);
    }
  }

  /** Resolves when the agent run that is under way, or the next, ends. */
  nextEnd(): Promise<RunEnd> {
    return new Promise((resolve, reject) => {
      if (this.done) reject(new Error("omp has exited"));
      else this.ends.push({ resolve, reject });
    });
  }

  /** An agent run is under way, or may be about to continue by itself. */
  get streaming() {
    return this.running;
  }

  /** Starts a run, or queues the message for the one under way: omp refuses
   * a prompt while it is working, which a run that began by itself can make
   * happen between two messages. */
  async prompt(message: string) {
    try {
      await this.command({ type: "prompt", message });
    } catch (error) {
      if (!/already processing/i.test(String(error))) throw error;
      await this.steer(message);
    }
  }

  steer(message: string) {
    return this.command({ type: "steer", message });
  }

  abort() {
    return this.command({ type: "abort" });
  }

  kill() {
    return this.pipe.kill();
  }

  private frame(line: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isFrame(parsed)) return;
    const frame = parsed;
    switch (frame.type) {
      case "ready":
        this.ready();
        return;
      case "response": {
        const id = typeof frame.id === "string" ? frame.id : "";
        const waiter = this.responses.get(id);
        if (waiter) {
          this.responses.delete(id);
          waiter.resolve(frame);
        }
        return;
      }
      case "extension_ui_request":
        this.question(frame);
        return;
      case "agent_start":
        clearTimeout(this.settling);
        this.settling = undefined;
        this.running = true;
        this.hooks.started?.();
        this.hooks.event?.(frame);
        return;
      case "message_end":
        this.streamed = assistantEnd(frame.message) ?? this.streamed;
        this.hooks.event?.(frame);
        return;
      case "agent_end": {
        // A retry or a reminder goes on by itself: the run has not finished.
        const yielded =
          typeof frame.yielded === "boolean"
            ? frame.yielded
            : frame.isTerminal !== false;
        if (yielded) this.settle(this.streamed ?? runEnd(frame));
        this.hooks.event?.(frame);
        return;
      }
      default:
        this.hooks.event?.(frame);
    }
  }

  private settle(end: RunEnd) {
    clearTimeout(this.settling);
    this.settling = setTimeout(() => {
      this.settling = undefined;
      this.running = false;
      this.streamed = undefined;
      for (const waiter of this.ends.splice(0)) waiter.resolve(end);
    }, SETTLE_MS);
  }

  private question(frame: Frame) {
    const id = typeof frame.id === "string" ? frame.id : "";
    const method = typeof frame.method === "string" ? frame.method : "";
    if (method === "cancel") {
      this.hooks.withdrawn?.(
        typeof frame.targetId === "string" ? frame.targetId : "",
      );
      return;
    }
    const kind = QUESTIONS[method];
    if (!id || !kind) return;
    const request: UiRequest = {
      id,
      method: kind,
      title: typeof frame.title === "string" ? frame.title : "",
      ...(typeof frame.message === "string" ? { message: frame.message } : {}),
      ...(Array.isArray(frame.options)
        ? {
            options: frame.options.filter(
              (option): option is string => typeof option === "string",
            ),
          }
        : {}),
      ...(typeof frame.placeholder === "string"
        ? { placeholder: frame.placeholder }
        : {}),
      ...(typeof frame.prefill === "string" ? { prefill: frame.prefill } : {}),
    };
    const refused: UiAnswer =
      kind === "confirm" ? { confirmed: false } : { cancelled: true };
    void this.hooks.ask(request).then(
      (answer) => this.respond(id, answer),
      () => this.respond(id, refused),
    );
  }

  private respond(id: string, answer: UiAnswer) {
    if (this.done) return;
    void this.pipe
      .write(
        `${JSON.stringify({ type: "extension_ui_response", id, ...answer })}\n`,
      )
      .catch(() => undefined);
  }
}

function assistantEnd(message: unknown): RunEnd | undefined {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = parts
    .map((part: unknown) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("")
    .trim();
  if (message.stopReason === "error")
    return {
      text,
      error:
        typeof message.errorMessage === "string"
          ? message.errorMessage
          : "The run failed.",
    };
  return { text };
}

/** The last assistant text of a finished run, or its failure. */
export function runEnd(frame: Frame): RunEnd {
  const messages = Array.isArray(frame.messages) ? frame.messages : [];
  for (let at = messages.length - 1; at >= 0; at--) {
    const end = assistantEnd(messages[at]);
    if (end) return end;
  }
  return { text: "" };
}

const APPROVE =
  /^(y|yes|ok|okay|approve|approved|allow|go|proceed|승인|허용|예|네|응)$/i;
const DENY =
  /^(n|no|deny|denied|reject|refuse|stop|cancel|거부|취소|아니|아니오|아뇨)$/i;
/** A pick by number, with the owner's own words after it: `1`, `approve 1 …`,
 * `1번으로 …`. */
const LEADING_NUMBER =
  /^(?:(?:approve|approved|ok|okay|yes|승인|허용)[\s,:]+)?(\d+)(?=$|[\s.,:)\-—번])/i;

/** A reply without the mentions of the agent. */
function plain(reply: string) {
  return reply
    .replace(/nostr:(npub|nprofile)1[a-z0-9]+/gi, " ")
    .replace(/(^|\s)@\S+/g, " ")
    .trim();
}

/** A reply that is only an answer word or a number. With no question
 * waiting it was meant for one that is gone, so it is not a message to omp. */
export function isAnswerWord(reply: string) {
  const word = plain(reply).replace(/[.!]+$/, "");
  return APPROVE.test(word) || DENY.test(word) || /^\d+$/.test(word);
}

/** What a person's reply to a question means, or undefined when it is not an
 * answer. Mentions of the agent are not part of the answer. */
export function answerTo(
  request: UiRequest,
  reply: string,
): UiAnswer | undefined {
  const text = plain(reply);
  if (!text) return undefined;
  const word = text.replace(/[.!]+$/, "");
  if (request.method === "confirm") {
    if (APPROVE.test(word)) return { confirmed: true };
    if (DENY.test(word)) return { confirmed: false };
    return undefined;
  }
  if (DENY.test(word)) return { cancelled: true };
  if (request.method === "select") {
    const options = request.options ?? [];
    const lead = LEADING_NUMBER.exec(text)?.[1];
    if (lead !== undefined) {
      const picked = options[Number(lead) - 1];
      return picked === undefined ? undefined : { value: picked };
    }
    const named = options.find(
      (option) => option.toLowerCase() === word.toLowerCase(),
    );
    return named === undefined ? undefined : { value: named };
  }
  return { value: text };
}
