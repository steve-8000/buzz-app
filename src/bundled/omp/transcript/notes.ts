// Reads omp's approvals, todo lists, system notices and goals. The formats
// follow Paseo's omp provider (Apache-2.0, see LICENSE.paseo).
import type {
  TodoEntry,
  ToolDetail,
} from "../../../features/agent-session/item";
import { isRecord, type UiRequest } from "../rpc";
import { clipTo, squash } from "./target";

export const APPROVE = "Approve";
export const DENY = "Deny";
const TITLE_PREFIX = "Allow tool: ";

export type Approval = Readonly<{
  tool: string;
  detail: ToolDetail;
  description: string;
}>;

const stripped = (line: string | undefined, prefix: string) => {
  const trimmed = line?.trim();
  return trimmed?.startsWith(prefix) ? trimmed.slice(prefix.length) : undefined;
};

/** What omp asks to approve, when the question is a tool approval: a select
 * of exactly Approve and Deny whose title names the tool. */
export function approvalOf(request: UiRequest): Approval | undefined {
  const { options } = request;
  if (
    request.method !== "select" ||
    options?.length !== 2 ||
    options[0] !== APPROVE ||
    options[1] !== DENY
  )
    return undefined;
  const title = request.title;
  const split = title.search(/\r?\n/);
  const first = (split < 0 ? title : title.slice(0, split)).trim();
  if (!first.startsWith(TITLE_PREFIX)) return undefined;
  const tool = first.slice(TITLE_PREFIX.length).trim();
  const body = split < 0 ? "" : title.slice(split).replace(/^\r?\n/, "");
  const lines = body.split(/\r?\n/);
  if (!tool) return undefined;
  const specific = (():
    | Pick<Approval, "detail" | "description">
    | undefined => {
    if (tool === "bash") {
      const command = /(?:^|\r?\n)[\t ]*Command:[\t ]?(.*)$/s.exec(body)?.[1];
      return command
        ? {
            detail: { type: "shell", command },
            description: `Command: ${command}`,
          }
        : undefined;
    }
    if (tool === "edit") {
      const filePath = lines
        .map((line) => stripped(line, "File:")?.trim())
        .find(Boolean);
      return filePath
        ? {
            detail: { type: "edit", filePath },
            description: `File: ${filePath}`,
          }
        : undefined;
    }
    if (tool === "write") {
      const at = lines.findIndex((line) => line.trim().startsWith("Path:"));
      const filePath = stripped(lines[at], "Path:")?.trim();
      const content = lines.findIndex(
        (line, index) => index > at && line.trim() === "Content:",
      );
      return at >= 0 && filePath && content >= 0
        ? {
            detail: {
              type: "write",
              filePath,
              content: lines.slice(content + 1).join("\n"),
            },
            description: `Path: ${filePath}`,
          }
        : undefined;
    }
    return undefined;
  })();
  // Any other tool asks the same way, with its own lines under the header.
  return {
    tool,
    ...(specific ?? {
      detail: {
        type: "plain_text",
        label: tool,
        text: body.trim() || undefined,
      },
      description: lines.find((line) => line.trim())?.trim() ?? tool,
    }),
  };
}

function entriesOf(tasks: unknown): TodoEntry[] {
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((task: unknown): TodoEntry[] => {
    if (!isRecord(task) || typeof task.content !== "string") return [];
    const status = task.status;
    if (status === "abandoned") return [];
    const blocker =
      typeof task.blocker === "string" && task.blocker
        ? `blocked: ${task.blocker}`
        : "blocked";
    return [
      {
        text:
          status === "blocked" ? `${task.content} (${blocker})` : task.content,
        status:
          status === "completed"
            ? "completed"
            : status === "in_progress"
              ? "in_progress"
              : "pending",
      },
    ];
  });
}

/** The todo list a `todo` call returned, or undefined when it holds none. */
export function todoOfResult(details: unknown): TodoEntry[] | undefined {
  if (!isRecord(details) || !Array.isArray(details.phases)) return undefined;
  const entries = details.phases.flatMap((phase: unknown) =>
    isRecord(phase) ? entriesOf(phase.tasks) : [],
  );
  return entries.length ? entries : undefined;
}

export function todoOfReminder(todos: unknown): TodoEntry[] | undefined {
  const entries = entriesOf(todos);
  return entries.length ? entries : undefined;
}

const NOTICE_OPEN = "<system-notice>";
const NOTICE_CLOSE = "</system-notice>";

/** A message omp injected on its own, as one line. */
export function noticeOf(text: string): {
  level: "info" | "warning" | "error";
  text: string;
} {
  if (!text.trimStart().startsWith(NOTICE_OPEN))
    return { level: "info", text: clipTo(squash(text), 300) };
  const tag = /<task-result\b([^>]*)>/i.exec(text)?.[1];
  const attributes = new Map<string, string>();
  for (const [, name, value] of (tag ?? "").matchAll(
    /([\w-]+)=["'“‘]([^"'“”‘’]*)["'”’]/g,
  ))
    if (name && value !== undefined) attributes.set(name, value.trim());
  const id = attributes.get("id");
  const status = attributes.get("status")?.toLowerCase();
  const level =
    status === "failed" || status === "error"
      ? "error"
      : status === "canceled" || status === "cancelled" || status === "stopped"
        ? "warning"
        : "info";
  if (id)
    return {
      level,
      text: `Background job ${id} ${attributes.get("status") ?? "completed"}`,
    };
  const open = text.indexOf(NOTICE_OPEN);
  const close = text.indexOf(NOTICE_CLOSE);
  const body = text.slice(
    open + NOTICE_OPEN.length,
    close === -1 ? undefined : close,
  );
  const line = body
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row && !row.startsWith("<"));
  return { level, text: clipTo(line ?? "System notice", 300) };
}

export function goalText(frame: Readonly<Record<string, unknown>>): string {
  const state = isRecord(frame.state) ? frame.state : undefined;
  const goal = isRecord(frame.goal)
    ? frame.goal
    : isRecord(state?.goal)
      ? state.goal
      : undefined;
  if (!goal) return "Goal cleared.";
  const part = (label: string, value: unknown, unit = "") =>
    typeof value === "number" || (typeof value === "string" && value)
      ? [`${label}: ${value}${unit}`]
      : [];
  return [
    typeof goal.objective === "string" && goal.objective.trim()
      ? goal.objective.trim()
      : "Goal updated.",
    ...part("Status", goal.status),
    ...part("Tokens used", goal.tokensUsed),
    ...part("Token budget", goal.tokenBudget),
    ...part("Time used", goal.timeUsedSeconds, "s"),
    ...part("Mode", state?.mode),
  ].join("\n");
}

export function delayText(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`;
}
