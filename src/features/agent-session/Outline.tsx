import { type CSSProperties, useState } from "react";
import styles from "./Outline.module.css";

export type OutlineEntry = Readonly<{ key: string; label: string }>;

/** How far a pointer's pull reaches, in ticks. */
const REACH = 3;

/** 1 under the pointer, easing to 0 at `REACH` ticks away, so sweeping the
 * rail moves one swell along it instead of switching ticks on and off. */
const pull = (distance: number) => {
  const away = Math.abs(distance);
  return away >= REACH ? 0 : (1 + Math.cos((Math.PI * away) / REACH)) / 2;
};

/** A rail of ticks, one for each prompt of a session: the one being read
 * stands out, a pointer swells the ticks near it and names the prompt, and a
 * press jumps there. */
export function Outline({
  entries,
  active,
  onJump,
}: {
  entries: readonly OutlineEntry[];
  active: number;
  onJump(index: number): void;
}) {
  const [near, setNear] = useState<number>();
  return (
    <nav
      className={styles.rail}
      aria-label="Prompts"
      onPointerLeave={() => setNear(undefined)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setNear(undefined);
      }}
    >
      {entries.map((entry, index) => (
        <button
          key={entry.key}
          type="button"
          className={styles.slot}
          aria-label={entry.label}
          aria-current={index === active ? "location" : undefined}
          data-active={index === active || undefined}
          onPointerEnter={() => setNear(index)}
          onFocus={() => setNear(index)}
          onClick={() => onJump(index)}
        >
          <span
            className={styles.tick}
            style={
              {
                "--lift": near === undefined ? 0 : pull(index - near),
              } as CSSProperties
            }
          />
          {near === index && (
            <span className={`text-body ${styles.preview}`} aria-hidden="true">
              {entry.label}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}
