import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PanelProps } from "../../features/panels/service";
import { LOG_LIMIT, parseLogTarget, peekLog } from "./log";
import styles from "./Log.module.css";

/** Lines shown at first, and added by each "earlier lines" press. */
const PAGE = 500;
const NEAR_END = 48;
const noSubscribe = () => () => {};
const noVersion = () => 0;

/** One omp session's log, as it streams: tool calls with their output, and the
 * reply as it is written. It follows the end until the reader scrolls up. */
export function LogPanel({ target }: PanelProps) {
  const key = parseLogTarget(target);
  const log = key ? peekLog(key) : undefined;
  useSyncExternalStore(
    log?.subscribe ?? noSubscribe,
    log?.snapshot ?? noVersion,
  );
  const [shown, setShown] = useState(PAGE);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  });
  if (!log)
    return (
      <p className={styles.empty}>
        omp has not worked in this conversation since the app started.
      </p>
    );
  const lines = log.lines();
  const first = Math.max(0, lines.length - shown);
  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        {log.title} · {lines.length} lines (the last {LOG_LIMIT} are kept)
      </div>
      <div
        ref={scroller}
        className={styles.log}
        role="log"
        aria-live="off"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard panning of a long log.
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            NEAR_END;
        }}
      >
        {first > 0 && (
          <button
            type="button"
            className={styles.more}
            onClick={() => setShown((count) => count + PAGE)}
          >
            Show {Math.min(PAGE, first)} earlier lines ({first} not shown)
          </button>
        )}
        {lines.slice(first).map((line, at) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: log rows only append, so a row's place is its identity
            key={first + at}
            className={`${styles.line} ${styles[line.kind]}`}
          >
            {line.text || " "}
          </div>
        ))}
      </div>
    </div>
  );
}
