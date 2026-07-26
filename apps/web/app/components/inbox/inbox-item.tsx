import type { InboxItemModel } from "~/lib/inbox";

function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  );
}

export function InboxItem({
  item,
  busy = false,
  onDecision,
}: {
  item: InboxItemModel;
  busy?: boolean;
  onDecision: (decision: "approved" | "denied") => void;
}) {
  const isApproval = item.kind === "approval";
  return (
    <article className="border border-border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          {item.kind.replace("_", " ")}
        </span>
        <h2 className="text-sm font-medium">{item.title}</h2>
        <span className="ml-auto text-xs">
          {item.risk} risk · {item.status}
        </span>
      </header>
      <dl className="flex flex-col gap-2 px-3 py-3 text-xs">
        <Row label="Intent" value={item.intentDigest} />
        <Row label="Guardrail" value={item.guardrailRevision} />
        <Row label="Target" value={item.target} />
        <Row label="Destination" value={item.destination} />
        <Row label="Fields" value={item.fields?.join(", ")} />
        <Row label="Expires" value={item.expiresAt} />
        <Row label="Four-eyes" value={`${item.decisions} / ${item.requiredDecisions} decisions`} />
      </dl>
      {isApproval ? (
        <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
          {item.denialReason ? (
            <span className="text-xs text-muted-foreground">{item.denialReason}</span>
          ) : null}
          <button
            type="button"
            disabled={!item.canDecide || busy}
            onClick={() => onDecision("denied")}
            className="ml-auto rounded-sm border border-destructive px-2 py-1 text-xs text-destructive disabled:opacity-50"
          >
            Deny
          </button>
          <button
            type="button"
            disabled={!item.canDecide || busy}
            onClick={() => onDecision("approved")}
            className="rounded-sm bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
          >
            Approve
          </button>
        </footer>
      ) : null}
    </article>
  );
}
