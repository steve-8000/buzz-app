import type { LiveItems } from "./live";
import { ItemPublisher } from "./publisher";
import type { Transcripts } from "./transcript";

const NOTHING = () => undefined;

/** Items go to this computer's live view at once. In a thread they also go to
 * the conversation as artifact revisions, where every member can read them. A
 * conversation that is not a thread has no members to show a thread to, and
 * grows without end, so its session stays on this computer. */
export function sessionTranscripts(live: LiveItems): Transcripts {
  return {
    open({ agent, channel, root }) {
      if (!root)
        return {
          push: (item) => live.push(channel, "", agent.pubkey, item),
          settle: () => Promise.resolve(),
          dispose: NOTHING,
        };
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
