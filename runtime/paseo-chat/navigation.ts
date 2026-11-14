import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

type Pane = {
  serverId: string;
  workspaceKey: string;
  tabId: string;
  element: HTMLElement;
  open(target: WorkspaceTabTarget): void;
};

const panes = new Set<Pane>();

export function registerPane(pane: Pane) {
  panes.add(pane);
  return () => {
    panes.delete(pane);
  };
}

function visible(pane: Pane) {
  return (
    pane.element.isConnected &&
    !pane.element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    pane.element.getClientRects().length > 0
  );
}

function findPane(match: (pane: Pane) => boolean, tabId?: string | null) {
  const candidates = [...panes].filter((pane) => match(pane) && visible(pane));
  return candidates.find((pane) => pane.tabId === tabId) ?? candidates.at(-1);
}

export function routeAgent(input: { serverId: string; agentId: string }) {
  const pane = findPane((item) => item.serverId === input.serverId);
  if (!pane) return false;
  pane.open({ kind: "agent", agentId: input.agentId });
  return true;
}

export function installWorkspaceNavigation() {
  const original = useWorkspaceLayoutStore.getState().openTab;
  useWorkspaceLayoutStore.setState({
    openTab: (input) => {
      const pane =
        input.intent === "background"
          ? undefined
          : findPane(
              (item) => item.workspaceKey === input.workspaceKey,
              input.parentTabId,
            );
      if (!pane) return original(input);
      pane.open(input.target);
      return null;
    },
  });
}
