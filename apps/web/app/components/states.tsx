function Frame({ section, children }: { section: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto flex h-full max-w-xl flex-col justify-center px-6 py-16">
      <div className="rounded-sm border border-border bg-card">
        <p className="border-b border-border px-4 py-2 text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          {section}
        </p>
        <div className="flex flex-col gap-4 px-4 py-6 text-sm">{children}</div>
      </div>
    </section>
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
