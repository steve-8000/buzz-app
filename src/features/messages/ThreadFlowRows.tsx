import { isValidElement, type ReactNode, useSyncExternalStore } from "react";
import { ContributionBoundary } from "../conversation/ContributionBoundary";
import type {
  ConversationExtensions,
  ThreadFlow,
} from "../conversation/contracts";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

const EMPTY: readonly never[] = [];
const NONE = { snapshot: () => EMPTY, subscribe: () => () => {} };

/** A thread's replies as the first thread flow a plugin contributes lays them
 * out, or as the host drew them. `rows` holds the host's row for each of
 * `messages`, in the same order, or nothing for one it does not show. */
export function ThreadFlowRows({
  extensions,
  session,
  channelId,
  rootId,
  messages,
  rows,
}: {
  extensions: ConversationExtensions | undefined;
  session: RelaySession;
  channelId: string;
  rootId: string | undefined;
  messages: readonly ChannelMessage[];
  rows: ReactNode;
}) {
  const reader = extensions?.threadFlows ?? NONE;
  const flows: readonly ThreadFlow[] = useSyncExternalStore(
    reader.subscribe,
    reader.snapshot,
    reader.snapshot,
  );
  const Flow = flows[0]?.component;
  if (!Flow || !rootId) return <>{rows}</>;
  const drawn = Array.isArray(rows) ? rows : [rows];
  const replies = messages.flatMap((message, index) => {
    const row = drawn[index];
    return isValidElement(row) ? [{ message, row }] : [];
  });
  return (
    <ContributionBoundary fallback={rows}>
      <Flow
        session={session}
        channelId={channelId}
        rootId={rootId}
        replies={replies}
      />
    </ContributionBoundary>
  );
}
