import { navigateToAgent as upstreamNavigateToAgent } from "virtual:paseo-upstream-navigate";
import type { NavigateToAgentInput } from "virtual:paseo-upstream-navigate";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { routeAgent } from "./navigation";

export type { NavigateToAgentInput };

export function navigateToAgent(input: NavigateToAgentInput): string {
  if (routeAgent(input))
    return buildHostAgentDetailRoute(
      input.serverId,
      input.agentId,
      input.workspaceId ?? undefined,
    );
  return upstreamNavigateToAgent(input);
}
