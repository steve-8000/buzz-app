import type { AgentHandle } from "../agents/service";
import type { SessionItem } from "./item";

/** Where the items of one conversation's session go. */
export type Transcript = Readonly<{
  /** The latest copy of an item; earlier unsent copies are dropped. */
  push(item: SessionItem): void;
  /** Resolves once what was pushed has been sent, or given up on. */
  settle(): Promise<void>;
  dispose(): void;
}>;

export type TranscriptTarget = Readonly<{
  agent: AgentHandle;
  channel: string;
  /** The thread's root message; a conversation outside a thread has none. */
  root?: string | undefined;
}>;

export type Transcripts = Readonly<{
  open(target: TranscriptTarget): Transcript;
}>;
