import { ExternalLink, KeyRound } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button";

export interface OAuthFlowCapabilities {
  readonly browser: boolean;
  readonly device: boolean;
}

interface OAuthConnectActionsProps {
  readonly flows: OAuthFlowCapabilities;
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly onStart: (flow: "browser" | "device") => void;
}

/** Explicit OAuth entry points; never hides a supported flow behind a fallback. */
export function OAuthConnectActions({ flows, disabled = false, pending = false, onStart }: OAuthConnectActionsProps): ReactElement | null {
  if (!flows.browser && !flows.device) return null;
  return (
    <>
      {flows.browser && (
        <Button
          variant="secondary"
          className="h-10 min-w-[132px] gap-2 px-3 text-xs"
          size="sm"
          disabled={disabled || pending}
          onClick={() => onStart("browser")}
          aria-label="Login with OAuth"
        >
          <ExternalLink size={16} /> <span className="truncate">{pending ? "Starting…" : "Login OAuth"}</span>
        </Button>
      )}
      {flows.device && (
        <Button
          variant="secondary"
          className="h-10 min-w-[150px] gap-2 px-3 text-xs"
          size="sm"
          disabled={disabled || pending}
          onClick={() => onStart("device")}
          aria-label="Login with OAuth device code"
        >
          <KeyRound size={16} /> <span className="truncate">{pending ? "Starting…" : "Login OAuth (device)"}</span>
        </Button>
      )}
    </>
  );
}
