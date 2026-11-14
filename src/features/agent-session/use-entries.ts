import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { Published, SessionCollection } from "./collection";
import type { LiveItems } from "./live";

/** Stored items are read again this long after the last change. */
const REREAD_MS = 150;

/** Where a view finds a thread's items: what sync stored, and what this
 * computer's own agents are producing. */
export type SessionSource = Readonly<{
  collection: SessionCollection;
  live: LiveItems;
}>;

const EMPTY: readonly Published[] = [];

/** The thread's items, the newest copy of each. */
export function useSessionEntries(
  source: SessionSource,
  channel: string,
  root: string,
): readonly Published[] {
  const { collection, live } = source;
  const [stored, setStored] = useState(EMPTY);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void collection.read(channel, root).then((found) => {
        if (current) setStored(found.length ? found : EMPTY);
      });
    };
    load();
    const stop = collection.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(load, REREAD_MS);
    });
    return () => {
      current = false;
      clearTimeout(timer);
      stop();
    };
  }, [collection, channel, root]);
  const subscribe = useCallback(
    (listener: () => void) => live.subscribe(listener),
    [live],
  );
  const overlay = useSyncExternalStore(
    subscribe,
    () => live.entries(channel, root),
    () => live.entries(channel, root),
  );
  return useMemo(() => {
    if (!overlay.length) return stored;
    const newest = new Map<string, Published>();
    for (const entry of [...stored, ...overlay]) {
      const key = `${entry.author}:${entry.item.seq}`;
      const held = newest.get(key);
      if (!held || entry.item.rev >= held.item.rev) newest.set(key, entry);
    }
    return [...newest.values()];
  }, [stored, overlay]);
}
