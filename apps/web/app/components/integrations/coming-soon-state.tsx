import { Link } from "@remix-run/react";
import { PageShell } from "~/components/page-shell";

/**
 * A catalog entry the registry lists but has not opened. It renders the page frame rather than an
 * error, because nothing failed: the destination exists and is simply not ready to be connected.
 */
export function ComingSoonState({ name }: { name: string }) {
  return (
    <PageShell
      crumbs={[{ label: "Integrations", to: "/integrations" }, { label: name }]}
      title={name}
      description="Coming soon."
    >
      <div className="flex max-w-prose flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          This integration is listed so you can see what is next. There is no setup to complete yet,
          and no credentials to hand over.
        </p>
        <Link
          to="/integrations"
          className="w-fit rounded-sm font-medium text-primary transition-colors duration-150 hover:underline"
        >
          Back to integrations
        </Link>
      </div>
    </PageShell>
  );
}
