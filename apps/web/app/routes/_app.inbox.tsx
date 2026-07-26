import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { EmptyState } from "~/components/empty-state";
import { InboxItem } from "~/components/inbox/inbox-item";
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
      <EmptyState
        section="inbox"
        title="Inbox"
        hint="No Approvals, human tasks, form waits, or access requests need attention."
      />
    );
  }
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-lg font-semibold">Inbox</h1>
        <p className="text-xs text-muted-foreground">
          Exact server-authorized decisions and waiting work.
        </p>
      </header>
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
    </div>
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
