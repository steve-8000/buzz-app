import "@/polyfills/install-early";
import "@/styles/unistyles";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { PortalProvider } from "@gorhom/portal";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
// biome-ignore lint/style/noRestrictedImports: Paseo components require their native icon provider.
import { LucideProvider } from "lucide-react-native";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/data/query-client";
import { I18nProvider } from "@/i18n/provider";
import { AppearanceProvider } from "@/appearance/provider";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { ToastViewport, useToastHost } from "@/components/toast-host";
import { VoiceProvider } from "@/contexts/voice-context";
import { HorizontalScrollProvider } from "@/contexts/horizontal-scroll-context";
import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import { WindowLayoutProvider } from "@/window-layout";
import { WindowChromeProvider } from "@/utils/desktop-window";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import { CommandCenterProvider } from "@/command-center/provider";
import { ComposerEditingSessionsProvider } from "@/composer/editing-session";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { ImportSessionSheet } from "@/components/import-session-sheet";
import { PaneFocusProvider, PaneProvider } from "@/panels/pane-context";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import { getPanelRegistration } from "@/panels/panel-registry";
import { SessionProvider } from "@/contexts/session-context";
import {
  HostRuntimeStore,
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceTabTarget,
} from "@/workspace-tabs/model";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { workstreams } from "../../src/features/agent-chat/workstreams";
import { installWorkspaceNavigation, registerPane } from "./navigation";

const registry = new Map<string, string>();
const hostRuntime = new HostRuntimeStore({
  storage: {
    async getItem(key) {
      return registry.get(key) ?? null;
    },
    async setItem(key, value) {
      registry.set(key, value);
    },
    async removeItem(key) {
      registry.delete(key);
    },
  },
});
Reflect.set(globalThis, "__paseoHostRuntimeStore", hostRuntime);
installWorkspaceNavigation();
ensurePanelsRegistered();

function HostSession({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  return client ? (
    <SessionProvider serverId={serverId} client={client}>
      {null}
    </SessionProvider>
  ) : null;
}

function HostSessions() {
  const hosts = useHosts();
  return hosts.map((host) => (
    <HostSession key={host.serverId} serverId={host.serverId} />
  ));
}

function RuntimeLifecycle() {
  const runtime = useSyncExternalStore(
    workstreams.subscribe,
    () => workstreams.runtime,
    () => undefined,
  );
  useEffect(() => {
    if (runtime) return;
    const hosts = hostRuntime.getHosts();
    if (!hosts.length) return;
    connections.clear();
    clearing = Promise.all(
      hosts.map((host) => hostRuntime.removeHost(host.serverId)),
    ).then(() => {});
    void clearing.catch(console.error);
  }, [runtime]);
  return null;
}

function ToastEnvironment({ children }: { children: ReactNode }) {
  const { api, toast, dismiss } = useToastHost();
  return (
    <ToastApiProvider api={api}>
      {children}
      <SafeAreaProvider
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          pointerEvents: "none",
        }}
      >
        <ToastViewport toast={toast} onDismiss={dismiss} />
      </SafeAreaProvider>
    </ToastApiProvider>
  );
}

export function PaseoEnvironment({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastEnvironment>
          <VoiceProvider>
            <RuntimeLifecycle />
            <HostSessions />
            {children}
          </VoiceProvider>
        </ToastEnvironment>
      </I18nProvider>
    </QueryClientProvider>
  );
}

const connections = new Map<
  string,
  { endpoint: string; password: string; ready: Promise<void> }
>();
let clearing: Promise<void> = Promise.resolve();
function connect(input: {
  serverId: string;
  endpoint: string;
  password: string;
}) {
  const previous = connections.get(input.serverId);
  if (
    previous?.endpoint === input.endpoint &&
    previous.password === input.password
  )
    return previous.ready;
  const ready = clearing
    .then(() =>
      getHostRuntimeStore().upsertDirectConnection({ ...input, label: "Gram" }),
    )
    .then(() => {});
  const current = { endpoint: input.endpoint, password: input.password, ready };
  connections.set(input.serverId, current);
  void ready.catch(() => {
    if (connections.get(input.serverId) === current)
      connections.delete(input.serverId);
  });
  return ready;
}

export interface PaseoSurfaceProps {
  endpoint: string;
  password: string;
  serverId: string;
  workspaceId: string;
  cwd: string;
  tabId: string;
  target: WorkspaceTabTarget;
  state?: JsonValue;
  active: boolean;
  onViewport?: (element: HTMLElement | null) => void;
  onOpenTarget(
    target: WorkspaceTabTarget,
    location?: { workspaceId: string; cwd: string },
  ): void;
  onClose(): void;
  onRetarget(
    target: WorkspaceTabTarget,
    location?: { workspaceId: string; cwd: string },
  ): void;
  onStateChange(state: JsonValue): void;
}

export function PaseoSurface(props: PaseoSurfaceProps) {
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const { serverId, endpoint, password } = props;
  useEffect(() => {
    let current = true;
    setReady(false);
    setError(undefined);
    void connect({ serverId, endpoint, password })
      .then(() => {
        if (current) setReady(true);
      })
      .catch((failure: unknown) => {
        if (current)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => {
      current = false;
    };
  }, [serverId, endpoint, password]);
  if (error) return <p role="alert">{error}</p>;
  if (!ready) return <p role="status">Connecting to Gram…</p>;
  return (
    <div
      data-paseo-chat=""
      style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}
    >
      <SafeAreaProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <LucideProvider>
            <KeyboardActionDispatcherProvider>
              <WindowLayoutProvider>
                <WindowChromeProvider>
                  <KeyboardProvider>
                    <KeyboardShiftProvider>
                      <PortalProvider>
                        <BottomSheetModalProvider>
                          <SidebarCalloutProvider>
                            <AppearanceProvider>
                              <MobilePanelsProvider>
                                <HorizontalScrollProvider>
                                  <CommandCenterProvider>
                                    <ComposerEditingSessionsProvider>
                                      <Pane {...props} />
                                    </ComposerEditingSessionsProvider>
                                  </CommandCenterProvider>
                                </HorizontalScrollProvider>
                              </MobilePanelsProvider>
                            </AppearanceProvider>
                          </SidebarCalloutProvider>
                        </BottomSheetModalProvider>
                      </PortalProvider>
                    </KeyboardShiftProvider>
                  </KeyboardProvider>
                </WindowChromeProvider>
              </WindowLayoutProvider>
            </KeyboardActionDispatcherProvider>
          </LucideProvider>
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </div>
  );
}

function Pane(props: PaseoSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [importing, setImporting] = useState(false);
  const client = useHostRuntimeClient(props.serverId);
  const sync = useSessionStore(
    (state) => state.sessions[props.serverId]?.viewedTimelineSync ?? null,
  );
  const agentId =
    props.target.kind === "agent"
      ? props.target.agentId
      : props.target.kind === "provider_subagent"
        ? props.target.parentAgentId
        : undefined;
  const agent = useSessionStore((state) =>
    agentId
      ? (state.sessions[props.serverId]?.agents.get(agentId) ??
        state.sessions[props.serverId]?.agentDetails.get(agentId))
      : undefined,
  );
  const workspaceId = agent?.workspaceId ?? props.workspaceId;
  const cwd = agent?.cwd ?? props.cwd;
  const onOpenTarget = props.onOpenTarget;
  const openTarget = useCallback(
    (target: WorkspaceTabTarget) => onOpenTarget(target, { workspaceId, cwd }),
    [onOpenTarget, workspaceId, cwd],
  );
  useEffect(() => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: props.serverId,
      workspaceId,
    });
    if (!ref.current || !props.active || !workspaceKey) return;
    return registerPane({
      serverId: props.serverId,
      workspaceKey,
      tabId: props.tabId,
      element: ref.current,
      open: openTarget,
    });
  }, [props.serverId, props.tabId, props.active, workspaceId, openTarget]);
  useEffect(() => {
    const node = ref.current;
    if (!node || !props.active || !props.onViewport) return;
    const onViewport = props.onViewport;
    let previous: HTMLElement | null = null;
    const update = () => {
      const next = node.querySelector<HTMLElement>(
        '[data-testid="agent-chat-scroll"]',
      );
      if (next !== previous) {
        previous = next;
        onViewport(next);
      }
    };
    const observer = new MutationObserver(update);
    observer.observe(node, { childList: true, subtree: true });
    update();
    return () => {
      observer.disconnect();
      onViewport(null);
    };
  }, [props.active, props.onViewport]);
  useEffect(() => {
    if (!sync || !agentId || !props.active) return;
    sync.replaceVisibleAgentIds(props.tabId, [agentId]);
    return () => sync.replaceVisibleAgentIds(props.tabId, []);
  }, [sync, agentId, props.active, props.tabId]);
  const pane = useMemo(
    () => ({
      serverId: props.serverId,
      workspaceId,
      host: "main" as const,
      tabId: props.tabId,
      target: props.target,
      state: props.state,
      openTab: openTarget,
      openPreferredTarget: openTarget,
      openTargetToSide: openTarget,
      closeCurrentTab: props.onClose,
      retargetCurrentTab: (target: WorkspaceTabTarget) =>
        props.onRetarget(target, { workspaceId, cwd }),
      setCurrentTabState: props.onStateChange,
      openFileInWorkspace: (request: {
        location: { path: string; lineStart?: number; lineEnd?: number };
      }) => openTarget({ kind: "file", ...request.location }),
      openImportSheet: () => setImporting(true),
    }),
    [props, workspaceId, cwd, openTarget],
  );
  const focus = useMemo(
    () => ({
      isWorkspaceFocused: props.active,
      isPaneFocused: props.active,
      isInteractive: props.active,
      focusPane: () => ref.current?.focus(),
    }),
    [props.active],
  );
  const Panel = getPanelRegistration(props.target.kind)?.component;
  if (!Panel) throw new Error(`Unsupported Paseo panel: ${props.target.kind}`);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}
    >
      <RetainedPanelActivity active={props.active}>
        <PaneFocusProvider value={focus}>
          <PaneProvider value={pane}>
            <Panel />
            <ImportSessionSheet
              visible={importing}
              client={client}
              serverId={props.serverId}
              workspaceId={workspaceId}
              cwd={cwd}
              onClose={() => setImporting(false)}
              onImportedAgent={(id) =>
                openTarget({ kind: "agent", agentId: id })
              }
              onImported={(agent) =>
                openTarget({ kind: "agent", agentId: agent.id })
              }
            />
          </PaneProvider>
        </PaneFocusProvider>
      </RetainedPanelActivity>
    </div>
  );
}
