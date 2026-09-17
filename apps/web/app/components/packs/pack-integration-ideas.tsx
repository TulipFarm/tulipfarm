import { PACK_CATALOG_URL } from "@tulipfarm/constants/site";
import { IntegrationIcon } from "~/components/integrations/integration-icon";

const PROVIDERS = {
  google: { label: "Google Workspace", iconSlug: "googleworkspace" },
  drive: { label: "Google Drive", iconSlug: "googledrive" },
  gmail: { label: "Gmail", iconSlug: "gmail" },
  slack: { label: "Slack", iconSlug: "slack" },
  github: {
    label: "GitHub",
    iconSlug: "github",
    iconColor: "181717",
    // Simple Icons 16.28.0, CC0-1.0; vendored so the Pack gallery needs no logo CDN or catalog request.
    iconPath:
      "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
} as const;

/** Curated optional ideas for the starter catalog, not Pack requirements or connection state. */
const STARTER_IDEAS: Record<string, readonly (keyof typeof PROVIDERS)[]> = {
  "lead-qualification": ["google", "slack"],
  "deal-follow-up": ["gmail", "slack"],
  "account-briefs": ["google"],
  "employee-onboarding": ["google", "slack"],
  "access-reviews": ["google", "github"],
  "incident-triage": ["slack", "github"],
  "content-calendar": ["google", "slack"],
  "campaign-reporting": ["google"],
  "document-intake": ["drive"],
  "contract-renewals": ["drive", "gmail"],
  "invoice-review": ["drive"],
  "support-triage": ["gmail", "slack"],
  "knowledge-gaps": ["drive", "slack"],
  "issue-triage": ["github", "slack"],
  "release-readiness": ["github", "slack"],
};

export function PackIntegrationIdeas({
  name,
  sourceUrl,
  compact = false,
}: {
  name: string;
  sourceUrl?: string;
  compact?: boolean;
}) {
  const ideas = Object.hasOwn(STARTER_IDEAS, name) ? STARTER_IDEAS[name] : undefined;
  const isStarterSource = [name, `${name}.yaml`].some(
    (path) => sourceUrl === new URL(path, PACK_CATALOG_URL).href
  );
  if (!ideas || !isStarterSource) return null;
  return (
    <div className="space-y-2">
      <p className={compact ? "text-xs text-muted-foreground" : "text-sm font-medium"}>
        Integration ideas
      </p>
      <ul aria-label="Optional integration ideas" className="flex flex-wrap items-center gap-2">
        {ideas.map((id) => {
          const provider = PROVIDERS[id];
          return (
            <li key={id} title={provider.label} className="flex items-center gap-2">
              <IntegrationIcon {...provider} />
              <span className={compact ? "sr-only" : "mr-3 text-sm"}>{provider.label}</span>
            </li>
          );
        })}
      </ul>
      {!compact ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Optional starting points, not required or connected services. Ask the agent to adapt the
          Pack to your tools. Connections, permissions, and external actions need separate review.
        </p>
      ) : null}
    </div>
  );
}
