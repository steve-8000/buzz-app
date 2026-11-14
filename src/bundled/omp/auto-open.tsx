// Opens the thread of a run this computer starts for its owner, so the session
// shows without a click. The host owns navigation: this only asks the row of
// the message that started the run to open its thread, once.
import { useEffect, useSyncExternalStore } from "react";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";

/** A request is dropped after this long, so a thread the owner was not
 * looking at when the run began does not open later. */
const FRESH_MS = 60_000;

const requests = new Set<string>();
const listeners = new Set<() => void>();

const changed = () => {
  for (const listener of [...listeners]) listener();
};

/** Asks for the thread that the message `id` started to open, if its row is
 * on screen. */
export function requestThread(id: string) {
  requests.add(id);
  changed();
  setTimeout(() => {
    if (requests.delete(id)) changed();
  }, FRESH_MS);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Draws nothing. */
export function OpenThread({ message, openThread }: ComposerAccessoryProps) {
  const id = message?.id;
  const wanted = useSyncExternalStore(
    subscribe,
    () => (id ? requests.has(id) : false),
    () => false,
  );
  useEffect(() => {
    if (wanted && id && requests.delete(id)) openThread?.();
  }, [wanted, id, openThread]);
  return null;
}
