import type { McpCapabilityReview, McpIntegrationDefinition } from "@tulipfarm/schema";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
  discoverMcpCapabilities,
  type McpRequestContext,
  reviewMcpCapabilities,
} from "~/lib/mcp-integrations";
import { checkedValues, McpError } from "./mcp-form";

export function McpCapabilities({
  definition,
  isAdmin,
  onChanged,
  context,
  onReviewed,
}: {
  definition: McpIntegrationDefinition;
  isAdmin: boolean;
  onChanged: () => void;
  context?: McpRequestContext;
  onReviewed?: (hasAccess: boolean) => void;
}) {
  const [discovered, setDiscovered] = useState<McpCapabilityReview>();
  const [selected, setSelected] = useState<McpCapabilityReview>(definition.reviewed);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const capabilities = discovered ?? definition.reviewed;
  const availableKinds = (["tools", "resources", "prompts"] as const).filter(
    (kind) => capabilities[kind].length > 0
  );

  async function discover() {
    setPending(true);
    setError(undefined);
    setNotice("");
    try {
      const next = await discoverMcpCapabilities(definition.server.id, context);
      setDiscovered(next);
      setSelected({
        tools: next.tools.flatMap((item) => {
          const reviewed = definition.reviewed.tools.find(
            (enabled) => enabled.name === item.name && enabled.digest === item.digest
          );
          return reviewed ? [reviewed] : [];
        }),
        resources: next.resources.filter((item) =>
          definition.reviewed.resources.some(
            (enabled) => enabled.uri === item.uri && enabled.digest === item.digest
          )
        ),
        prompts: next.prompts.filter((item) =>
          definition.reviewed.prompts.some(
            (enabled) => enabled.name === item.name && enabled.digest === item.digest
          )
        ),
      });
      setNotice(
        next.tools.length + next.resources.length + next.prompts.length > 0
          ? "Discovery complete. Nothing new is approved yet. Select what agents may use, then save your review."
          : ""
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Discover access, then select what agents may use. Nothing new is approved until an admin
        saves the review.
      </p>
      <McpError error={error} />
      {isAdmin && (
        <Button
          variant={discovered ? "outline" : "default"}
          disabled={pending}
          onClick={() => void discover()}
        >
          {pending ? "Working..." : "Discover available access"}
        </Button>
      )}
      {availableKinds.length === 0 && (
        <p role={discovered ? "status" : undefined} className="text-xs text-muted-foreground">
          {discovered
            ? "No Tools, resources or prompts were found for this account. Check its provider permissions if you expected access."
            : "No access has been approved yet."}
        </p>
      )}
      {availableKinds.map((kind) => (
        <section key={kind} className="space-y-2">
          <h4 className="text-sm font-medium">
            {kind === "tools"
              ? "Tools — actions agents can take"
              : kind === "resources"
                ? "Resources — content agents can read"
                : "Prompts — instructions agents can retrieve"}
          </h4>
          <ul className="divide-y divide-border">
            {capabilities[kind].map((item) => {
              const key = "uri" in item ? item.uri : item.name;
              const checked = selected[kind].some(
                (entry) => ("uri" in entry ? entry.uri : entry.name) === key
              );
              const toolPolicy =
                kind === "tools"
                  ? selected.tools.find((tool) => tool.name === item.name)
                  : undefined;
              return (
                <li key={key} className="space-y-2 py-3">
                  <div className="flex items-start gap-2 text-sm">
                    {isAdmin && discovered ? (
                      <input
                        type="checkbox"
                        aria-label={`Approve ${kind}: ${item.name}`}
                        className="mt-1"
                        disabled={pending}
                        checked={checked}
                        onChange={(event) => {
                          const keys = checkedValues(
                            selected[kind].map((entry) =>
                              "uri" in entry ? entry.uri : entry.name
                            ),
                            key,
                            event.target.checked
                          );
                          if (kind === "tools")
                            setSelected({
                              ...selected,
                              tools: capabilities.tools
                                .filter((entry) => keys.includes(entry.name))
                                .map(
                                  (entry) =>
                                    selected.tools.find(
                                      (previous) => previous.name === entry.name
                                    ) ?? entry
                                ),
                            });
                          if (kind === "resources")
                            setSelected({
                              ...selected,
                              resources: capabilities.resources.filter((entry) =>
                                keys.includes(entry.uri)
                              ),
                            });
                          if (kind === "prompts")
                            setSelected({
                              ...selected,
                              prompts: capabilities.prompts.filter((entry) =>
                                keys.includes(entry.name)
                              ),
                            });
                        }}
                      />
                    ) : null}
                    <span className="min-w-0 break-words">
                      <span className="font-medium">{item.name}</span>
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {discovered
                        ? checked
                          ? "Selected for approval"
                          : "Not selected"
                        : "Approved"}
                    </span>
                  </div>
                  {"inputSchema" in item && (
                    <div className="space-y-2 text-xs text-muted-foreground">
                      {item.description && <p>{item.description}</p>}
                      <p className="font-medium">
                        {(toolPolicy?.mutating ?? item.mutating)
                          ? "May change external data."
                          : "Read-only."}{" "}
                        {(toolPolicy?.requiresApproval ?? item.requiresApproval)
                          ? "Requires action approval."
                          : "No additional action approval."}
                      </p>
                      <details>
                        <summary className="cursor-pointer">
                          Technical details · Tool inputs
                        </summary>
                        <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2">
                          {JSON.stringify(item.inputSchema, null, 2)}
                        </pre>
                      </details>
                    </div>
                  )}
                  {"uri" in item && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">
                        Technical details · Resource address
                      </summary>
                      <p className="break-all">{item.uri}</p>
                    </details>
                  )}
                  {"inputSchema" in item && isAdmin && discovered && checked && (
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Changes external data: ${item.name}`}
                          disabled={pending}
                          checked={
                            selected.tools.find((tool) => tool.name === item.name)?.mutating ?? true
                          }
                          onChange={(event) =>
                            setSelected({
                              ...selected,
                              tools: selected.tools.map((tool) =>
                                tool.name === item.name
                                  ? { ...tool, mutating: event.target.checked }
                                  : tool
                              ),
                            })
                          }
                        />
                        May change external data
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Require approval: ${item.name}`}
                          disabled={pending}
                          checked={
                            selected.tools.find((tool) => tool.name === item.name)
                              ?.requiresApproval ?? true
                          }
                          onChange={(event) =>
                            setSelected({
                              ...selected,
                              tools: selected.tools.map((tool) =>
                                tool.name === item.name
                                  ? { ...tool, requiresApproval: event.target.checked }
                                  : tool
                              ),
                            })
                          }
                        />
                        Require action approval
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {isAdmin && discovered && (
        <Button
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError(undefined);
            try {
              await reviewMcpCapabilities(definition.server.id, selected, context);
              setDiscovered(undefined);
              setNotice("Access review saved. Only your approved selection is available.");
              onChanged();
              onReviewed?.(Object.values(selected).some((items) => items.length > 0));
            } catch (cause) {
              setError(cause);
            } finally {
              setPending(false);
            }
          }}
        >
          Save approved access
        </Button>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
