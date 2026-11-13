import { useState } from "react";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { Button } from "../../shared/design-system/ui/Button";
import { parseQuestion } from "./ask";
import styles from "./Ask.module.css";

/** The longest an agent waits for an answer is 240 minutes (its settings). */
const MAX_AGE_SECONDS = 240 * 60;

/** Under an owned agent's question: a button for each answer, which replies in
 * the thread as typing it would. Nothing for any other message. */
export function AskButtons({
  message,
  session,
  channelId,
  threadRootId,
}: ComposerAccessoryProps) {
  const [chosen, setChosen] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const ask = message ? parseQuestion(message.content) : undefined;
  if (!message || !ask) return null;
  if (session.profiles.owner?.(message.authorId) !== session.viewer)
    return null;
  if (!chosen && Date.now() / 1000 - message.createdAt > MAX_AGE_SECONDS)
    return null;

  const choices =
    ask.kind === "confirm"
      ? [
          { label: "Approve", reply: "approve", primary: true },
          { label: "Deny", reply: "deny", primary: false },
        ]
      : [
          ...ask.options.map((option, at) => ({
            label: option,
            reply: String(at + 1),
            primary: false,
          })),
          { label: "Deny", reply: "deny", primary: false },
        ];
  const answer = (label: string, reply: string) => {
    try {
      session.messages.reply(
        channelId,
        threadRootId ?? message.threadRootId ?? message.id,
        reply,
        [message.authorId],
        [],
        message.id,
      );
      setChosen(label);
      setFailure(undefined);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };

  if (chosen)
    return (
      <p className={styles.note} role="status">
        Answered: {chosen}
      </p>
    );
  return (
    <div className={styles.choices}>
      {choices.map(({ label, reply, primary }) => (
        <Button
          key={reply}
          size="sm"
          variant={primary ? "primary" : "subtle"}
          title={label}
          onClick={() => answer(label, reply)}
        >
          {label}
        </Button>
      ))}
      {failure && (
        <p className={styles.note} role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
