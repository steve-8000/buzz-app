// The thread of an agent session: the thread's own messages, with the steps
// the agent took between them.
import { type ComponentType, useMemo } from "react";
import activity from "../agents/ActivityTranscript.module.css";
import type { ThreadFlowProps } from "../conversation/contracts";
import type { RelaySession } from "../relay/session";
import type { SessionControls } from "./controls";
import { buildFlow, type Segment } from "./flow";
import { ItemRow, RunHeader } from "./SessionRows";
import styles from "./SessionThread.module.css";
import { type SessionSource, useSessionEntries } from "./use-entries";

/** One stretch of a run: who ran and how it stands, then its steps. */
export function SegmentView({
  node,
  session,
  channel,
  root,
  controls,
}: {
  node: Segment;
  session: RelaySession;
  channel: string;
  root: string;
  controls: SessionControls;
}) {
  return (
    <>
      {node.run && (
        <RunHeader run={node.run} author={node.author} session={session} />
      )}
      {node.items.length > 0 && (
        <div className={styles.steps}>
          {node.items.map((item) => (
            <div key={item.seq} className={activity.item} data-type={item.kind}>
              <ItemRow
                item={item}
                context={{
                  session,
                  channel,
                  root,
                  author: node.author,
                  controls,
                }}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** The flow component for a thread: the host's own rows, unchanged, until a
 * session has items in the thread. */
export function sessionFlow(
  source: SessionSource,
  controls: SessionControls,
): ComponentType<ThreadFlowProps> {
  return function SessionFlow({
    session,
    channelId,
    rootId,
    replies,
  }: ThreadFlowProps) {
    const entries = useSessionEntries(source, channelId, rootId);
    const flow = useMemo(
      () =>
        buildFlow(
          replies.map((reply) => reply.message),
          entries,
        ),
      [replies, entries],
    );
    if (!flow.nodes.some((node) => node.type === "segment"))
      return <>{replies.map((reply) => reply.row)}</>;
    const rows = new Map(
      replies.map((reply) => [reply.message.id, reply.row] as const),
    );
    return (
      <>
        {flow.nodes.map((node) =>
          node.type === "reply" ? (
            (rows.get(node.id) ?? null)
          ) : (
            <li key={node.key} className={styles.segment} data-session-steps="">
              <SegmentView
                node={node}
                session={session}
                channel={channelId}
                root={rootId}
                controls={controls}
              />
            </li>
          ),
        )}
      </>
    );
  };
}
