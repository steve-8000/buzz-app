import { localWorkRoot } from "../../features/agents/local-activity";
import type { Navigation } from "../../features/navigation/controller";
import type { RelaySession } from "../../features/relay/session";
import { channelTabs } from "./useChannelTabState";

/** Opens a tab in the shared workspace for each thread one of the viewer's
 * agents starts working in, in any channel. A tab the viewer closes stays
 * closed until that thread's work has ended and begins again. */
export function watchWorkingThreads(
  session: RelaySession,
  navigation?: Navigation,
) {
  const tabs = channelTabs(session, navigation);
  let working = new Set<string>();
  const scan = () => {
    const now = new Set<string>();
    for (const row of session.agentActivity.snapshot().local ?? []) {
      if (row.state !== "working" && row.state !== "waiting") continue;
      const root = localWorkRoot(row);
      if (!root || row.soloChat) continue;
      const kind = session.channels
        .list()
        .channels.find((channel) => channel.id === row.channelId)?.channelType;
      if (kind === "dm" || kind === "solo") continue;
      const key = `${row.channelId}:${root}`;
      if (!working.has(key)) {
        try {
          tabs.open(row.channelId, root);
        } catch {
          // Not openable yet, such as a channel not loaded; the next change retries.
          continue;
        }
      }
      now.add(key);
    }
    working = now;
  };
  const stop = session.agentActivity.subscribe(scan);
  scan();
  return stop;
}
