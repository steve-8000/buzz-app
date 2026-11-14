import type { ComponentType } from "react";
import type { SessionControls } from "../../features/agent-session/controls";
import { SessionView } from "../../features/agent-session/SessionView";
import type { SessionSource } from "../../features/agent-session/use-entries";
import type { PanelProps } from "../../features/panels/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { parseSessionTarget } from "./session-link";

/** The panel a session link opens: one omp agent's session in a conversation,
 * live while it runs. */
export function sessionPanel(
  source: SessionSource,
  controls: SessionControls,
  relay: RelayData,
): ComponentType<PanelProps> {
  return function SessionPanel({ target }: PanelProps) {
    const found = parseSessionTarget(target);
    const { session } = useRelayConnection(relay);
    if (!found) return null;
    return (
      <SessionView
        source={source}
        controls={controls}
        session={session}
        channel={found.channel}
        root={found.root ?? ""}
        author={found.agent}
      />
    );
  };
}
