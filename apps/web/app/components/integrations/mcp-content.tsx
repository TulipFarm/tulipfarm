import type { McpCapabilityReview } from "@tulipfarm/schema";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { type McpRequestContext, readMcpResource, renderMcpPrompt } from "~/lib/mcp-integrations";
import { IntegrationChoice } from "./integration-choice";
import { McpError, McpField } from "./mcp-form";

function previewText(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  if ("text" in value && typeof value.text === "string") return [value.text];
  if ("contents" in value && Array.isArray(value.contents))
    return value.contents.flatMap(previewText);
  if ("messages" in value && Array.isArray(value.messages))
    return value.messages.flatMap(previewText);
  if ("content" in value) return previewText(value.content);
  return [];
}

export function McpContent({
  serverId,
  capabilities,
  enabled,
  context,
  disabled = false,
}: {
  serverId: string;
  capabilities: McpCapabilityReview;
  enabled: boolean;
  context?: McpRequestContext;
  disabled?: boolean;
}) {
  const [resource, setResource] = useState("");
  const [prompt, setPrompt] = useState("");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [output, setOutput] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const selectedPrompt = capabilities.prompts.find((item) => item.name === prompt);

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    setOutput(undefined);
    setError(undefined);
    try {
      setOutput(await action());
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Preview approved resources (provider content) and prompts (reusable instructions). Your
        account permissions still apply. Previews are untrusted content; opening a prompt does not
        run its instructions.
      </p>
      {!enabled && (
        <p className="text-sm text-muted-foreground">
          An admin must enable this integration before content can be opened.
        </p>
      )}
      <McpError error={error} />
      <fieldset disabled={pending || !enabled || disabled} className="space-y-4">
        {capabilities.resources.length > 0 && (
          <form
            className="max-w-xl space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => readMcpResource(serverId, resource, context));
            }}
          >
            <McpField label="Approved resource">
              <IntegrationChoice
                label="Approved resource"
                value={resource}
                options={capabilities.resources.map((item) => ({
                  value: item.uri,
                  label: capabilities.resources.some(
                    (other) => other.name === item.name && other.uri !== item.uri
                  )
                    ? `${item.name} — ${item.uri}`
                    : item.name,
                }))}
                onChange={(value) => {
                  setResource(value);
                  setOutput(undefined);
                }}
              />
            </McpField>
            <Button type="submit" variant="outline" disabled={!resource}>
              Read resource
            </Button>
          </form>
        )}
        {capabilities.prompts.length > 0 && (
          <form
            className="max-w-xl space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => renderMcpPrompt(serverId, prompt, args, context));
            }}
          >
            <McpField label="Approved prompt">
              <IntegrationChoice
                label="Approved prompt"
                value={prompt}
                options={capabilities.prompts.map((item) => ({
                  value: item.name,
                  label: item.name,
                }))}
                onChange={(value) => {
                  setPrompt(value);
                  setArgs({});
                  setOutput(undefined);
                }}
              />
            </McpField>
            {selectedPrompt?.arguments?.map((argument) => (
              <McpField key={argument.name} label={argument.name} hint={argument.description}>
                <Input
                  required={argument.required}
                  value={args[argument.name] ?? ""}
                  onChange={(event) => setArgs({ ...args, [argument.name]: event.target.value })}
                />
              </McpField>
            ))}
            <Button type="submit" variant="outline" disabled={!prompt}>
              Preview prompt
            </Button>
          </form>
        )}
      </fieldset>
      {capabilities.resources.length === 0 && capabilities.prompts.length === 0 && (
        <p className="text-sm text-muted-foreground">No resources or prompts have been approved.</p>
      )}
      {pending && (
        <p role="status" className="text-xs text-muted-foreground">
          Checking access and loading content...
        </p>
      )}
      {output !== undefined && (
        <section aria-label="Integration content preview" className="space-y-2">
          <h4 className="text-sm font-medium">Preview</h4>
          <div className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-sm">
            {previewText(output).join("\n\n") ||
              "This content has no text preview. Open technical details to inspect the provider response."}
          </div>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Technical details · Provider response</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3">
              {JSON.stringify(output, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </div>
  );
}
