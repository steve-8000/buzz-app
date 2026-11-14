// What a tool call acts on, in a line: the model's own intent and its subject.
import { isRecord } from "../rpc";

/** A step names its call in this many characters, enough for a few lines. */
const TARGET_LIMIT = 400;
const SUBJECTS = [
  "path",
  "file",
  "pattern",
  "query",
  "url",
  "title",
  "description",
] as const;

export const squash = (text: string) => text.replace(/\s+/g, " ").trim();
export const clipTo = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** The model's stated intent for a call, when its arguments carry one. */
export function intentOf(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const value = args.i ?? args.intent;
  return typeof value === "string" && value.trim() ? squash(value) : undefined;
}

function subjectOf(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const text = (key: string) => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  return (
    text("command") ??
    SUBJECTS.map(text).find(Boolean) ??
    (Object.keys(args).length ? JSON.stringify(args) : undefined)
  );
}

/** What a tool call is doing: the model's own intent and what it acts on. */
export function targetOf(args: unknown): string | undefined {
  const intent = intentOf(args);
  const subject = subjectOf(args);
  const what = subject && squash(subject);
  const line = intent && what ? `${intent} — ${what}` : (what ?? intent);
  return line ? clipTo(squash(line), TARGET_LIMIT) : undefined;
}
