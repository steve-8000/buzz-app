import { useState } from "react";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { Button } from "../../shared/design-system/ui/Button";
import { parseQuestion } from "./ask";
import styles from "./Ask.module.css";

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
  if (Date.now() / 1000 - message.createdAt > ask.minutes * 60) return null;

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
          ...(ask.options.includes("Deny")
            ? []
            : [{ label: "Deny", reply: "deny", primary: false }]),
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

  if (chosen !== undefined || message.replyCount > 0)
    return (
      <p className={styles.note} role="status">
        {chosen ? `Answered: ${chosen}` : "Answered"}
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
