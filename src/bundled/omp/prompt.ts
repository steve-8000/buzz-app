// What Buzz tells omp is only that it is answering in a chat. Everything else,
// how to work and what to do, is omp's own and the owner's AGENTS.md.

/** The one thing omp must know: where its final message goes. */
export function intro(name: string, details: readonly string[]) {
  return [
    `You are ${name}, replying in Buzz, a team chat. Your final message is posted as your reply in the conversation, so write it for the person who wrote to you. If you were asked something, answer it, even if only to say there is nothing to do.`,
    ...details.filter(Boolean),
  ].join("\n\n");
}

const BLOCK = /<([a-z-]+)>\n([\s\S]*?)\n<\/\1>/g;
const CONTEXT = new Set(["thread-context", "conversation-context"]);

function said(body: string) {
  try {
    const event: unknown = JSON.parse(body.split("\n", 1)[0] ?? "");
    if (typeof event !== "object" || event === null) return undefined;
    const {
      display_name: name,
      pubkey,
      content,
    } = event as Record<string, unknown>;
    if (typeof content !== "string") return undefined;
    const who =
      typeof name === "string" && name
        ? name
        : typeof pubkey === "string"
          ? pubkey.slice(0, 8)
          : "someone";
    return `${who}: ${content}`;
  } catch {
    return undefined;
  }
}

/** A Buzz turn without its routing and reply rules: the thread's earlier
 * messages and the message itself. */
export function slim(turn: string) {
  const kept: string[] = [];
  for (const match of turn.matchAll(BLOCK)) {
    const [whole = "", tag = "", body = ""] = match;
    if (CONTEXT.has(tag)) kept.push(whole);
    else if (tag === "buzz-event") kept.push(said(body) ?? whole);
  }
  return kept.length ? kept.join("\n\n") : turn;
}
