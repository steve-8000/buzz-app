// The items every member of a conversation can read: the session artifacts
// that sync keeps in this computer's artifact storage, by thread.
import type { Context } from "@deepseek-ai/cordis";
import type {
  ArtifactCollection,
  ArtifactCollectionDefinition,
} from "../artifact-storage/types";
import { decode } from "./codec";
import {
  SESSION_ITEM_TYPE,
  SESSION_ITEM_VERSION,
  type SessionItem,
} from "./item";

const THREAD = "thread";
const PAGE = 500;
/** Pages read for one thread, so a very long session cannot stall the view. */
const PAGES = 20;

/** An item with the member who wrote it. */
export type Published = Readonly<{ author: string; item: SessionItem }>;

export const SESSION_COLLECTION: ArtifactCollectionDefinition = {
  name: "agent-session",
  type: SESSION_ITEM_TYPE,
  version: SESSION_ITEM_VERSION,
  project(entry) {
    const revision = entry.record.current;
    const channel = entry.record.channelId;
    if (!revision || !channel) return [];
    const decoded = decode(revision.content);
    if (!decoded?.root) return [];
    return [
      {
        index: THREAD,
        value: `${channel}:${decoded.root}`,
        order: String(decoded.item.seq).padStart(16, "0"),
      },
    ];
  },
};

export type SessionCollection = Readonly<{
  /** Every item the thread has, as stored here now. */
  read(channel: string, root: string): Promise<Published[]>;
  /** Called when stored items may have changed; each call needs a new read. */
  subscribe(listener: () => void): () => void;
}>;

/** Opens the collection for the signed-in community and again after the
 * community or identity changes, which closes the handle it had. */
export function openSessionCollection(ctx: Context): SessionCollection {
  let handle: ArtifactCollection | undefined;
  const ensure = () => {
    if (handle) return handle;
    try {
      handle = ctx.artifactStorage.open(SESSION_COLLECTION);
    } catch {
      handle = undefined;
    }
    return handle;
  };
  ctx.effect(() => () => {
    handle?.close();
    handle = undefined;
  });

  async function page(
    collection: ArtifactCollection,
    channel: string,
    root: string,
  ) {
    const found: Published[] = [];
    let after: { order: string; id: string } | undefined;
    for (let pages = 0; pages < PAGES; pages++) {
      const result = await collection.page({
        index: THREAD,
        value: `${channel}:${root}`,
        limit: PAGE,
        ...(after ? { after } : {}),
      });
      for (const { record } of result.entries) {
        const revision = record.current;
        const author = revision?.event?.pubkey;
        if (!revision || !author || record.availability.state === "deleted")
          continue;
        const decoded = decode(revision.content);
        if (decoded) found.push({ author, item: decoded.item });
      }
      if (!result.next) break;
      after = result.next;
    }
    return found;
  }

  return {
    async read(channel, root) {
      const collection = ensure();
      if (!collection) return [];
      try {
        return await page(collection, channel, root);
      } catch {
        handle = undefined;
        const again = ensure();
        return again ? await page(again, channel, root).catch(() => []) : [];
      }
    },
    subscribe(listener) {
      let stop: (() => void) | undefined;
      const attach = () => {
        stop?.();
        stop = undefined;
        try {
          stop = ensure()?.subscribe(listener);
        } catch {
          handle = undefined;
        }
      };
      attach();
      const stopScope = ctx.communityReader.subscribe(() => {
        handle = undefined;
        attach();
        listener();
      });
      return () => {
        stop?.();
        stopScope();
      };
    },
  };
}
