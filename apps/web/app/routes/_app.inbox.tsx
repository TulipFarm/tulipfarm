import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { EmptyState } from "~/components/empty-state";
import { InboxItem } from "~/components/inbox/inbox-item";
import { PageShell } from "~/components/page-shell";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { decideApproval, getInbox } from "~/lib/inbox";

export async function clientLoader() {
  return { items: await getInbox() };
}

export default function InboxRoute() {
  const { items } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [busyId, setBusyId] = useState<string>();
  if (items.length === 0) {
    return (
      <PageShell title="Inbox" description="Exact server-authorized decisions and waiting work.">
        <EmptyState
          section="inbox"
          title="Nothing is waiting on you"
          hint="Approvals, human tasks, form waits, and access requests appear here."
        />
      </PageShell>
    );
  }
  return (
    <PageShell title="Inbox" description="Exact server-authorized decisions and waiting work.">
      <>
        {items.map((item) => (
          <InboxItem
            key={item.id}
            item={item}
            busy={busyId === item.id}
            onDecision={async (decision) => {
              setBusyId(item.id);
              try {
                await decideApproval(item, decision);
                revalidator.revalidate();
              } finally {
                setBusyId(undefined);
              }
            }}
          />
        ))}
      </>
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <ErrorState
      section="inbox"
      status={error instanceof ApiError ? error.status : undefined}
      message={error instanceof Error ? error.message : undefined}
    />
  );
}
