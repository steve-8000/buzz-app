// The sessions omp keeps on this computer, and the panel link that opens one
// from its activity bubble. A link looks like a URL so the host can open it
// beside the chat; nothing is ever fetched from it.

/** Sessions remembered, least recently used out first. */
const LIMIT = 64;
const ORIGIN = "https://session.omp.buzz.invalid";
const KEY = /^([0-9a-f]{64})\|([^|]+)\|([^|]*)$/;

const sessions = new Set<string>();

/** A session's key: its agent and conversation. */
export const sessionKey = (agent: string, channel: string, root?: string) =>
  `${agent}|${channel}|${root ?? ""}`;

/** Remembers that omp works in a conversation on this computer. */
export function noteSession(key: string) {
  sessions.delete(key);
  sessions.add(key);
  for (const old of [...sessions].slice(0, -LIMIT)) sessions.delete(old);
}

const targetOf = (key: string) => `${ORIGIN}/?key=${encodeURIComponent(key)}`;

export type SessionTarget = Readonly<{
  agent: string;
  channel: string;
  root?: string | undefined;
}>;

export function parseSessionTarget(target: string): SessionTarget | undefined {
  if (!target.startsWith(`${ORIGIN}/?`)) return undefined;
  const found = KEY.exec(new URL(target).searchParams.get("key") ?? "");
  const [, agent, channel, root] = found ?? [];
  return agent && channel
    ? { agent, channel, ...(root ? { root } : {}) }
    : undefined;
}

/** The link to an agent's session in a conversation, when omp kept one here:
 * its thread's, or else its channel-level one. */
export function sessionLinkFor(agent: string, channel: string, root?: string) {
  for (const key of [
    sessionKey(agent, channel, root),
    sessionKey(agent, channel),
  ])
    if (sessions.has(key)) return targetOf(key);
  return undefined;
}
