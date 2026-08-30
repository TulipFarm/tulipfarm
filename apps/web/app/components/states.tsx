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
  const isTransportError = status === undefined;
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
            : "The API responded, but could not complete this request."}
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
