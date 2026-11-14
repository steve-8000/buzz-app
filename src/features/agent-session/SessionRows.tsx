// The rows of an agent run, drawn like the activity transcript: steps that
// open to their detail, the agent's text, and the questions it asks.
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import activity from "../agents/ActivityTranscript.module.css";
import { duration, Reply } from "../agents/ActivityTranscript";
import { avatarMedia } from "../../shared/avatar-source";
import {
  BulbIcon,
  CaretRightIcon,
  CheckCircleIcon,
  DotsThreeIcon,
  EyeIcon,
  FileTextIcon,
  GlobeIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  QuestionIcon,
  RobotIcon,
  ShieldIcon,
  StopIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  WrenchIcon,
  XCircleIcon,
} from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import { formatPublicKey } from "../../shared/identity/public-key";
import { useProfileGeneration } from "../relay/react";
import type { RelaySession } from "../relay/session";
import type { SessionAnswer, SessionControls } from "./controls";
import type {
  ApprovalItem,
  CompactionItem,
  NoticeItem,
  QuestionItem,
  RunItem,
  SessionItem,
  TextItem,
  TodoItem,
  ToolDetail,
  ToolItem,
} from "./item";
import styles from "./SessionThread.module.css";

export type RowContext = Readonly<{
  session: RelaySession;
  channel: string;
  root: string;
  /** Who wrote the item: only the agent itself can have a question to answer. */
  author: string;
  controls?: SessionControls | undefined;
}>;

const none = () => undefined;
const noSubscribe = () => () => {};

const oneLine = (text: string, limit = 160) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
const heading = (text: string) =>
  oneLine(
    (text.split("\n").find((line) => line.trim()) ?? "").replace(
      /^#{1,6}\s+|^\*\*|\*\*$/g,
      "",
    ),
    100,
  );

/** The agent as its profile names it. */
export function Author({
  session,
  pubkey,
}: {
  session: RelaySession;
  pubkey: string;
}) {
  const profiles = session.profiles;
  const generation = useProfileGeneration(profiles);
  useEffect(() => {
    void generation;
    void profiles.ensure([pubkey], "background").catch(() => {});
  }, [profiles, pubkey, generation]);
  const profile = useSyncExternalStore(
    profiles.subscribe ?? noSubscribe,
    () => profiles.snapshot().get(pubkey),
    none,
  );
  const name =
    profile?.verified?.displayName ??
    profile?.name ??
    formatPublicKey(pubkey) ??
    pubkey.slice(0, 8);
  return (
    <>
      <span className={activity.avatar}>
        <Avatar
          src={avatarMedia(profile?.picture, session.media)}
          alt=""
          fallback={name}
          size="fill"
          shape="squircle"
        />
      </span>
      <span className={`text-body ${styles.name}`}>{name}</span>
    </>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={activity.codePanel}>
      <h3 className={`text-body text-secondary ${activity.codePanelHeading}`}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** A step that opens to its detail. */
function Step({
  icon,
  label,
  subject,
  meta,
  status,
  open,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  subject?: string | undefined;
  meta?: ReactNode;
  status?: string | undefined;
  open?: boolean | undefined;
  children?: ReactNode;
}) {
  return (
    <details
      className={activity.tool}
      data-status={status}
      {...(open ? { open: true } : {})}
    >
      <summary className={activity.row}>
        {icon}
        <span className={activity.summary}>
          {label}
          {subject && <span className={activity.path}> {subject}</span>}
        </span>
        {meta}
        <CaretRightIcon
          className={activity.chevron}
          size={14}
          aria-hidden="true"
        />
      </summary>
      {children ? <div className={activity.toolBody}>{children}</div> : null}
    </details>
  );
}

/** A unified diff, its added and removed lines marked. */
function DiffText({ diff }: { diff: string }) {
  return (
    <pre className={activity.pre}>
      {diff.split("\n").map((line, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and immutable.
          key={index}
          className={
            /^\+(?!\+\+)/.test(line)
              ? activity.added
              : /^-(?!--)/.test(line)
                ? activity.removed
                : undefined
          }
        >
          {`${line}\n`}
        </span>
      ))}
    </pre>
  );
}

function detailView(
  detail: ToolDetail,
  name: string,
): { icon: ReactNode; action: string; subject: string; body: ReactNode } {
  const icon = (Icon: typeof WrenchIcon) => (
    <Icon size="1rem" aria-hidden="true" />
  );
  switch (detail.type) {
    case "shell":
      return {
        icon: icon(TerminalWindowIcon),
        action: "Run",
        subject: oneLine(detail.command),
        body: (
          <>
            <Panel title="Input">
              <pre className={activity.pre}>{detail.command}</pre>
            </Panel>
            {detail.output && (
              <Panel title="Output">
                <pre className={activity.pre}>{detail.output}</pre>
              </Panel>
            )}
            {typeof detail.exitCode === "number" && detail.exitCode !== 0 && (
              <p className="text-body text-secondary">
                Exit code {detail.exitCode}
              </p>
            )}
          </>
        ),
      };
    case "read":
      return {
        icon: icon(EyeIcon),
        action: "Read",
        subject: detail.filePath,
        body: detail.content ? (
          <pre className={activity.pre}>{detail.content}</pre>
        ) : null,
      };
    case "edit":
      return {
        icon: icon(PencilSimpleIcon),
        action: "Edit",
        subject: detail.filePath,
        body: detail.unifiedDiff ? (
          <DiffText diff={detail.unifiedDiff} />
        ) : detail.oldString !== undefined || detail.newString !== undefined ? (
          <DiffText
            diff={[
              ...(detail.oldString ?? "")
                .split("\n")
                .map((line) => `- ${line}`),
              ...(detail.newString ?? "")
                .split("\n")
                .map((line) => `+ ${line}`),
            ].join("\n")}
          />
        ) : null,
      };
    case "write":
      return {
        icon: icon(PencilSimpleIcon),
        action: "Write",
        subject: detail.filePath,
        body: detail.content ? (
          <pre className={activity.pre}>{detail.content}</pre>
        ) : null,
      };
    case "search":
      return {
        icon: icon(
          detail.toolName === "web_search" ? GlobeIcon : MagnifyingGlassIcon,
        ),
        action: detail.toolName === "web_search" ? "Web search" : "Search",
        subject: oneLine(detail.query),
        body: detail.content ? (
          <pre className={activity.pre}>{detail.content}</pre>
        ) : null,
      };
    case "fetch":
      return {
        icon: icon(GlobeIcon),
        action: "Fetch",
        subject: detail.url,
        body: detail.result ? (
          <pre className={activity.pre}>{detail.result}</pre>
        ) : null,
      };
    case "sub_agent":
      return {
        icon: icon(RobotIcon),
        action: detail.subAgentType
          ? `Subagent ${detail.subAgentType}`
          : "Subagent",
        subject: oneLine(detail.description ?? ""),
        body: detail.description ? (
          <p className="text-body">{detail.description}</p>
        ) : null,
      };
    case "plain_text":
      return {
        icon: icon(WrenchIcon),
        action: detail.label ?? name,
        subject: "",
        body: detail.text ? (
          <pre className={activity.pre}>{detail.text}</pre>
        ) : null,
      };
    case "unknown":
      return {
        icon: icon(WrenchIcon),
        action: name,
        subject: "",
        body: (
          <>
            {detail.input && (
              <Panel title="Input">
                <pre className={activity.pre}>{detail.input}</pre>
              </Panel>
            )}
            {detail.output && (
              <Panel title="Output">
                <pre className={activity.pre}>{detail.output}</pre>
              </Panel>
            )}
          </>
        ),
      };
  }
}

const DOING: Readonly<Record<string, string>> = {
  Run: "Running",
  Read: "Reading",
  Edit: "Editing",
  Write: "Writing",
  Search: "Searching",
  "Web search": "Searching the web",
  Fetch: "Fetching",
};

function ToolRow({ item }: { item: ToolItem }) {
  const view = detailView(item.detail, item.name);
  const elapsed = item.end ? duration(Math.max(0, item.end - item.at)) : "";
  return (
    <Step
      icon={view.icon}
      status={item.status}
      label={
        item.status === "running" ? (
          <ShimmerText>{DOING[view.action] ?? view.action}</ShimmerText>
        ) : (
          <span className={`text-body ${activity.subject}`}>{view.action}</span>
        )
      }
      subject={view.subject || item.intent}
      meta={
        elapsed ? (
          <span className={`text-body ${activity.at}`}>{elapsed}</span>
        ) : undefined
      }
    >
      {item.intent && view.subject && (
        <p className="text-body text-secondary">{item.intent}</p>
      )}
      {item.error && (
        <p className={`text-body ${activity.error}`}>{item.error}</p>
      )}
      {view.body}
    </Step>
  );
}

function TextRow({ item }: { item: TextItem }) {
  if (item.kind === "assistant")
    return (
      <div className={styles.assistant}>
        <div className="text-message">
          <Reply text={item.text} />
        </div>
        {item.streaming && <TypingDots size="small" />}
      </div>
    );
  const title = heading(item.text) || "Thinking";
  const body = item.text
    .trimStart()
    .split("\n")
    .slice(1)
    .join("\n")
    .trimStart();
  return (
    <Step
      icon={<BulbIcon size={16} aria-label="Thought" />}
      label={
        item.streaming ? (
          <ShimmerText>{title}</ShimmerText>
        ) : (
          <span className={`text-body ${activity.subject}`}>{title}</span>
        )
      }
    >
      {body && <Reply text={body} />}
    </Step>
  );
}

function TodoRow({ item }: { item: TodoItem }) {
  const done = item.entries.filter(
    (entry) => entry.status === "completed",
  ).length;
  return (
    <Step
      open
      icon={<ListChecksIcon size={16} aria-hidden="true" />}
      label={<span className={`text-body ${activity.subject}`}>Todo</span>}
      subject={`${done}/${item.entries.length}`}
    >
      <ul className={activity.plan} aria-label="Todo">
        {item.entries.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: entries are positional and carry no row state.
          <li key={index} data-status={entry.status}>
            {entry.status === "completed" ? "☑" : "☐"} {entry.text}
          </li>
        ))}
      </ul>
    </Step>
  );
}

function NoticeRow({ item }: { item: NoticeItem }) {
  const Icon =
    item.level === "error"
      ? XCircleIcon
      : item.level === "warning"
        ? WarningCircleIcon
        : DotsThreeIcon;
  return (
    <p
      role="note"
      className={`${activity.row} text-body ${item.level === "error" ? activity.error : "text-secondary"}`}
    >
      <Icon size={16} aria-hidden="true" />
      <span className={activity.text}>{item.text}</span>
    </p>
  );
}

function CompactionRow({ item }: { item: CompactionItem }) {
  return (
    <p className={`${activity.row} text-body text-secondary`}>
      <FileTextIcon size={16} aria-hidden="true" />
      {item.state === "loading" ? (
        <ShimmerText>Compacting the conversation</ShimmerText>
      ) : (
        <span>
          Conversation compacted
          {item.tokens ? ` from ${item.tokens.toLocaleString()} tokens` : ""}
        </span>
      )}
    </p>
  );
}

const APPROVAL_TITLE: Readonly<Record<string, string>> = {
  bash: "Run a command?",
  edit: "Edit a file?",
  write: "Write a file?",
};
const APPROVAL_STATE = {
  approved: "Approved",
  denied: "Denied",
  expired: "Not answered",
} as const;

function Waiting() {
  return (
    <p className="text-body text-secondary">
      Waiting for the owner of this agent to answer.
    </p>
  );
}

function ApprovalRow({
  item,
  context,
}: {
  item: ApprovalItem;
  context: RowContext;
}) {
  const { controls, channel, root, author } = context;
  const pending = item.state === "pending";
  const answerable =
    pending && controls?.canAnswer(channel, root, author, item);
  const view = detailView(item.detail, item.tool);
  return (
    <section
      className={styles.card}
      data-state={item.state}
      aria-label="Approval"
    >
      <header className={`${activity.row} text-body`}>
        <ShieldIcon size={16} aria-hidden="true" />
        <span className={styles.cardTitle}>
          {APPROVAL_TITLE[item.tool] ?? `Allow ${item.tool}?`}
        </span>
        {!pending && (
          <span className="text-secondary">
            {APPROVAL_STATE[item.state as keyof typeof APPROVAL_STATE]}
          </span>
        )}
      </header>
      {item.detail.type !== "shell" && view.subject && (
        <p className="text-body">{view.subject}</p>
      )}
      {view.body}
      {answerable && controls ? (
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="prominent"
            onClick={() =>
              controls.answer(channel, root, author, item, { approved: true })
            }
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="subtle"
            onClick={() =>
              controls.answer(channel, root, author, item, { approved: false })
            }
          >
            Deny
          </Button>
        </div>
      ) : (
        pending && <Waiting />
      )}
    </section>
  );
}

const QUESTION_STATE = {
  answered: "Answered",
  cancelled: "Dismissed",
  expired: "Not answered",
} as const;

function QuestionInput({
  onAnswer,
}: {
  onAnswer(answer: SessionAnswer): void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className={styles.actions}
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) onAnswer({ value: text.trim() });
      }}
    >
      <Input
        controlSize="sm"
        value={text}
        aria-label="Your answer"
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <Button
        size="sm"
        variant="prominent"
        type="submit"
        disabled={!text.trim()}
      >
        Send
      </Button>
      <Button
        size="sm"
        variant="subtle"
        onClick={() => onAnswer({ cancelled: true })}
      >
        Dismiss
      </Button>
    </form>
  );
}

function QuestionRow({
  item,
  context,
}: {
  item: QuestionItem;
  context: RowContext;
}) {
  const { controls, channel, root, author } = context;
  const pending = item.state === "pending";
  const answerable =
    pending && controls?.canAnswer(channel, root, author, item);
  const answer = (value: SessionAnswer) =>
    controls?.answer(channel, root, author, item, value);
  return (
    <section
      className={styles.card}
      data-state={item.state}
      aria-label="Question"
    >
      <header className={`${activity.row} text-body`}>
        <QuestionIcon size={16} aria-hidden="true" />
        <span className={styles.cardTitle}>{item.title || "Question"}</span>
        {!pending && (
          <span className="text-secondary">
            {QUESTION_STATE[item.state as keyof typeof QUESTION_STATE]}
          </span>
        )}
      </header>
      {item.text && <p className="text-body">{item.text}</p>}
      {!pending && item.answer && (
        <p className="text-body text-secondary">{item.answer}</p>
      )}
      {answerable && controls ? (
        item.method === "confirm" ? (
          <div className={styles.actions}>
            <Button
              size="sm"
              variant="prominent"
              onClick={() => answer({ approved: true })}
            >
              Yes
            </Button>
            <Button
              size="sm"
              variant="subtle"
              onClick={() => answer({ approved: false })}
            >
              No
            </Button>
          </div>
        ) : item.method === "select" ? (
          <div className={styles.actions}>
            {(item.options ?? []).map((option) => (
              <Button
                key={option}
                size="sm"
                variant="subtle"
                onClick={() => answer({ value: option })}
              >
                {option}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => answer({ cancelled: true })}
            >
              Dismiss
            </Button>
          </div>
        ) : (
          <QuestionInput onAnswer={answer} />
        )
      ) : (
        pending && <Waiting />
      )}
    </section>
  );
}

const RUN_STATE = {
  done: { label: "Done", icon: CheckCircleIcon },
  failed: { label: "Failed", icon: XCircleIcon },
  stopped: { label: "Stopped", icon: StopIcon },
} as const;

/** Who ran, and how the run stands. */
export function RunHeader({
  run,
  author,
  session,
}: {
  run: RunItem | undefined;
  author: string;
  session: RelaySession;
}) {
  const settled =
    run && run.state !== "running" ? RUN_STATE[run.state] : undefined;
  return (
    <header className={`${activity.row} ${styles.head}`}>
      <Author session={session} pubkey={author} />
      {run && !settled && (
        <span className={`${activity.row} text-body`} data-status="working">
          <span className="text-accent">
            <TypingDots size="small" />
          </span>
          <ShimmerText>Working</ShimmerText>
        </span>
      )}
      {run && settled && (
        <span
          className={`${activity.row} text-body ${run.state === "failed" ? activity.error : "text-secondary"}`}
          data-status={run.state}
        >
          <settled.icon size={16} aria-hidden="true" />
          <span>
            {settled.label}
            {run.end ? ` · ${duration(Math.max(0, run.end - run.at))}` : ""}
          </span>
        </span>
      )}
      {run?.error && (
        <span className={`text-body ${activity.error} ${styles.reason}`}>
          {run.error}
        </span>
      )}
    </header>
  );
}

export function ItemRow({
  item,
  context,
}: {
  item: SessionItem;
  context: RowContext;
}) {
  switch (item.kind) {
    case "assistant":
    case "reasoning":
      return <TextRow item={item} />;
    case "tool":
      return <ToolRow item={item} />;
    case "approval":
      return <ApprovalRow item={item} context={context} />;
    case "question":
      return <QuestionRow item={item} context={context} />;
    case "todo":
      return <TodoRow item={item} />;
    case "notice":
      return <NoticeRow item={item} />;
    case "compaction":
      return <CompactionRow item={item} />;
    case "run":
      return null;
  }
}
