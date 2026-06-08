/*
 * Full-page states for the Resources pages, framed as a centered terminal card (same idiom as
 * empty-state.tsx). ErrorState handles 401 with explicit "authentication required" copy and a hint
 * to set VITE_API_TOKEN; NotFoundState covers a missing record (404).
 */

function Frame({
  section,
  command,
  children,
}: {
  section: string;
  command: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto flex h-full max-w-xl flex-col justify-center px-6 py-16">
      <div className="rounded-sm border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span className="font-medium uppercase tracking-[0.2em]">
            <span className="text-primary">[</span>
            {section}
            <span className="text-primary">]</span>
          </span>
          <span aria-hidden className="ml-auto opacity-60">
            tulipfarm
          </span>
        </div>
        <div className="flex flex-col gap-4 px-4 py-6 text-sm">
          <p className="text-muted-foreground">
            <span aria-hidden className="text-primary">
              ${" "}
            </span>
            {command}
          </p>
          {children}
        </div>
      </div>
    </section>
  );
}

export function ErrorState({
  section,
  command,
  status,
  message,
}: {
  section: string;
  command: string;
  status?: number;
  message?: string;
}) {
  const isAuth = status === 401;
  return (
    <Frame section={section} command={command}>
      <p className="text-destructive">
        error: {status ? `${status} ` : ""}
        {isAuth ? "authentication required" : (message ?? "request failed")}
      </p>
      <p className="text-muted-foreground">
        {isAuth
          ? "Sign in, or set VITE_API_TOKEN in apps/web/.env.local to authenticate this session."
          : "The resource API could not be reached. Check that the API is running on :4010."}
      </p>
    </Frame>
  );
}

export function NotFoundState({ section, command }: { section: string; command: string }) {
  return (
    <Frame section={section} command={command}>
      <p className="text-destructive">error: 404 not found</p>
      <p className="text-muted-foreground">No record matches that id (it may have been deleted).</p>
    </Frame>
  );
}
