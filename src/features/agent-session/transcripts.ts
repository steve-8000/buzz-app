import type { LiveItems } from "./live";
import { ItemPublisher } from "./publisher";
import type { Transcript, Transcripts } from "./transcript";

/** For a conversation outside a thread, which has no view to show items in. */
const UNSHOWN: Transcript = {
  push: () => undefined,
  settle: () => Promise.resolve(),
  dispose: () => undefined,
};

/** Items go to this computer's live view at once and to the conversation as
 * artifact revisions, where every member can read them. */
export function sessionTranscripts(live: LiveItems): Transcripts {
  return {
    open({ agent, channel, root }) {
      if (!root) return UNSHOWN;
      const publisher = new ItemPublisher(agent, { channel, root });
      return {
        push(item) {
          live.push(channel, root, agent.pubkey, item);
          publisher.push(item);
        },
        settle: () => publisher.settle(),
        dispose: () => publisher.dispose(),
      };
    },
  };
}
