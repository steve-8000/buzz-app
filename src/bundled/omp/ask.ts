// A question omp asks, as the chat message that carries it, and its reading
// back. The buttons under a posted question are built from its text, so every
// question stays answerable by typing, in any client.
import type { UiAnswer, UiRequest } from "./rpc";

const HINT = {
  confirm: "Reply `approve` or `deny` (mention me).",
  select: "Reply with a number, or `deny` (mention me).",
  text: "Reply with the text, or `deny` (mention me).",
} as const;
const EXPIRY = /^Refused automatically after (\d+) minutes\.$/;
const OPTION = /^(\d+)\. (.+)$/;

export function formatQuestion(request: UiRequest, minutes: number) {
  const lines = [`🔐 **${request.title || "omp asks"}**`];
  if (request.message) lines.push("", request.message);
  if (request.method === "confirm") lines.push("", HINT.confirm);
  else if (request.method === "select")
    lines.push(
      "",
      ...(request.options ?? []).map((option, at) => `${at + 1}. ${option}`),
      "",
      HINT.select,
    );
  else lines.push("", HINT.text);
  lines.push(`Refused automatically after ${minutes} minutes.`);
  return lines.join("\n");
}

/** The same question once settled: no hint, no expiry, so it reads back as
 * no question and carries no buttons. */
export function formatAnswered(request: UiRequest, label: string) {
  const lines = [`🔐 **${request.title || "omp asks"}**`];
  if (request.message) lines.push("", request.message);
  if (request.method === "select")
    lines.push(
      "",
      ...(request.options ?? []).map((option, at) => `${at + 1}. ${option}`),
    );
  lines.push("", `**${label}**`);
  return lines.join("\n");
}

/** How an answer reads in the settled question. */
export function answerLabel(answer: UiAnswer) {
  if ("confirmed" in answer)
    return answer.confirmed ? "✅ Approved" : "⛔ Denied";
  if ("value" in answer) return `✅ ${answer.value}`;
  return "⛔ Denied";
}

/** What to say when a reply to a pending question was not an answer to it. */
export function retryHint(request: UiRequest) {
  if (request.method === "confirm")
    return "Reply `approve` or `deny` to the question above, or press a button.";
  const count = request.options?.length ?? 0;
  return `Reply with a number from 1 to ${count}, or \`deny\`, or press a button.`;
}

export type Asked = Readonly<
  { minutes: number } & (
    | { kind: "confirm" }
    | { kind: "select"; options: readonly string[] }
  )
>;

/** The yes/no or pick-one question a message holds, when it is one. */
export function parseQuestion(content: string): Asked | undefined {
  const lines = content.split("\n");
  const at = lines.length;
  const expiry = EXPIRY.exec(lines[at - 1] ?? "");
  if (!lines[0]?.startsWith("🔐 ") || !expiry) return undefined;
  const minutes = Number(expiry[1]);
  const hint = lines[at - 2];
  if (hint === HINT.confirm) return { kind: "confirm", minutes };
  if (hint !== HINT.select || lines[at - 3] !== "") return undefined;
  const rows: RegExpExecArray[] = [];
  for (let line = at - 4; line >= 0; line--) {
    const match = OPTION.exec(lines[line] ?? "");
    if (!match) break;
    rows.unshift(match);
  }
  if (!rows.length || rows.some((row, index) => Number(row[1]) !== index + 1))
    return undefined;
  return { kind: "select", minutes, options: rows.map((row) => row[2] ?? "") };
}
