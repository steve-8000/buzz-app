// The thread of an agent session: the thread's own messages, with the steps
// the agent took between them.
import { type ComponentType, useMemo } from "react";
import activity from "../agents/ActivityTranscript.module.css";
import type { ThreadFlowProps } from "../conversation/contracts";
import type { RelaySession } from "../relay/session";
import type { SessionControls } from "./controls";
import { type SessionDisplay, useSessionDisplay } from "./display-preference";
import { buildFlow } from "./flow";
import { type PresentedSegment, present } from "./present";
import { RowView, RunHeader } from "./SessionRows";
import styles from "./SessionThread.module.css";
import { type SessionSource, useSessionEntries } from "./use-entries";

/** One stretch of a run: who ran and how it stands, then its steps. */
export function SegmentView({
  node,
  session,
  channel,
  root,
  controls,
  display,
}: {
  node: PresentedSegment;
  session: RelaySession;
  channel: string;
  root: string;
  controls: SessionControls;
  display: SessionDisplay;
}) {
  const context = {
    session,
    channel,
    root,
    author: node.author,
    controls,
    display,
  };
  return (
    <>
      {node.run && (
        <RunHeader run={node.run} author={node.author} session={session} />
      )}
      {node.rows.length > 0 && (
        <div className={styles.steps}>
          {node.rows.map((row) => (
            <div
              key={row.key}
              className={activity.item}
              data-type={row.type === "item" ? row.item.kind : row.type}
            >
              <RowView row={row} context={context} />
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
    const display = useSessionDisplay();
    const flow = useMemo(
      () =>
        buildFlow(
          replies.map((reply) => reply.message),
          entries,
        ),
      [replies, entries],
    );
    const nodes = useMemo(
      () => present(flow.nodes, display),
      [flow.nodes, display],
    );
    if (!flow.nodes.some((node) => node.type === "segment"))
      return <>{replies.map((reply) => reply.row)}</>;
    const rows = new Map(
      replies.map((reply) => [reply.message.id, reply.row] as const),
    );
    return (
      <>
        {nodes.map((node) =>
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
                display={display}
              />
            </li>
          ),
        )}
      </>
    );
  };
}
