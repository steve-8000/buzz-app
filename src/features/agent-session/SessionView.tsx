// One agent's session in a conversation on its own, newest run last, as a
// panel opens it: for a conversation that is not a thread, or beside one.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { RelaySession } from "../relay/session";
import type { SessionControls } from "./controls";
import { buildFlow, type Segment } from "./flow";
import { SegmentView } from "./SessionThread";
import styles from "./SessionThread.module.css";
import { type SessionSource, useSessionEntries } from "./use-entries";

/** Runs shown at first, and added by each press of "earlier runs". */
const RUNS = 6;
/** How near the end still counts as reading the latest. */
const NEAR_END = 48;

export function SessionView({
  source,
  controls,
  session,
  channel,
  root,
  author,
}: {
  source: SessionSource;
  controls: SessionControls;
  session: RelaySession;
  channel: string;
  /** The thread's root, or empty for a conversation that is not a thread. */
  root: string;
  author: string;
}) {
  const entries = useSessionEntries(source, channel, root);
  const runs = useMemo(
    () =>
      buildFlow(
        [],
        entries.filter((entry) => entry.author === author),
      ).nodes.filter((node): node is Segment => node.type === "segment"),
    [entries, author],
  );
  const [shown, setShown] = useState(RUNS);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the runs are the change to follow.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [runs]);
  if (!runs.length)
    return (
      <p className={`text-body text-secondary ${styles.empty}`}>
        This agent has not worked in this conversation since the app started.
      </p>
    );
  const first = Math.max(0, runs.length - shown);
  return (
    <div
      ref={scroller}
      className={styles.view}
      role="log"
      aria-live="off"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard panning of a long session.
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <
          NEAR_END;
      }}
    >
      {first > 0 && (
        <Button
          size="sm"
          variant="subtle"
          onClick={() => setShown((count) => count + RUNS)}
        >
          Show earlier runs ({first})
        </Button>
      )}
      {runs.slice(first).map((node) => (
        <section key={node.key} className={styles.segment}>
          <SegmentView
            node={node}
            session={session}
            channel={channel}
            root={root}
            controls={controls}
          />
        </section>
      ))}
    </div>
  );
}
