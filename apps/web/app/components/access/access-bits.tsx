/*
 * The precise machine-readable form stays reachable one disclosure away, so an operator
 * debugging a policy is never blocked by copy written for an owner.
 */

import type * as React from "react";
import { ChevronDown, ShieldCheck, ShieldOff, ShieldQuestion, User } from "~/components/icons";
import { Avatar, TeamAvatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import type { Party } from "~/lib/access-directory";
import { describeGrant, type RoleSummary } from "~/lib/access-language";
import type { AuthzGrant } from "~/lib/authz";
import { cn } from "~/lib/utils";

export function PartyAvatar({
  party,
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & { party: Party; className?: string }) {
  if (party.isTeam) {
    return <TeamAvatar identity={party.principalId} className={className} {...props} />;
  }

  /*
   * Anything left that we cannot name is drawn as an outlined glyph rather than a gradient: a
   * gradient mark asserts "this is somebody", and an id we failed to resolve has not earned that.
   */
  if (!party.isPerson && !party.principalId.includes(":")) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground",
          className
        )}
        {...props}
      >
        <User className="size-4" />
      </span>
    );
  }

  return <Avatar identity={party.name || party.initials} className={className} {...props} />;
}

export function PartyLine({ party }: { party: Party }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <PartyAvatar party={party} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{party.name}</p>
        <p className="truncate text-xs text-muted-foreground">{party.detail}</p>
      </div>
    </div>
  );
}

/**
 * And a phrase that appears on both sides is neither — collapsing distinct resource types into
 * one area name is what makes them look identical, so it is shown once, as partial, rather than
 * twice, as a contradiction the reader has no way to resolve.
 */
export function CapabilityList({ grants }: { grants: readonly AuthzGrant[] }) {
  if (grants.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing yet.</p>;
  }

  const allowPhrases = new Set(phrasesFor(grants, "allow"));
  const denyPhrases = new Set(phrasesFor(grants, "deny"));
  const partial = [...allowPhrases].filter((phrase) => denyPhrases.has(phrase)).sort(compare);

  const unrestricted = grants.some(
    (grant) => grant.effect === "allow" && grant.action === "*" && grant.resourceType === "*"
  );
  const allowed = unrestricted
    ? []
    : [...allowPhrases].filter((phrase) => !denyPhrases.has(phrase)).sort(compare);
  const blocked = [...denyPhrases].filter((phrase) => !allowPhrases.has(phrase)).sort(compare);

  return (
    <div className="space-y-3">
      {unrestricted ? (
        <p className="flex items-start gap-2 text-sm text-foreground">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-status-success" />
          <span>
            Everything in the business
            {blocked.length + partial.length > 0 ? ", apart from what is listed below" : ""}.
          </span>
        </p>
      ) : null}

      {allowed.length > 0 ? (
        <ul className="space-y-1.5">
          {allowed.map((phrase) => (
            <li key={phrase} className="flex items-start gap-2 text-sm text-foreground">
              <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-status-success" />
              <span>{phrase}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {partial.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Only some of these</p>
          <p className="text-xs text-muted-foreground">
            Parts are allowed and parts are blocked. Open Exact rules to see which.
          </p>
          <ul className="space-y-1.5">
            {partial.map((phrase) => (
              <li key={phrase} className="flex items-start gap-2 text-sm text-foreground">
                <ShieldQuestion
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-status-warning"
                />
                <span>{phrase}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {blocked.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Explicitly blocked</p>
          <ul className="space-y-1.5">
            {blocked.map((phrase) => (
              <li key={phrase} className="flex items-start gap-2 text-sm text-muted-foreground">
                <ShieldOff aria-hidden className="mt-0.5 size-4 shrink-0 text-status-danger" />
                <span>{phrase}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function compare(a: string, b: string): number {
  return a.localeCompare(b);
}

function phrasesFor(grants: readonly AuthzGrant[], effect: AuthzGrant["effect"]): string[] {
  return grants.filter((grant) => grant.effect === effect).map(describeGrant);
}

/** The exact rules, for whoever needs them. Collapsed, because most readers never will. */
export function TechnicalDetails({
  summary = "Exact rules",
  children,
}: {
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-md border border-border bg-muted/30">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronDown
          aria-hidden
          className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none"
        />
        {summary}
      </summary>
      <div className="border-t border-border px-3 py-2">{children}</div>
    </details>
  );
}

export function RawGrantList({ grants }: { grants: readonly AuthzGrant[] }) {
  if (grants.length === 0) {
    return <p className="font-mono text-xs text-muted-foreground">no grants</p>;
  }
  return (
    <ul className="space-y-1">
      {grants.map((grant) => (
        <li
          key={`${grant.effect}:${grant.label}`}
          className="break-all font-mono text-xs text-muted-foreground"
        >
          {grant.label}
        </li>
      ))}
    </ul>
  );
}

/*
 * Worse, the list reads allows only: `member` is "everything except…", so it listed "people and
 * access" directly under a blurb saying it cannot manage them. The exact grants stay one
 * disclosure away for anyone who wants them.
 */
export function RoleCard({ summary, className }: { summary: RoleSummary; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{summary.title}</span>
        {summary.unrestricted ? <Badge variant="warning">Unrestricted</Badge> : null}
      </div>
      <p className="text-xs text-muted-foreground">{summary.blurb}</p>
    </div>
  );
}

export function ExpiryNote({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return null;
  return <Badge variant="warning">Until {formatDate(expiresAt)}</Badge>;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
