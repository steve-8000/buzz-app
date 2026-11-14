// Sends a conversation's items to the relay as artifact revisions, as fast as
// the relay's write limit allows and no faster. An item that changes often is
// sent every few seconds with its latest copy; one that is finished goes at
// once; a failed write is tried again.
import { ARTIFACT_KIND } from "../agents/agent-config-artifacts";
import type { AgentHandle } from "../agents/service";
import { type Anchor, decode, encode, itemId } from "./codec";
import {
  interrupted,
  isOpen,
  SESSION_ITEM_TYPE,
  type SessionItem,
} from "./item";
import type { Transcript } from "./transcript";

/** Writes in a burst, then one per `REFILL_MS`: under the relay's per-agent
 * limit of 120 a minute. */
const BURST = 6;
const REFILL_MS = 700;
/** A tool is shown as running only when it lasts this long. */
const RUNNING_MS = 4000;
/** Streamed text is first sent after this long, so a short reply goes once. */
const STREAMING_MS = 2000;
/** Between two copies of an item that changes as it goes. */
const UPDATE_MS = 2500;
const NOTE_MS = 400;
const SETTLE_MS = 20_000;
const RETRY_LIMIT = 8;
const RECOVERED_LIMIT = 100;

type Entry = { item: SessionItem; due: number; tries: number };
type Sent = { id: string; rev: number; at: number };

/** Approvals and runs go first, then finished items, then the rest. */
function rank(item: SessionItem) {
  if (
    item.kind === "approval" ||
    item.kind === "question" ||
    item.kind === "run"
  )
    return 0;
  return isOpen(item) ? 2 : 1;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export class ItemPublisher implements Transcript {
  private readonly queue = new Map<number, Entry>();
  private readonly sent = new Map<number, Sent>();
  private readonly ids = new Map<number, Promise<string>>();
  private tokens = BURST;
  private refilled = Date.now();
  private busy = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly recovering: Promise<void>;
  private readonly anchor: Anchor;

  constructor(
    private readonly agent: AgentHandle,
    private readonly where: { channel: string; root: string },
  ) {
    this.anchor = { agent: agent.pubkey, ...where };
    this.recovering = this.recover().catch(() => undefined);
  }

  push(item: SessionItem) {
    if (this.disposed) return;
    const last = this.sent.get(item.seq);
    const waiting = this.queue.get(item.seq);
    if (
      (last && item.rev <= last.rev) ||
      (waiting && item.rev <= waiting.item.rev)
    )
      return;
    const due = Math.min(waiting?.due ?? Infinity, this.dueOf(item, last));
    this.queue.set(item.seq, { item, due, tries: waiting?.tries ?? 0 });
    this.pump();
  }

  /** Sends what is waiting without further delay, for up to a while. */
  async settle() {
    await this.recovering;
    for (const entry of this.queue.values()) entry.due = 0;
    this.pump();
    const limit = Date.now() + SETTLE_MS;
    while (
      !this.disposed &&
      (this.queue.size || this.busy) &&
      Date.now() < limit
    )
      await sleep(100);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.queue.clear();
  }

  private dueOf(item: SessionItem, last: Sent | undefined) {
    const now = Date.now();
    if (rank(item) < 2) return now;
    if (last) return last.at + UPDATE_MS;
    if (item.kind === "tool") return now + RUNNING_MS;
    if (item.kind === "assistant" || item.kind === "reasoning")
      return now + STREAMING_MS;
    return now + NOTE_MS;
  }

  private pump() {
    if (this.disposed || this.busy) return;
    clearTimeout(this.timer);
    const now = Date.now();
    const gained = Math.floor((now - this.refilled) / REFILL_MS);
    if (gained > 0) {
      this.tokens = Math.min(BURST, this.tokens + gained);
      this.refilled += gained * REFILL_MS;
    }
    let next: [number, Entry] | undefined;
    let soonest = Infinity;
    for (const [seq, entry] of this.queue) {
      if (entry.due > now) {
        soonest = Math.min(soonest, entry.due);
        continue;
      }
      if (
        !next ||
        rank(entry.item) < rank(next[1].item) ||
        (rank(entry.item) === rank(next[1].item) && seq < next[0])
      )
        next = [seq, entry];
    }
    if (!next) {
      if (soonest < Infinity) this.later(soonest - now);
      return;
    }
    if (this.tokens < 1) {
      this.later(this.refilled + REFILL_MS - now);
      return;
    }
    this.tokens -= 1;
    this.busy = true;
    const [seq, entry] = next;
    this.queue.delete(seq);
    void this.send(seq, entry).finally(() => {
      this.busy = false;
      this.pump();
    });
  }

  private later(ms: number) {
    this.timer = setTimeout(() => this.pump(), Math.max(20, ms));
  }

  private id(seq: number) {
    let id = this.ids.get(seq);
    if (!id) {
      id = itemId(this.anchor, seq);
      this.ids.set(seq, id);
    }
    return id;
  }

  private async send(seq: number, entry: Entry) {
    const prev = this.sent.get(seq);
    const d = await this.id(seq);
    try {
      const event = await this.agent.publish(
        encode(this.anchor, entry.item, d, prev?.id),
      );
      this.sent.set(seq, { id: event.id, rev: entry.item.rev, at: Date.now() });
    } catch (error) {
      await this.failed(seq, entry, d, error);
    }
  }

  /** A write that raced another, or whose result was never confirmed, may
   * have been accepted: read the head and write the item again on top of it. */
  private async failed(seq: number, entry: Entry, d: string, error: unknown) {
    if (this.disposed) return;
    const reason = error instanceof Error ? error.message : String(error);
    if (/conflict|already|in use|exists|duplicate|unconfirmed/i.test(reason)) {
      const head = await this.head(d);
      if (head) this.sent.set(seq, { id: head, rev: 0, at: Date.now() });
      else if (!this.sent.has(seq)) return this.retry(seq, entry, reason);
    }
    this.retry(seq, entry, reason);
  }

  private retry(seq: number, entry: Entry, reason: string) {
    const tries = entry.tries + 1;
    if (tries > RETRY_LIMIT && rank(entry.item) > 0) return;
    if (this.queue.has(seq)) return;
    const slow = /rate|too many|slow/i.test(reason) ? 5000 : 0;
    const backoff = Math.max(slow, Math.min(30_000, 1000 * 2 ** tries));
    this.queue.set(seq, { item: entry.item, due: Date.now() + backoff, tries });
  }

  private async head(d: string): Promise<string | undefined> {
    try {
      const [event] = await this.agent.query([
        {
          kinds: [ARTIFACT_KIND],
          "#h": [this.where.channel],
          "#d": [d],
          artifact: "head",
          limit: 1,
        },
      ]);
      return event?.id;
    } catch {
      return undefined;
    }
  }

  /** Items a previous run of the app left waiting will never finish: close
   * them, so no reader sees one spinning forever. */
  private async recover() {
    const events = await this.agent.query([
      {
        kinds: [ARTIFACT_KIND],
        "#h": [this.where.channel],
        "#type": [SESSION_ITEM_TYPE],
        "#thr": [this.where.root],
        "#st": ["open"],
        artifact: "current",
        limit: RECOVERED_LIMIT,
      },
    ]);
    const now = Date.now();
    for (const event of events) {
      if (event.pubkey !== this.agent.pubkey) continue;
      const decoded = decode(event.content);
      if (!decoded || !isOpen(decoded.item)) continue;
      const { item } = decoded;
      this.sent.set(item.seq, { id: event.id, rev: item.rev, at: 0 });
      this.queue.set(item.seq, {
        item: interrupted(item, now),
        due: now,
        tries: 0,
      });
    }
    this.pump();
  }
}
