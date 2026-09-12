import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { EmptyState } from "~/components/empty-state";
import { FormStatus } from "~/components/form-status";
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
  const [refusal, setRefusal] = useState<string>();
  if (items.length === 0) {
    return (
      <PageShell title="Inbox" description="Requests and decisions that need your attention.">
        <EmptyState
          section="inbox"
          title="Nothing is waiting on you"
          hint="Review approvals, answer questions, and manage access requests here."
        />
      </PageShell>
    );
  }
  return (
    <PageShell title="Inbox" description="Requests and decisions that need your attention.">
      {refusal ? <FormStatus tone="error">{refusal}</FormStatus> : null}
      {items.map((item) => (
        <InboxItem
          key={item.id}
          item={item}
          busy={busyId === item.id}
          onDecision={async (decision) => {
            setBusyId(item.id);
            try {
              await decideApproval(item, decision);
              setRefusal(undefined);
              revalidator.revalidate();
            } catch (error) {
              // A refused decision is an answer, not a crash: four-eyes, an expired window, or a
              // race with another approver all land here and must stay on screen.
              setRefusal(
                error instanceof Error ? error.message : "Could not record that decision."
              );
            } finally {
              setBusyId(undefined);
            }
          }}
        />
      ))}
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
