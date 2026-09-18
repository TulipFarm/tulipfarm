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
}: {
  definition: McpIntegrationDefinition;
  isAdmin: boolean;
  onChanged: () => void;
  context?: McpRequestContext;
}) {
  const [discovered, setDiscovered] = useState<McpCapabilityReview>();
  const [selected, setSelected] = useState<McpCapabilityReview>(definition.reviewed);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const capabilities = discovered ?? definition.reviewed;

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
        "Discovery complete. New and changed capabilities remain unapproved until you save."
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
        Server descriptions and read-only hints do not grant authority. New capabilities stay
        disabled until an admin reviews them.
      </p>
      <McpError error={error} />
      {isAdmin && (
        <Button variant="outline" disabled={pending} onClick={() => void discover()}>
          {pending ? "Working..." : "Discover capabilities"}
        </Button>
      )}
      {(["tools", "resources", "prompts"] as const).map((kind) => (
        <section key={kind} className="space-y-2">
          <h4 className="text-sm font-medium capitalize">{kind}</h4>
          {capabilities[kind].length === 0 && (
            <p className="text-xs text-muted-foreground">
              {discovered ? "None reported by this server." : "None approved."}
            </p>
          )}
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
                      {"uri" in item && (
                        <span className="block text-xs text-muted-foreground">{item.uri}</span>
                      )}
                    </span>
                  </div>
                  {"inputSchema" in item && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">Tool inputs and policy</summary>
                      <p>{item.description}</p>
                      <p>
                        {(toolPolicy?.mutating ?? item.mutating)
                          ? "May change external data."
                          : "Reviewed as read-only."}{" "}
                        {(toolPolicy?.requiresApproval ?? item.requiresApproval)
                          ? "Approval required."
                          : "No additional approval."}
                      </p>
                      <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2">
                        {JSON.stringify(item.inputSchema, null, 2)}
                      </pre>
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
              setNotice("Capability review saved.");
              onChanged();
            } catch (cause) {
              setError(cause);
            } finally {
              setPending(false);
            }
          }}
        >
          Save approved capabilities
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
