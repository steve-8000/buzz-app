// Lays out a flow's steps as the reader chose to see them: all of them, tool
// calls folded into groups, or each finished turn folded into one line under
// its prompt. The reply a run posted always stays in view.
import type { SessionDisplay } from "./display-preference";
import type { FlowNode, Segment } from "./flow";
import type { RunItem, SessionItem } from "./item";

/** What a stretch of work did, counted. */
export type Summary = Readonly<{
  thoughts: number;
  edited: number;
  commands: number;
  read: number;
  searches: number;
  other: number;
}>;

export type Row =
  | Readonly<{ type: "item"; key: string; item: SessionItem }>
  /** Two or more tool calls (and thoughts) in a row, behind one line. */
  | Readonly<{
      type: "group";
      key: string;
      items: readonly SessionItem[];
      summary: Summary;
    }>
  /** Everything a finished run did before its answer, behind one line. */
  | Readonly<{
      type: "turn";
      key: string;
      items: readonly SessionItem[];
      summary: Summary;
    }>;

export type PresentedSegment = Readonly<{
  type: "segment";
  key: string;
  author: string;
  run: RunItem | undefined;
  rows: readonly Row[];
}>;
export type PresentedNode =
  | Extract<FlowNode, { type: "reply" }>
  | PresentedSegment;

export function summarize(items: readonly SessionItem[]): Summary {
  const edited = new Set<string>();
  const read = new Set<string>();
  let thoughts = 0;
  let commands = 0;
  let searches = 0;
  let other = 0;
  for (const item of items) {
    if (item.kind === "reasoning") thoughts++;
    if (item.kind !== "tool") continue;
    switch (item.detail.type) {
      case "edit":
      case "write":
        edited.add(item.detail.filePath);
        break;
      case "shell":
        commands++;
        break;
      case "read":
        read.add(item.detail.filePath);
        break;
      case "search":
        searches++;
        break;
      default:
        other++;
    }
  }
  return {
    thoughts,
    edited: edited.size,
    commands,
    read: read.size,
    searches,
    other,
  };
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** One sentence for a summary, such as "Edited 2 files and ran 3 commands". */
export function summaryLabel(summary: Summary): string {
  const parts = [
    summary.edited > 0 && `edited ${plural(summary.edited, "file", "files")}`,
    summary.commands > 0 &&
      `ran ${plural(summary.commands, "command", "commands")}`,
    summary.read > 0 && `read ${plural(summary.read, "file", "files")}`,
    summary.searches > 0 &&
      `searched ${summary.searches === 1 ? "1 time" : `${summary.searches} times`}`,
    summary.other > 0 &&
      `used ${summary.other} other ${summary.other === 1 ? "tool" : "tools"}`,
  ].filter((part): part is string => part !== false);
  const last = parts.pop();
  if (last === undefined) return summary.thoughts > 0 ? "Thought" : "";
  const sentence = parts.length
    ? `${parts.join(", ")}${parts.length > 1 ? "," : ""} and ${last}`
    : last;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

const worked = ({ thoughts: _, ...counts }: Summary) =>
  Object.values(counts).some((count) => count > 0);

const itemRow = (item: SessionItem): Row => ({
  type: "item",
  key: String(item.seq),
  item,
});

/** Tool calls fold into groups; reasoning does too, unless it is shown open. */
const groupable = (item: SessionItem, display: SessionDisplay) =>
  item.kind === "tool" ||
  (item.kind === "reasoning" && !display.autoExpandReasoning);

function rowsOf(items: readonly SessionItem[], display: SessionDisplay): Row[] {
  if (display.chatDisplay === "full") return items.map(itemRow);
  const rows: Row[] = [];
  let pending: SessionItem[] = [];
  const flush = () => {
    const first = pending[0];
    if (first && pending.length > 1)
      rows.push({
        type: "group",
        key: `group:${first.seq}`,
        items: pending,
        summary: summarize(pending),
      });
    else rows.push(...pending.map(itemRow));
    pending = [];
  };
  for (const item of items) {
    if (groupable(item, display)) pending.push(item);
    else {
      flush();
      rows.push(itemRow(item));
    }
  }
  flush();
  return rows;
}

/** What stays in view when a turn folds: a compaction, and what went wrong. */
const staysVisible = (item: SessionItem) =>
  item.kind === "compaction" ||
  (item.kind === "notice" && item.level === "error");

type Fold = Readonly<{ turn: Row; folded: ReadonlySet<SessionItem> }>;

/** Each run that finished and answered folds everything before its last text
 * into one row. One still going, failed, stopped or never answered stays open. */
function foldTurns(nodes: readonly FlowNode[]): Map<string, Fold> {
  const runs = new Map<string, Segment[]>();
  for (const node of nodes)
    if (node.type === "segment") {
      const stretches = runs.get(node.runKey);
      if (stretches) stretches.push(node);
      else runs.set(node.runKey, [node]);
    }
  const folds = new Map<string, Fold>();
  for (const [runKey, stretches] of runs) {
    const first = stretches[0];
    if (first?.runState !== "done") continue;
    const all = stretches.flatMap((stretch) => stretch.items);
    let lastText = -1;
    for (let at = all.length - 1; at >= 0 && lastText < 0; at--)
      if (all[at]?.kind === "assistant") lastText = at;
    if (lastText < 0 && !first.answered) continue;
    const folded = all
      .slice(0, lastText < 0 ? all.length : lastText)
      .filter((item) => !staysVisible(item));
    const summary = summarize(folded);
    if (!worked(summary) && !folded.some((item) => item.kind === "assistant"))
      continue;
    folds.set(runKey, {
      turn: { type: "turn", key: `turn:${runKey}`, items: folded, summary },
      folded: new Set(folded),
    });
  }
  return folds;
}

export function present(
  nodes: readonly FlowNode[],
  display: SessionDisplay,
): PresentedNode[] {
  const folds =
    display.chatDisplay === "collapseTurns" ? foldTurns(nodes) : undefined;
  const placed = new Set<string>();
  const presented: PresentedNode[] = [];
  for (const node of nodes) {
    if (node.type === "reply") {
      presented.push(node);
      continue;
    }
    const fold = folds?.get(node.runKey);
    const rows = rowsOf(
      fold ? node.items.filter((item) => !fold.folded.has(item)) : node.items,
      display,
    );
    if (fold && !placed.has(node.runKey)) {
      placed.add(node.runKey);
      rows.unshift(fold.turn);
    }
    // A stretch a fold emptied has nothing left to show, not even a header.
    if (!rows.length && !node.run) continue;
    presented.push({
      type: "segment",
      key: node.key,
      author: node.author,
      run: node.run,
      rows,
    });
  }
  return presented;
}
