// One agent's session in a conversation on its own, newest run last, as a
// panel opens it: for a conversation that is not a thread, or beside one.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { RelaySession } from "../relay/session";
import type { SessionControls } from "./controls";
import { useSessionDisplay } from "./display-preference";
import { buildFlow } from "./flow";
import { Outline } from "./Outline";
import { type PresentedSegment, present } from "./present";
import { SegmentView } from "./SessionThread";
import styles from "./SessionThread.module.css";
import { type SessionSource, useSessionEntries } from "./use-entries";

/** Runs shown at first, and added by each press of "earlier runs". */
const RUNS = 6;
/** How near the end still counts as reading the latest. */
const NEAR_END = 48;
/** How far under the top edge a run still counts as the one being read. */
const READING_LINE = 16;

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
  const display = useSessionDisplay();
  const runs = useMemo(
    () =>
      present(
        buildFlow(
          [],
          entries.filter((entry) => entry.author === author),
        ).nodes,
        display,
      ).filter((node): node is PresentedSegment => node.type === "segment"),
    [entries, author, display],
  );
  const [shown, setShown] = useState(RUNS);
  const [active, setActive] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const sections = useRef<(HTMLElement | null)[]>([]);
  const following = useRef(true);
  const first = Math.max(0, runs.length - shown);
  const visible = runs.slice(first);

  const locate = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const line = element.scrollTop + READING_LINE;
    let at = 0;
    sections.current.forEach((section, index) => {
      if (section && section.offsetTop <= line) at = index;
    });
    setActive(at);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the runs are the change to follow.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
    locate();
  }, [runs, locate]);
  if (!runs.length)
    return (
      <p className={`text-body text-secondary ${styles.empty}`}>
        This agent has not worked in this conversation since the app started.
      </p>
    );
  const outline = display.chatOutline && visible.length > 1;
  return (
    <div className={styles.frame}>
      <div
        ref={scroller}
        className={styles.view}
        data-outline={outline || undefined}
        role="log"
        aria-live="off"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard panning of a long session.
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            NEAR_END;
          locate();
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
        {visible.map((node, index) => (
          <section
            key={node.key}
            ref={(element) => {
              sections.current[index] = element;
            }}
            className={styles.segment}
          >
            {node.run?.prompt && (
              <p className={`text-body ${styles.prompt}`}>{node.run.prompt}</p>
            )}
            <SegmentView
              node={node}
              session={session}
              channel={channel}
              root={root}
              controls={controls}
              display={display}
            />
          </section>
        ))}
      </div>
      {outline && (
        <Outline
          entries={visible.map((node) => ({
            key: node.key,
            label: node.run?.prompt || "Run",
          }))}
          active={active}
          onJump={(index) =>
            scroller.current?.scrollTo({
              top: sections.current[index]?.offsetTop ?? 0,
              behavior: "smooth",
            })
          }
        />
      )}
    </div>
  );
}
