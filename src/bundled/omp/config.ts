// An omp agent's saved settings, and the defaults a new one starts with.
export type Scope = "thread" | "channel";

export type Config = Readonly<{
  /** The git repository the agent works on. Each conversation gets its own
   * worktree of it. Empty: the agent works directly in `workspace`. */
  repo: string;
  /** The branch a conversation's worktree starts from. */
  base: string;
  /** Where the agent works when no repository is set. */
  workspace: string;
  /** `provider/model`; empty keeps omp's own choice. */
  model: string;
  /** omp's thinking level; empty keeps omp's own choice. */
  thinking: string;
  instructions: string;
  scope: Scope;
  /** Turns of this agent that run at once on one repository. */
  maxConcurrent: number;
  /** How long a question waits for the owner before it is refused. */
  approvalMinutes: number;
}>;

export const DEFAULT_CONFIG: Config = {
  repo: "",
  base: "main",
  workspace: "~/.buzz/omp",
  model: "",
  thinking: "",
  instructions: "",
  scope: "thread",
  maxConcurrent: 4,
  approvalMinutes: 30,
};

export const THINKING_LEVELS = [
  "",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const text = (value: unknown, fallback: string) =>
  typeof value === "string" ? value : fallback;

const whole = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;

/** A saved config as it is read back: unknown fields and bad values fall back
 * to the defaults, so an edited or older record never breaks a turn. */
export function config(value: unknown): Config {
  const saved =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const thinking = text(saved.thinking, "");
  return {
    repo: text(saved.repo, DEFAULT_CONFIG.repo).trim(),
    base: text(saved.base, DEFAULT_CONFIG.base).trim() || DEFAULT_CONFIG.base,
    workspace:
      text(saved.workspace, DEFAULT_CONFIG.workspace).trim() ||
      DEFAULT_CONFIG.workspace,
    model: text(saved.model, "").trim(),
    thinking: (THINKING_LEVELS as readonly string[]).includes(thinking)
      ? thinking
      : "",
    instructions: text(saved.instructions, ""),
    scope: saved.scope === "channel" ? "channel" : "thread",
    maxConcurrent: whole(
      saved.maxConcurrent,
      DEFAULT_CONFIG.maxConcurrent,
      1,
      8,
    ),
    approvalMinutes: whole(
      saved.approvalMinutes,
      DEFAULT_CONFIG.approvalMinutes,
      1,
      240,
    ),
  };
}
