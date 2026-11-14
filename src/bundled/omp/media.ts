// What a run shows besides its final message: images a tool returned, such as
// a screenshot, and diagrams it wrote between tool calls. They are read off
// omp's events, so showing them in the conversation costs the model nothing.
import { type Frame, isRecord } from "./rpc";

export type Shot = Readonly<{
  data: string;
  mime: string;
  tool: string;
  /** Equal for the same picture shown twice. */
  key: string;
}>;

const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const FENCE = /```(?:mermaid|buzz-chart)[^\n]*\n[\s\S]*?\n```/g;
const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function extension(mime: string) {
  return EXTENSION[mime] ?? "bin";
}

/** The images a finished tool call returned. */
export function shotsOf(frame: Frame): Shot[] {
  if (frame.type !== "tool_execution_end" || !isRecord(frame.result)) return [];
  const content = frame.result.content;
  if (!Array.isArray(content)) return [];
  const tool = typeof frame.toolName === "string" ? frame.toolName : "tool";
  return content.flatMap((part: unknown) => {
    if (!isRecord(part) || part.type !== "image") return [];
    const { data, mimeType } = part;
    if (
      typeof data !== "string" ||
      typeof mimeType !== "string" ||
      data.startsWith("blob:") ||
      !IMAGE.test(mimeType)
    )
      return [];
    return [
      {
        data,
        mime: mimeType,
        tool,
        key: `${data.length}:${data.slice(0, 48)}:${data.slice(-48)}`,
      },
    ];
  });
}

/** Diagram blocks in an assistant message that goes on to call tools. The
 * final message is posted whole, with its diagrams. */
export function diagramsOf(frame: Frame): string[] {
  const message = frame.message;
  if (
    frame.type !== "message_end" ||
    !isRecord(message) ||
    message.role !== "assistant" ||
    message.stopReason !== "toolUse"
  )
    return [];
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = parts
    .map((part: unknown) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
  return text.match(FENCE) ?? [];
}
