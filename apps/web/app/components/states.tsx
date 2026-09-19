import { PageShell } from "./page-shell";

const sentenceCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * A route's `ErrorBoundary` renders in place of the route, so these render the page frame
 * themselves rather than a centred card. A failed page is still that page: same column, same
 * title, same place on screen as the version that loaded.
 */
function Frame({ section, children }: { section: string; children: React.ReactNode }) {
  return (
    <PageShell title={sentenceCase(section)}>
      <div className="flex flex-col gap-2 text-sm">{children}</div>
    </PageShell>
  );
}

export function ErrorState({
  section,
  status,
  message,
}: {
  section: string;
  status?: number;
  message?: string;
}) {
  const isAuth = status === 401;
  const isTransportError = status === 0;
  return (
    <Frame section={section}>
      <p className="text-destructive">
        error: {status ? `${status} ` : ""}
        {isAuth ? "authentication required" : (message ?? "request failed")}
      </p>
      <p className="text-muted-foreground">
        {isAuth
          ? "Sign in, or set VITE_API_TOKEN in apps/web/.env.local to authenticate this session."
          : isTransportError
            ? "The API could not be reached. Check that it is running on :4010."
            : status !== undefined
              ? "The API responded, but could not complete this request."
              : "This page could not be loaded. Try reloading it."}
      </p>
    </Frame>
  );
}

export function NotFoundState({ section }: { section: string }) {
  return (
    <Frame section={section}>
      <p className="text-destructive">error: 404 not found</p>
      <p className="text-muted-foreground">No record matches that id (it may have been deleted).</p>
    </Frame>
  );
}

/**
 * A 404 from an action that advertised itself as available, distinct from {@link NotFoundState}:
 * the record exists, but this deployment (or this reader) cannot reach that capability for it.
 * The message stays this generic on purpose — it must read the same whether the capability is
 * simply unwired here or the request was denied, so neither case leaks the other.
 */
export function UnavailableActionState({ section, message }: { section: string; message: string }) {
  return (
    <Frame section={section}>
      <p className="text-destructive">error: 404 unavailable</p>
      <p className="text-muted-foreground">{message}</p>
    </Frame>
  );
}
