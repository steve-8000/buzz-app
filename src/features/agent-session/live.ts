// The items this computer's own agents are producing, shown as they happen:
// the relay copy follows within seconds, and may lag or be unreachable.
import type { SessionItem } from "./item";

export type LiveEntry = Readonly<{ author: string; item: SessionItem }>;

/** A conversation keeps this many items; the oldest go first. */
const KEEP = 1500;
const TRIM_TO = 1200;

const roomOf = (channel: string, root: string) => `${channel}:${root}`;
const NONE: readonly LiveEntry[] = Object.freeze([]);

export class LiveItems {
  private readonly rooms = new Map<string, Map<string, LiveEntry>>();
  private readonly views = new Map<string, readonly LiveEntry[]>();
  private readonly listeners = new Set<() => void>();
  private scheduled = false;

  push(channel: string, root: string, author: string, item: SessionItem) {
    const key = roomOf(channel, root);
    let room = this.rooms.get(key);
    if (!room) {
      room = new Map();
      this.rooms.set(key, room);
    }
    const id = `${author}:${item.seq}`;
    const held = room.get(id);
    if (held && held.item.rev >= item.rev) return;
    room.set(id, { author, item });
    if (room.size > KEEP) this.trim(room);
    this.views.delete(key);
    this.notify();
  }

  /** The room's items, the same array until one changes. */
  entries(channel: string, root: string): readonly LiveEntry[] {
    const key = roomOf(channel, root);
    const known = this.views.get(key);
    if (known) return known;
    const room = this.rooms.get(key);
    if (!room) return NONE;
    const view = [...room.values()];
    this.views.set(key, view);
    return view;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private trim(room: Map<string, LiveEntry>) {
    const ordered = [...room].sort(([, a], [, b]) => a.item.seq - b.item.seq);
    for (const [id] of ordered) {
      if (room.size <= TRIM_TO) break;
      room.delete(id);
    }
  }

  private notify() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const listener of [...this.listeners]) listener();
    });
  }
}
