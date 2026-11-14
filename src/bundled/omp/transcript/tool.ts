// Turns an omp tool call and its result into what a reader of the session
// sees. The shapes follow Paseo's omp provider (Apache-2.0, see LICENSE.paseo),
// reduced to omp 18's tools.
import type { ToolDetail } from "../../../features/agent-session/item";
import { isRecord } from "../rpc";

export type ToolResult = string | Record<string, unknown> | null;

const JSON_LIMIT = 8000;
/** Tools whose result is only text to read, shown under a label. */
const OPAQUE_TEXT_TOOLS: Record<string, true> = {
  ast_edit: true,
  debug: true,
  eval: true,
  github: true,
  checkpoint: true,
  rewind: true,
  context_notes: true,
  new_context: true,
  security_scan: true,
  memory_edit: true,
  retain: true,
  recall: true,
  reflect: true,
  learn: true,
  manage_skill: true,
  yield: true,
  goal: true,
};

export function parseResult(raw: unknown): ToolResult {
  if (typeof raw === "string") return raw;
  return isRecord(raw) ? raw : null;
}

/** Models send `null` for optional arguments; omp treats it as omitted. */
export function omitNull(args: unknown): unknown {
  return isRecord(args)
    ? Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null))
    : args;
}

function first(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && !!value.trim(),
  );
}

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function jsonText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.slice(0, JSON_LIMIT);
  try {
    return JSON.stringify(value, null, 2)?.slice(0, JSON_LIMIT);
  } catch {
    return undefined;
  }
}

function detailsOf(result: ToolResult): Record<string, unknown> | null {
  return isRecord(result) && isRecord(result.details) ? result.details : null;
}

export function textOf(result: ToolResult): string | undefined {
  if (typeof result === "string") return result;
  if (!result) return undefined;
  const direct = first(result.output, result.stdout, result.text);
  if (direct) return direct;
  if (!Array.isArray(result.content)) return undefined;
  const parts = result.content.flatMap((part: unknown) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string"
      ? [part.text]
      : [],
  );
  return parts.length ? parts.join("\n") : undefined;
}

export function failureMessage(result: ToolResult): string {
  const error = detailsOf(result)?.error;
  const message =
    typeof error === "string"
      ? error
      : isRecord(error) && typeof error.message === "string"
        ? error.message
        : undefined;
  if (message) return (message.split("\n", 1)[0] ?? "").slice(0, 240);
  const output = textOf(result);
  const exited = output?.match(
    /(?:Command|Process) exited with code \d+/i,
  )?.[0];
  if (exited) return exited;
  const line = output
    ?.split("\n")
    .find((row) => row.trim())
    ?.trim();
  if (line) return line.slice(0, 240);
  if (isRecord(result)) {
    const code = num(result.exitCode) ?? num(result.code);
    if (code !== undefined) return `Tool exited with code ${code}`;
  }
  return "Tool call failed";
}

export function failed(
  name: string,
  result: ToolResult,
  isError: boolean,
): boolean {
  return (
    isError ||
    (name === "web_search" && typeof detailsOf(result)?.error === "string")
  );
}

const devicePath = (args: unknown) =>
  isRecord(args) &&
  typeof args.path === "string" &&
  args.path.startsWith("xd://")
    ? args.path
    : undefined;
const deviceName = (path: string) =>
  path.slice("xd://".length).split(/[/?#]/, 1)[0] ?? "";

function xdev(result: ToolResult) {
  const value = detailsOf(result)?.xdev;
  if (
    !isRecord(value) ||
    value.mode !== "execute" ||
    typeof value.tool !== "string" ||
    !value.tool.trim()
  )
    return undefined;
  return value as { tool: string; args?: unknown; inner?: unknown };
}

/** The tool's name as a reader knows it: a call through an `xd://` device
 * names the device's tool. */
export function nameOf(name: string, args: unknown, result: ToolResult) {
  const device =
    name === "read" || name === "write" ? devicePath(args) : undefined;
  if (device) return deviceName(device) || name;
  if (name === "write") return xdev(result)?.tool ?? name;
  return name;
}

function patchPath(args: unknown): string | undefined {
  if (!isRecord(args) || typeof args.input !== "string") return undefined;
  return /^\[(?<path>.+?)#[^\]\n]+]/m.exec(args.input)?.groups?.path;
}

function shell(args: Record<string, unknown>, result: ToolResult): ToolDetail {
  const command = typeof args.command === "string" ? args.command : "";
  const code = isRecord(result)
    ? (num(result.exitCode) ?? num(result.code) ?? null)
    : null;
  return { type: "shell", command, output: textOf(result), exitCode: code };
}

function read(args: Record<string, unknown>, result: ToolResult): ToolDetail {
  const path = typeof args.path === "string" ? args.path : "";
  if (path.startsWith("xd://"))
    return {
      type: "plain_text",
      label: deviceName(path),
      text: textOf(result),
    };
  if (/^https?:\/\//.test(path))
    return { type: "fetch", url: path, result: textOf(result) };
  const display = detailsOf(result)?.displayContent;
  return {
    type: "read",
    filePath: path,
    content:
      (isRecord(display) ? first(display.text) : undefined) ?? textOf(result),
    offset: num(args.offset),
    limit: num(args.limit),
  };
}

function edit(args: Record<string, unknown>, result: ToolResult): ToolDetail {
  const details = detailsOf(result);
  const filePath = first(
    details?.path,
    details?.filePath,
    args.path,
    patchPath(args),
  );
  if (!filePath)
    return { type: "unknown", input: jsonText(args), output: jsonText(result) };
  const firstEdit =
    Array.isArray(args.edits) && isRecord(args.edits[0]) ? args.edits[0] : {};
  return {
    type: "edit",
    filePath,
    oldString: first(
      details?.oldText,
      details?.old_string,
      firstEdit.oldText,
      args.old_string,
      args.oldString,
    ),
    newString: first(
      details?.newText,
      details?.new_string,
      firstEdit.newText,
      args.new_string,
      args.newString,
    ),
    unifiedDiff: first(details?.diff),
  };
}

function write(args: Record<string, unknown>, result: ToolResult): ToolDetail {
  if (
    isRecord(result) &&
    isRecord(result.details) &&
    "xdev" in result.details
  ) {
    const call = xdev(result);
    return call
      ? {
          type: "unknown",
          input: jsonText(call.args),
          output: jsonText({ ...result, details: call.inner ?? null }),
        }
      : { type: "unknown", input: jsonText(args), output: jsonText(result) };
  }
  const path = typeof args.path === "string" ? args.path : "";
  if (path.startsWith("xd://"))
    return {
      type: "plain_text",
      label: deviceName(path),
      text: textOf(result),
    };
  return {
    type: "write",
    filePath: path,
    content: typeof args.content === "string" ? args.content : undefined,
  };
}

function search(
  name: "find" | "grep" | "ls",
  args: Record<string, unknown>,
  result: ToolResult,
): ToolDetail {
  const content = textOf(result);
  if (name === "ls")
    return { type: "search", query: first(args.path) ?? "ls", content };
  return {
    type: "search",
    query: first(args.pattern) ?? name,
    toolName: name === "find" ? "search" : "grep",
    content,
  };
}

function wait(result: ToolResult): ToolDetail {
  const text = textOf(result)?.trim();
  const jobs = detailsOf(result)?.jobs;
  const job = Array.isArray(jobs) ? jobs.find(isRecord) : undefined;
  const type = first(job?.type);
  const status = first(job?.status);
  const label = first(job?.label, job?.id);
  return {
    type: "plain_text",
    label:
      type && status && label
        ? `${type} ${status}: ${label}`
        : (text?.split("\n", 1)[0] ?? "Waiting for background work"),
    text: first(job?.resultText, job?.errorText) ?? text,
  };
}

function ask(args: Record<string, unknown>, result: ToolResult): ToolDetail {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const asked = isRecord(questions[0])
    ? first(questions[0].question)
    : undefined;
  const details = detailsOf(result) ?? {};
  const answers = Array.isArray(details.results) ? details.results : [details];
  const lines = answers.flatMap((answer: unknown) => {
    if (!isRecord(answer)) return [];
    const question = first(answer.question);
    const picked = Array.isArray(answer.selectedOptions)
      ? answer.selectedOptions.filter(
          (option): option is string => typeof option === "string",
        )
      : [];
    const response =
      [...picked, first(answer.customInput)].filter(Boolean).join(", ") ||
      "No selection";
    return question ? [`${question}\n${response}`] : [];
  });
  return {
    type: "plain_text",
    label:
      first(details.question, asked, args.question, args.title) ?? "Question",
    text: lines.length ? lines.join("\n\n") : textOf(result),
  };
}

function summary(value: unknown): string | undefined {
  const text = first(value);
  return text
    ?.split("\n")
    .map((line) => line.replace(/^#+\s*(?:Target|Goal|Task)\s*/i, "").trim())
    .find(Boolean);
}

function task(args: Record<string, unknown>): ToolDetail {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  const one = tasks.find(isRecord);
  return {
    type: "sub_agent",
    subAgentType: first(
      one?.name,
      args.name,
      args.agent,
      args.subAgentType,
      args.agentType,
      args.type,
    ),
    description: first(
      args.i,
      summary(one?.task),
      args.description,
      args.task,
      args.prompt,
      args.assignment,
    ),
  };
}

function extended(
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
): ToolDetail | null {
  switch (name) {
    case "yield":
      return {
        type: "plain_text",
        label: "Submitted subagent result",
        text: textOf(result),
      };
    case "wait":
      return wait(result);
    case "web_search":
      return {
        type: "search",
        query: first(args.query) ?? "Web search",
        toolName: "web_search",
        content: textOf(result),
      };
    case "ask":
    case "ask_user":
      return ask(args, result);
    case "glob":
    case "ast_grep":
      return {
        type: "search",
        query: first(args.pattern, args.pat, args.query) ?? name,
        ...(name === "glob" ? { toolName: "glob" as const } : {}),
        content: textOf(result),
      };
    case "think":
      return {
        type: "plain_text",
        label: "Thinking",
        text: first(args.thoughts),
      };
  }
  if (OPAQUE_TEXT_TOOLS[name] !== true) return null;
  const action = first(args.action, args.op, args.operation, args.command);
  const target = first(
    args.name,
    args.goal,
    args.path,
    args.query,
    args.id,
    args.report,
  );
  return {
    type: "plain_text",
    label:
      [action, target].filter(Boolean).join(" ") || name.replaceAll("_", " "),
    text: textOf(result),
  };
}

function device(
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
): ToolDetail | null {
  if (name !== "write" || !devicePath(args)) return null;
  const tool = nameOf(name, args, result);
  if (OPAQUE_TEXT_TOOLS[tool] !== true && tool !== "ast_grep") return null;
  let input: unknown = null;
  try {
    input = JSON.parse(String(args.content));
  } catch {
    input = null;
  }
  return extended(tool, isRecord(input) ? input : {}, result);
}

/** What the call shows: its detail, or none for a tool a reader never sees
 * as a step (the todo list is shown by its own item). */
export function detailOf(
  name: string,
  rawArgs: unknown,
  result: ToolResult,
): ToolDetail | null {
  if (name === "todo") return null;
  const args = omitNull(rawArgs);
  const record = isRecord(args) ? args : {};
  if (name === "task") return task(record);
  const viaDevice = device(name, record, result);
  if (viaDevice) return viaDevice;
  const more = extended(name, record, result);
  if (more) return more;
  switch (name) {
    case "bash":
      return shell(record, result);
    case "read":
      return read(record, result);
    case "edit":
      return edit(record, result);
    case "write":
      return write(record, result);
    case "find":
    case "grep":
    case "ls":
      return search(name, record, result);
  }
  return { type: "unknown", input: jsonText(args), output: jsonText(result) };
}
