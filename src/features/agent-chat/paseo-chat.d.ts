declare module "virtual:gram-paseo-chat" {
  import type { ReactNode } from "react";

  export type PaseoJson =
    | null
    | boolean
    | number
    | string
    | PaseoJson[]
    | { [key: string]: PaseoJson };
  export type PaseoTarget = { kind: string; [key: string]: unknown };
  export type PaseoLocation = { workspaceId: string; cwd: string };

  export function PaseoEnvironment(props: { children: ReactNode }): ReactNode;
  export function PaseoSurface(props: {
    endpoint: string;
    password: string;
    serverId: string;
    workspaceId: string;
    cwd: string;
    tabId: string;
    target: PaseoTarget;
    state?: PaseoJson | undefined;
    active: boolean;
    onViewport?: ((element: HTMLElement | null) => void) | undefined;
    onOpenTarget(target: PaseoTarget, location?: PaseoLocation): void;
    onClose(): void;
    onRetarget(target: PaseoTarget, location?: PaseoLocation): void;
    onStateChange(state: PaseoJson): void;
  }): ReactNode;
}
