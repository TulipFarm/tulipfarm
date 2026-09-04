import type { MetaFunction } from "@remix-run/react";
import { ArrowUpRight } from "~/components/icons";
import { SectionShell } from "~/components/section-shell";
import { Button } from "~/components/ui/button";
import { GITHUB_REPO_URL } from "~/lib/report-bug";

export const meta: MetaFunction = () => [{ title: "Integrations · tulipfarm" }];

const requestUrl = new URL(`${GITHUB_REPO_URL}/issues/new`);
requestUrl.searchParams.set("template", "feature_request.md");
requestUrl.searchParams.set("title", "feat(integrations): ");
requestUrl.searchParams.set("labels", "enhancement");
export const REQUEST_INTEGRATION_URL = requestUrl.toString();

export default function IntegrationsLayout() {
  return (
    <SectionShell
      actions={
        <Button asChild size="sm">
          <a href={REQUEST_INTEGRATION_URL} target="_blank" rel="noreferrer">
            Request integration
            <ArrowUpRight aria-hidden />
          </a>
        </Button>
      }
    />
  );
}
