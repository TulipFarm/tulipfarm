import { ArrowUpRight } from "~/components/icons";
import type { McpCatalogEntry } from "~/lib/mcp-integrations";
import { IntegrationIcon } from "./integration-icon";
import { providerGuide } from "./provider-guide";

export function IntegrationSetupGuide({
  entry,
  showInstructions = true,
}: {
  entry: McpCatalogEntry;
  showInstructions?: boolean;
}) {
  const guide = providerGuide(entry.id);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <IntegrationIcon label={entry.name} iconSlug={entry.id} size="lg" />
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{entry.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {guide?.description ?? `Tools from ${entry.publisher}.`}
          </p>
        </div>
      </div>
      <details className="space-y-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Setup help · {entry.name}
        </summary>
        {guide && (
          <section aria-label={`${entry.name} capabilities`} className="space-y-2">
            <h4 className="text-sm font-medium">What you can use it for</h4>
            <ul className="flex flex-wrap gap-2">
              {guide.capabilities.map((capability) => (
                <li key={capability} className="rounded-md border border-border px-2 py-1 text-xs">
                  {capability}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Available Tools depend on your account. Initial setup requires approval for every Tool
              call. Existing access settings stay unchanged.
            </p>
          </section>
        )}
        {showInstructions && (
          <section
            aria-label={`${entry.name} setup instructions`}
            className="space-y-3 border-t border-border pt-4"
          >
            <h4 className="text-sm font-medium">Before you connect</h4>
            <ol className="list-decimal space-y-2 pl-4 text-sm text-muted-foreground">
              {(
                guide?.instructions ?? [
                  "Check the provider’s setup guide for the account details you need.",
                  "Connect below. You can narrow access later in Advanced settings.",
                ]
              ).map((step) => (
                <li key={step} className="pl-1">
                  {step}
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
              {guide?.credentialLink && (
                <a
                  href={guide.credentialLink.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-brand hover:underline"
                >
                  {guide.credentialLink.label}
                  <ArrowUpRight className="size-3" />
                </a>
              )}
              <a
                href={entry.publisherEvidence}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-brand hover:underline"
              >
                Provider setup guide
                <ArrowUpRight className="size-3" />
              </a>
            </div>
            <details className="text-xs text-muted-foreground">
              <summary className="w-fit cursor-pointer">Technical requirements</summary>
              <div className="mt-2 space-y-2">
                <p className="break-all">{entry.url}</p>
                <ul className="list-disc space-y-1 pl-4">
                  {[...entry.setup, ...entry.limitations].map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <p>
                  {entry.knowledgeSync === "excluded"
                    ? "Knowledge sync is not available for this integration."
                    : "Connecting alone does not copy content into Knowledge."}
                </p>
              </div>
            </details>
          </section>
        )}
      </details>
    </div>
  );
}
