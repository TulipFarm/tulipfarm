import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";

export type ConnectionState = "online" | "offline" | "reconnecting";

export function ConnectionStatus({ state, attempt }: { state: ConnectionState; attempt?: number }) {
  const copy =
    state === "online"
      ? "Connected"
      : state === "offline"
        ? "Offline. Changes are not being sent."
        : `Reconnecting${attempt ? ` · attempt ${attempt}` : ""}`;
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn("text-xs text-muted-foreground", state === "offline" && "text-destructive")}
    >
      {copy}
    </p>
  );
}

export function GlobalConnectionStatus() {
  const [state, setState] = useState<ConnectionState>(() =>
    typeof navigator === "undefined" || navigator.onLine ? "online" : "offline"
  );

  useEffect(() => {
    const online = () => setState("reconnecting");
    const offline = () => setState("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  if (state === "online") return null;
  return (
    <div className="fixed bottom-3 right-3 z-50 border border-border bg-card px-3 py-2">
      <ConnectionStatus state={state} />
    </div>
  );
}

export function PermissionDeniedState({ correlationId }: { correlationId?: string }) {
  return (
    <section role="alert" className="border border-border bg-card px-4 py-3">
      <p className="text-sm font-medium">Permission denied</p>
      <p className="mt-1 text-xs text-muted-foreground">
        This view is not available to your current role.
        {correlationId ? ` Reference: ${correlationId}.` : ""}
      </p>
    </section>
  );
}

export function DestructivePreview({
  action,
  target,
  destination,
  reversibility,
  busy = false,
  onConfirm,
  onCancel,
}: {
  action: string;
  target: string;
  destination: string;
  reversibility: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}) {
  return (
    <section
      aria-labelledby="destructive-preview-title"
      className="border border-destructive/40 bg-card"
    >
      <h2
        id="destructive-preview-title"
        className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-[0.2em]"
      >
        Confirm {action}
      </h2>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 px-3 py-3 text-xs">
        <dt className="text-muted-foreground">Target</dt>
        <dd>{target}</dd>
        <dt className="text-muted-foreground">Destination</dt>
        <dd>{destination}</dd>
        <dt className="text-muted-foreground">Reversibility</dt>
        <dd>{reversibility}</dd>
      </dl>
      <div className="flex justify-end gap-2 border-t border-border px-3 py-2">
        {onCancel ? (
          <button
            type="button"
            className="rounded-sm border border-border px-2 py-1 text-xs"
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          className="rounded-sm bg-destructive px-2 py-1 text-xs text-destructive-foreground disabled:opacity-60"
          onClick={onConfirm}
        >
          Confirm {action}
        </button>
      </div>
    </section>
  );
}
