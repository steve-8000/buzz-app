import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  PaseoJson,
  PaseoLocation,
  PaseoTarget,
} from "virtual:gram-paseo-chat";
import { PanelLocalTab, usePanelTabHost } from "../panels/PanelWorkspace";
import { Reading } from "../messages/use-reading";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { workstreams, type WorkstreamBinding } from "./workstreams";
import styles from "./PaseoThread.module.css";

const PaseoSurface = lazy(() =>
  import("virtual:gram-paseo-chat").then(({ PaseoSurface }) => ({
    default: PaseoSurface,
  })),
);

export function useThreadBindings(
  session: RelaySession,
  channelId: string,
  root: ChannelMessage | undefined,
  replies: readonly ChannelMessage[],
  disabled: boolean,
) {
  const all = useSyncExternalStore(workstreams.subscribe, workstreams.snapshot);
  const bindings = all.filter((binding) => {
    if (!root || disabled) return false;
    const exact = workstreams.matches(
      binding,
      session.viewer,
      session.scope,
      channelId,
      root.id,
    );
    const legacy =
      binding.lastMessage &&
      (binding.lastMessage === root.id ||
        replies.some((reply) => reply.id === binding.lastMessage)) &&
      workstreams.matches(binding, session.viewer, session.scope, channelId);
    return exact || legacy;
  });
  useLayoutEffect(() => {
    if (!root) return;
    for (const binding of bindings)
      if (!binding.root) workstreams.runtime?.promoteLegacy(binding, root.id);
  }, [bindings, root]);
  return bindings;
}

export function PaseoThread({
  bindings,
  root,
  replies,
  session,
  channelId,
  active,
  close,
}: {
  bindings: WorkstreamBinding[];
  root: ChannelMessage;
  replies: readonly ChannelMessage[];
  session: RelaySession;
  channelId: string;
  active: boolean;
  close?: (() => void) | undefined;
}) {
  const [selected, setSelected] = useState(() => bindings[0]?.key);
  const current = bindings.some((binding) => binding.key === selected)
    ? selected
    : bindings[0]?.key;
  const scroller = useRef<HTMLElement | null>(null);
  const settled = useRef(true);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const setScroller = useCallback((element: HTMLElement | null) => {
    scroller.current = element;
    setViewport(element);
  }, []);
  const messageIds = useMemo(
    () => new Set([root.id, ...replies.map((reply) => reply.id)]),
    [root.id, replies],
  );
  return (
    <section className={styles.thread} aria-label="Gram agent thread">
      {viewport && (
        <Reading
          session={session}
          channelId={channelId}
          rootId={root.id}
          scroller={scroller}
          settled={settled}
          enabled={active}
          acceptsMessageId={(id) => messageIds.has(id)}
        />
      )}
      <Suspense fallback={<p role="status">Opening Paseo…</p>}>
        {bindings.length > 1 && (
          <label className={styles.select}>
            Agent
            <select
              value={current ?? ""}
              onChange={(event) => setSelected(event.target.value)}
            >
              {bindings.map((binding) => (
                <option key={binding.key} value={binding.key}>
                  {binding.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {bindings.map((binding) => (
          <div
            key={binding.key}
            className={styles.pane}
            hidden={binding.key !== current}
          >
            {binding.created ? (
              <ThreadSession
                binding={binding}
                active={active && binding.key === current}
                close={close}
                onViewport={setScroller}
              />
            ) : (
              <div className={styles.pending}>
                <p>{root.content}</p>
                {workstreams.error(binding.key) ? (
                  <p role="alert">{workstreams.error(binding.key)}</p>
                ) : (
                  <p>Starting {binding.name}…</p>
                )}
              </div>
            )}
          </div>
        ))}
      </Suspense>
    </section>
  );
}

type Connection = {
  endpoint: string;
  serverId: string;
  workspaceId: string;
  password: string;
};
type Detail = {
  key: string;
  title: string;
  target: PaseoTarget;
  location?: PaseoLocation;
  state?: PaseoJson | undefined;
};

function targetTitle(target: PaseoTarget) {
  for (const key of ["path", "title", "agentId", "subagentId", "terminalId"]) {
    const value = target[key];
    if (typeof value === "string" && value)
      return value.split("/").at(-1) || value;
  }
  return target.kind.replaceAll("_", " ");
}

function uniqueTitle(
  target: PaseoTarget,
  details: Detail[],
  currentKey?: string,
) {
  const base = targetTitle(target);
  const titles = new Set(
    details.filter((item) => item.key !== currentKey).map((item) => item.title),
  );
  let title = base;
  for (let index = 2; titles.has(title); index++) title = `${base} (${index})`;
  return title;
}

function ThreadSession({
  binding,
  active,
  close,
  onViewport,
}: {
  binding: WorkstreamBinding;
  active: boolean;
  close?: (() => void) | undefined;
  onViewport(element: HTMLElement | null): void;
}) {
  const host = usePanelTabHost();
  const [connection, setConnection] = useState<Connection>();
  const [error, setError] = useState<string>();
  const target = useMemo<PaseoTarget>(
    () => ({ kind: "agent", agentId: binding.agentId }),
    [binding.agentId],
  );
  const [state, setState] = useState<PaseoJson>();
  const [details, setDetails] = useState<Detail[]>([]);
  const [inline, setInline] = useState<string>();
  const { key: bindingKey, agentId, serverId } = binding;
  useEffect(() => {
    let disposed = false;
    setConnection(undefined);
    setError(undefined);
    const current = workstreams.find(bindingKey);
    if (
      !current ||
      current.agentId !== agentId ||
      current.serverId !== serverId
    ) {
      setError("Gram thread binding is unavailable");
      return;
    }
    const opened = current.privateMessages
      ? current
      : { ...current, privateMessages: true };
    if (opened !== current) workstreams.save(opened);
    const runtime = workstreams.runtime;
    if (!runtime) setError("Gram runtime is unavailable");
    else
      void runtime
        .openChat(opened)
        .then((result) => {
          if (!disposed) setConnection(result);
        })
        .catch((failure: unknown) => {
          if (!disposed)
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );
        });
    return () => {
      disposed = true;
    };
  }, [bindingKey, agentId, serverId]);
  const openTarget = (next: PaseoTarget, location?: PaseoLocation) => {
    const key = JSON.stringify([next, location ?? null]);
    const existing = details.find(
      (item) => JSON.stringify([item.target, item.location ?? null]) === key,
    );
    if (existing) {
      if (!host) setInline(existing.key);
      else host.activate(host.owner, existing.title);
      return;
    }
    setDetails((current) => [
      ...current,
      {
        key,
        title: uniqueTitle(next, current),
        target: next,
        ...(location && { location }),
      },
    ]);
    if (!host) setInline(key);
  };
  const remove = (key: string) => {
    setDetails((current) => current.filter((item) => item.key !== key));
    setInline((current) => (current === key ? undefined : current));
  };
  const common = connection && {
    ...connection,
    cwd: binding.cwd,
    onOpenTarget: openTarget,
  };
  const surface = (detail: Detail) =>
    common && (
      <PaseoSurface
        {...common}
        workspaceId={detail.location?.workspaceId ?? common.workspaceId}
        cwd={detail.location?.cwd ?? common.cwd}
        tabId={`${binding.key}:${detail.key}`}
        target={detail.target}
        state={detail.state}
        active={active}
        onClose={() => remove(detail.key)}
        onRetarget={(next, location) =>
          setDetails((current) =>
            current.map((item) =>
              item.key === detail.key
                ? {
                    ...item,
                    target: next,
                    title: uniqueTitle(next, current, item.key),
                    ...(location && { location }),
                  }
                : item,
            ),
          )
        }
        onStateChange={(next) =>
          setDetails((current) =>
            current.map((item) =>
              item.key === detail.key ? { ...item, state: next } : item,
            ),
          )
        }
      />
    );
  return (
    <>
      {binding.queued.length > 0 && (
        <div className={styles.pending}>
          <p>Previously queued in Gram; not sent to Paseo:</p>
          {binding.queued.map((message) => (
            <pre key={message.id}>{message.text}</pre>
          ))}
        </div>
      )}
      {error ? (
        <p role="alert" className={styles.pending}>
          {error}
        </p>
      ) : !common ? (
        <p className={styles.pending}>Opening Paseo…</p>
      ) : (
        <>
          {!inline && (
            <PaseoSurface
              {...common}
              tabId={`${binding.key}:thread`}
              target={target}
              state={state}
              active={active}
              onViewport={onViewport}
              onClose={() => {
                if (!close)
                  throw new Error("This embedded thread cannot be closed");
                close();
              }}
              onRetarget={openTarget}
              onStateChange={setState}
            />
          )}
          {details.map((detail) =>
            host ? (
              <PanelLocalTab
                key={detail.key}
                title={detail.title}
                close={() => remove(detail.key)}
              >
                {surface(detail)}
              </PanelLocalTab>
            ) : inline === detail.key ? (
              <div key={detail.key} className={styles.pane}>
                <button type="button" onClick={() => setInline(undefined)}>
                  Back to thread
                </button>
                {surface(detail)}
              </div>
            ) : null,
          )}
        </>
      )}
    </>
  );
}
