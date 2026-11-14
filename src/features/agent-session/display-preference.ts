import { useSyncExternalStore } from "react";

/** How much of an agent's work a session shows between a prompt and its reply. */
export type ChatDisplay = "full" | "collapseToolCalls" | "collapseTurns";

export const CHAT_DISPLAYS: readonly ChatDisplay[] = [
  "full",
  "collapseToolCalls",
  "collapseTurns",
];

export type SessionDisplay = Readonly<{
  /** Reasoning shows open, and stays out of the groups that fold tool calls. */
  autoExpandReasoning: boolean;
  chatDisplay: ChatDisplay;
  /** A rail beside a session panel to jump between its prompts. */
  chatOutline: boolean;
}>;

const preferenceKey = "buzz-session-display.v1";
const listeners = new Set<() => void>();
let current: SessionDisplay | undefined;
let unsaved = false;

function read(): SessionDisplay {
  let saved: Record<string, unknown> = {};
  try {
    saved = Object(JSON.parse(localStorage.getItem(preferenceKey) ?? "{}"));
  } catch {}
  const { autoExpandReasoning, chatDisplay, chatOutline } = saved;
  return {
    autoExpandReasoning: autoExpandReasoning !== false,
    chatDisplay:
      CHAT_DISPLAYS.find((value) => value === chatDisplay) ??
      "collapseToolCalls",
    chatOutline: chatOutline !== false,
  };
}

/** Device-local choices for how an agent session reads. */
export function sessionDisplay(): SessionDisplay {
  current ??= read();
  return current;
}

function notify() {
  for (const listener of listeners) listener();
}

function storage(event: StorageEvent) {
  if (event.key !== preferenceKey && event.key !== null) return;
  current = undefined;
  unsaved = false;
  notify();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    // Another window may have saved while nothing here was listening.
    if (!unsaved) current = undefined;
    window.addEventListener("storage", storage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", storage);
  };
}

const pending = () => unsaved;

export function useSessionDisplay(): SessionDisplay {
  return useSyncExternalStore(subscribe, sessionDisplay, sessionDisplay);
}

/** Whether the active choice could not be saved on this device. */
export function useSessionDisplayUnsaved(): boolean {
  return useSyncExternalStore(subscribe, pending, pending);
}

export function setSessionDisplay(change: Partial<SessionDisplay>): void {
  current = { ...sessionDisplay(), ...change };
  try {
    localStorage.setItem(preferenceKey, JSON.stringify(current));
    unsaved = false;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
    unsaved = true;
  }
  notify();
}
