import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { Panel } from "~/components/ui/panel";
import { ApiError } from "~/lib/api";
import {
  type AdhocConnectionRule,
  createAdhocConnection,
  getAdhocConnection,
  safeChatReturn,
} from "~/lib/connections";
import { usePublishPageTitle } from "~/lib/page-chrome-context";
import { useIsAdmin } from "~/lib/use-session-user";

export const meta: MetaFunction = () => [{ title: "Add Connection · tulipfarm" }];

export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const url = new URL(request.url);
  const rawOrigin = url.searchParams.get("origin");
  if (!rawOrigin) throw new ApiError(400, "This link does not name a destination.");

  let origin: string;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    origin = parsed.origin;
  } catch {
    throw new ApiError(400, "This link names an invalid destination.");
  }

  return {
    origin,
    host: new URL(origin).host,
    returnTo: safeChatReturn(url.searchParams.get("return_to"), url),
    existing: await getAdhocConnection(origin),
  };
}

type Method = "bearer" | "api-key-header" | "api-key-query" | "custom";

function ruleFor(
  method: Method,
  custom: { location: "header" | "query"; name: string; valuePrefix: string }
): AdhocConnectionRule {
  switch (method) {
    case "bearer":
      return { location: "header", name: "authorization", valuePrefix: "Bearer " };
    case "api-key-header":
      return { location: "header", name: "x-api-key", valuePrefix: "" };
    case "api-key-query":
      return { location: "query", name: "api_key", valuePrefix: "" };
    case "custom":
      return custom;
  }
}

function methodDescription(method: Method): string {
  switch (method) {
    case "bearer":
      return "Sends Authorization: Bearer followed by the value.";
    case "api-key-header":
      return "Sends the value in the X-API-Key header.";
    case "api-key-query":
      return "Adds the value as the api_key query parameter.";
    case "custom":
      return "Use the exact header or query parameter named by the provider.";
  }
}

export default function NewAdhocConnection() {
  const { origin, host, returnTo, existing } = useLoaderData<typeof clientLoader>();
  usePublishPageTitle("Add Connection");
  const isAdmin = useIsAdmin();
  const [label, setLabel] = useState(host);
  const [secretValue, setSecretValue] = useState("");
  const [scope, setScope] = useState<"personal" | "organization">("personal");
  const [method, setMethod] = useState<Method>("bearer");
  const [customLocation, setCustomLocation] = useState<"header" | "query">("header");
  const [customName, setCustomName] = useState("");
  const [customPrefix, setCustomPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ label: string; scope: string }>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const rule = ruleFor(method, {
      location: customLocation,
      name: customName.trim(),
      valuePrefix: customPrefix,
    });
    if (!rule.name) {
      setError("Enter the header or query parameter name.");
      document.getElementById("connection-rule-name")?.focus();
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      await createAdhocConnection({
        origin,
        rule,
        secretValue,
        label: label.trim(),
        scope,
      });
      setCreated({ label: label.trim(), scope });
      setSecretValue("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this Connection.");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <h1 className="text-lg font-semibold">Connection saved</h1>
        <FormStatus tone="success">
          {created.label} can now authenticate requests to {origin}. The credential value is not
          shown or kept in this page.
        </FormStatus>
        {returnTo ? (
          <Button asChild>
            <Link to={returnTo}>Return to Chat</Link>
          </Button>
        ) : (
          <Button asChild>
            <Link to="/">Go to Chat</Link>
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Add a Connection</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Save a credential for <strong className="font-medium text-foreground">{host}</strong>.
          Agents never see its value. The runtime can use it only for this exact origin.
        </p>
        <code className="mt-2 block break-all text-xs text-muted-foreground">{origin}</code>
      </div>

      {existing.state === "match" ? (
        <FormStatus tone="success">
          A usable Connection named {existing.label} already exists for this destination.
        </FormStatus>
      ) : existing.state === "ambiguous" ? (
        <FormStatus tone="error">
          {existing.count} usable Connections already match this destination. Remove the duplicate
          before retrying the request.
        </FormStatus>
      ) : null}

      <form onSubmit={submit} autoComplete="off">
        <Panel
          title="Credential"
          description="Enter the value here, not in Chat. It is sent straight to the Secret store."
        >
          <div className="space-y-5 px-4 pb-4">
            <Field label="Connection name" required htmlFor="connection-label">
              <Input
                id="connection-label"
                name="label"
                value={label}
                required
                maxLength={128}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">How the provider expects it</legend>
              {(
                [
                  ["bearer", "Bearer token"],
                  ["api-key-header", "API key header"],
                  ["api-key-query", "API key query parameter"],
                  ["custom", "Custom"],
                ] as const
              ).map(([value, text]) => (
                <label key={value} className="flex min-h-7 items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="method"
                    value={value}
                    checked={method === value}
                    onChange={() => setMethod(value)}
                    className="mt-0.5 size-4 accent-foreground"
                  />
                  <span>
                    <span className="font-medium">{text}</span>
                    {method === value ? (
                      <span className="block text-xs text-muted-foreground">
                        {methodDescription(value)}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </fieldset>

            {method === "custom" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Location</legend>
                  {(["header", "query"] as const).map((value) => (
                    <label key={value} className="flex min-h-7 items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="location"
                        value={value}
                        checked={customLocation === value}
                        onChange={() => setCustomLocation(value)}
                        className="size-4 accent-foreground"
                      />
                      <span className="capitalize">{value}</span>
                    </label>
                  ))}
                </fieldset>
                <Field
                  label={customLocation === "header" ? "Header name" : "Query parameter"}
                  required
                  htmlFor="connection-rule-name"
                >
                  <Input
                    id="connection-rule-name"
                    name="ruleName"
                    value={customName}
                    required
                    spellCheck={false}
                    onChange={(event) => setCustomName(event.target.value)}
                  />
                </Field>
                <Field
                  label="Value prefix"
                  help="Optional text placed before the saved value, such as Bearer and a space."
                  htmlFor="connection-rule-prefix"
                  className="sm:col-span-2"
                >
                  <Input
                    id="connection-rule-prefix"
                    name="valuePrefix"
                    aria-describedby="connection-rule-prefix-help"
                    value={customPrefix}
                    maxLength={64}
                    spellCheck={false}
                    onChange={(event) => setCustomPrefix(event.target.value)}
                  />
                </Field>
              </div>
            ) : null}

            <Field
              label="Credential value"
              required
              help="This value is write-only. It will not appear in Chat, logs, or this page after saving."
              htmlFor="connection-secret"
            >
              <Input
                id="connection-secret"
                name="credential"
                type="password"
                autoComplete="off"
                aria-describedby="connection-secret-help"
                value={secretValue}
                required
                maxLength={8192}
                onChange={(event) => setSecretValue(event.target.value)}
              />
            </Field>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Used by</legend>
              <label className="flex min-h-7 items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="scope"
                  value="personal"
                  checked={scope === "personal"}
                  onChange={() => setScope("personal")}
                  className="mt-0.5 size-4 accent-foreground"
                />
                <span>
                  <span className="font-medium">Just me</span>
                  <span className="block text-xs text-muted-foreground">
                    The narrow default. Only your authorized Runs can use it.
                  </span>
                </span>
              </label>
              <label className="flex min-h-7 items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="scope"
                  value="organization"
                  checked={scope === "organization"}
                  disabled={!isAdmin}
                  onChange={() => setScope("organization")}
                  className="mt-0.5 size-4 accent-foreground"
                />
                <span>
                  <span className="font-medium">The whole business</span>
                  <span className="block text-xs text-muted-foreground">
                    {isAdmin
                      ? "Shared with authorized people and Agents."
                      : "Only an admin can create a shared Connection."}
                  </span>
                </span>
              </label>
            </fieldset>

            {error ? <FormStatus tone="error">{error}</FormStatus> : null}

            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save Connection"}
            </Button>
          </div>
        </Panel>
      </form>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="Connection" status={status} message={message} />;
}
