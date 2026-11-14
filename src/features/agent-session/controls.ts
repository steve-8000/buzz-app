import type { ApprovalItem, QuestionItem } from "./item";

/** What a person answers to a question the agent asks: whether to go ahead,
 * an option or some text, or no answer. */
export type SessionAnswer =
  | Readonly<{ approved: boolean }>
  | Readonly<{ value: string }>
  | Readonly<{ cancelled: true }>;

/** What a view may do with a session. Only the computer that runs the agent
 * can answer its questions, and only questions the agent itself wrote: any
 * member can write an item, so every other view shows them as read-only. */
export type SessionControls = Readonly<{
  canAnswer(
    channel: string,
    root: string,
    author: string,
    item: ApprovalItem | QuestionItem,
  ): boolean;
  answer(
    channel: string,
    root: string,
    author: string,
    item: ApprovalItem | QuestionItem,
    answer: SessionAnswer,
  ): void;
}>;
