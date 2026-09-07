import { useEffect, useMemo, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Check } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Sheet } from "~/components/ui/sheet";
import { Textarea } from "~/components/ui/textarea";
import {
  getIntegration,
  type InspectedIntegration,
  type InspectResult,
  type IntegrationDetail,
  inspectIntegrationSource,
  installIntegration,
  updateIntegration,
} from "~/lib/integrations";
import { cn } from "~/lib/utils";

export type IntegrationReviewRequest =
  | { kind: "install"; source?: string; name?: string }
  | { kind: "update"; name: string; source: string; current?: IntegrationDetail };

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

function operationKey(operation: { name?: string; effect?: string }): string {
  return `${operation.name ?? "Unnamed operation"} · ${operation.effect ?? "effect not declared"}`;
}

function candidateKey(candidate: InspectedIntegration): string {
  return `${candidate.name}:v${candidate.majorVersion ?? "legacy"}`;
}

function AuthorityChanges({
  current,
  candidate,
}: {
  current: IntegrationDetail;
  candidate: InspectedIntegration;
}) {
  const before = new Set(
    current.grants.map((grant) => `${grant.label} · ${grant.access ?? "effect not declared"}`)
  );
  const after = new Set((candidate.review?.operations ?? []).map(operationKey));
  const added = [...after].filter((item) => !before.has(item));
  const removed = [...before].filter((item) => !after.has(item));

  return (
    <section className="space-y-2 border-border border-t pt-4">
      <h3 className="text-sm font-medium">Changed permissions</h3>
      {added.length === 0 && removed.length === 0 ? (
        <p className="text-xs text-muted-foreground">No declared operation or effect changes.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <ChangeList title="Added" items={added} tone="added" />
          <ChangeList title="Removed" items={removed} tone="removed" />
        </div>
      )}
    </section>
  );
}

function ChangeList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "added" | "removed";
}) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">None</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {items.map((item) => (
            <li
              key={item}
              className={cn(
                "text-xs",
                tone === "added" ? "text-status-success" : "text-destructive"
              )}
            >
              {tone === "added" ? "+" : "−"} {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CandidateReview({
  candidate,
  selected,
  selectable,
  onSelect,
  current,
}: {
  candidate: InspectedIntegration;
  selected: boolean;
  selectable: boolean;
  onSelect: () => void;
  current?: IntegrationDetail;
}) {
  const review = candidate.review;
  const fixtures = candidate.fixtures ?? review?.fixtures ?? [];

  return (
    <article
      className={cn(
        "space-y-4 rounded-lg border p-4",
        selected ? "border-foreground" : "border-border"
      )}
    >
      <div className="flex items-start gap-3">
        {selectable ? (
          <input
            type="radio"
            name="integration-package"
            value={candidate.name}
            checked={selected}
            onChange={onSelect}
            aria-label={`Review ${candidate.name}`}
            className="mt-1 size-4 accent-foreground"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium text-foreground">{candidate.name}</h3>
            <span className="text-xs text-muted-foreground">
              {candidate.definition === "oim" ? "Open Integration Manifest" : "Legacy manifest"}
            </span>
          </div>
          {candidate.description ? (
            <p className="mt-1 text-xs text-muted-foreground">{candidate.description}</p>
          ) : null}
        </div>
      </div>

      {candidate.issues.length > 0 ? (
        <FormStatus tone="error">{candidate.issues.join(" ")}</FormStatus>
      ) : null}

      <dl className="grid gap-3 text-xs sm:grid-cols-2">
        <ReviewFact
          label="Version"
          value={
            current
              ? `${current.version ?? "unknown"} → ${candidate.version ?? review?.version ?? "unknown"}`
              : (candidate.version ?? review?.version ?? "Not declared")
          }
        />
        {candidate.majorVersion === undefined ? null : (
          <ReviewFact label="Major version" value={String(candidate.majorVersion)} />
        )}
        {candidate.installedSlug ? (
          <ReviewFact label="Installed as" value={candidate.installedSlug} />
        ) : null}
        <ReviewFact
          label="Verified trust"
          value={
            candidate.definition !== "oim"
              ? "Legacy package"
              : candidate.support === "official"
                ? "Official signature verified"
                : candidate.support === "community"
                  ? "Community digest review"
                  : "Not verified"
          }
        />
        {candidate.verifiedSignerKeyId ? (
          <ReviewFact label="Verified signer" value={candidate.verifiedSignerKeyId} />
        ) : null}
        {candidate.revocationSequence === undefined ? null : (
          <ReviewFact
            label="Revocation list"
            value={`Checked at sequence ${candidate.revocationSequence}`}
          />
        )}
        {candidate.definition === "oim" ? (
          <ReviewFact
            label="Hook code"
            value={
              candidate.hooksAllowed
                ? "Allowed by verified release trust"
                : "Not allowed by release trust"
            }
          />
        ) : null}
        <ReviewFact
          label="License"
          value={candidate.license ?? review?.license ?? "Not declared"}
        />
        <ReviewFact
          label="Maintainer"
          value={candidate.maintainer ?? review?.maintainers?.join(", ") ?? "Not declared"}
        />
      </dl>

      {candidate.definition === "oim" ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Package digest</p>
          <code className="block break-all rounded-md bg-muted px-2.5 py-2 text-xs text-foreground">
            {candidate.packageDigest ?? review?.packageDigest ?? "Missing"}
          </code>
          <p className="text-xs text-muted-foreground">
            Approval is locked to these exact package bytes.
          </p>
        </div>
      ) : null}

      {current ? <AuthorityChanges current={current} candidate={candidate} /> : null}

      {review ? (
        <>
          <ReviewList
            title="Destinations"
            items={
              review.allowedOriginHosts?.length ? review.allowedOriginHosts : review.destinations
            }
            empty="No destination hosts declared."
          />
          <ReviewList
            title="Credential access"
            items={(review.credentialSlots ?? []).map(
              (slot) =>
                `${slot.label ?? slot.id}${slot.kind ? ` · ${slot.kind}` : ""}${
                  slot.required === false ? " · optional" : ""
                }`
            )}
            empty="No credential slots declared."
          />
          <ReviewList
            title="Operations"
            items={review.operations.map(operationKey)}
            empty="No operations declared."
          />
          {review.ingress ? (
            <ReviewList
              title="Incoming events"
              items={[
                ...(review.ingress.eventTypes ?? []),
                ...(review.ingress.path ? [`Path · ${review.ingress.path}`] : []),
              ]}
              empty="No incoming event types declared."
            />
          ) : null}
        </>
      ) : null}

      <section className="space-y-2 border-border border-t pt-4">
        <h3 className="text-sm font-medium">Offline checks</h3>
        {fixtures.length === 0 ? (
          <p className="text-xs text-muted-foreground">No fixtures were included.</p>
        ) : (
          <ul className="space-y-1.5">
            {fixtures.map((fixture) => (
              <li key={`${fixture.fixture}:${fixture.name}`} className="flex items-start gap-2">
                <span
                  className={fixture.passed ? "text-status-success" : "text-destructive"}
                  aria-hidden="true"
                >
                  {fixture.passed ? "✓" : "×"}
                </span>
                <span className="min-w-0 text-xs">
                  <span className="font-medium">{fixture.name}</span>
                  <span className="text-muted-foreground"> · {fixture.fixture}</span>
                  {fixture.error ? (
                    <span className="block text-destructive">{fixture.error}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function ReviewFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-foreground">{value}</dd>
    </div>
  );
}

function ReviewList({
  title,
  items,
  empty,
}: {
  title: string;
  items: readonly string[];
  empty: string;
}) {
  return (
    <section className="space-y-2 border-border border-t pt-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item} className="flex gap-2 text-xs text-foreground">
              <span aria-hidden className="text-muted-foreground">
                –
              </span>
              <span className="break-words">{item}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function IntegrationInstallPanel({
  request,
  onClose,
  onComplete,
}: {
  request?: IntegrationReviewRequest;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [source, setSource] = useState("");
  const [signedReleaseText, setSignedReleaseText] = useState("");
  const [reviewedSignedRelease, setReviewedSignedRelease] = useState<unknown>();
  const [result, setResult] = useState<InspectResult>();
  const [selectedKey, setSelectedKey] = useState("");
  const [current, setCurrent] = useState<IntegrationDetail>();
  const [autoPatchOptIn, setAutoPatchOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSource(request?.source ?? "");
    setSignedReleaseText("");
    setReviewedSignedRelease(undefined);
    setResult(undefined);
    setSelectedKey("");
    setCurrent(request?.kind === "update" ? request.current : undefined);
    setAutoPatchOptIn(false);
    setError(undefined);
  }, [request]);

  const candidates = useMemo(
    () =>
      request?.kind === "update"
        ? (result?.integrations.filter((item) =>
            item.definition === "oim"
              ? item.installedSlug === request.name
              : item.name === request.name
          ) ?? [])
        : (result?.integrations ?? []),
    [request, result]
  );
  const selected = useMemo(
    () => candidates.find((item) => candidateKey(item) === selectedKey),
    [candidates, selectedKey]
  );

  async function inspect(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      let signedRelease: unknown;
      if (signedReleaseText.trim()) {
        try {
          signedRelease = JSON.parse(signedReleaseText);
        } catch {
          throw new Error("The signed release envelope must be valid JSON.");
        }
        if (
          signedRelease === null ||
          typeof signedRelease !== "object" ||
          Array.isArray(signedRelease)
        ) {
          throw new Error("The signed release envelope must be a JSON object.");
        }
      }
      const [next, detail] = await Promise.all([
        signedRelease === undefined
          ? inspectIntegrationSource(source.trim())
          : inspectIntegrationSource(source.trim(), signedRelease),
        request?.kind === "update" && !current ? getIntegration(request.name) : current,
      ]);
      const preferred =
        request?.kind === "update"
          ? next.integrations.find((item) =>
              item.definition === "oim"
                ? item.installedSlug === request.name
                : item.name === request.name
            )
          : (next.integrations.find(
              (item) => item.name === request?.name || item.installedSlug === request?.name
            ) ?? next.integrations[0]);
      setResult(next);
      setSelectedKey(preferred ? candidateKey(preferred) : "");
      setAutoPatchOptIn(
        request?.kind === "install" &&
          preferred?.definition === "oim" &&
          preferred.autoPatchEligible === true &&
          !preferred.installed
      );
      setCurrent(detail);
      setReviewedSignedRelease(signedRelease);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!selected || !request) return;
    const digest = selected.packageDigest ?? selected.review?.packageDigest;
    if (
      selected.definition === "oim" &&
      selected.support === "official" &&
      !reviewedSignedRelease
    ) {
      setError("Inspect this Official package with its signed release envelope before installing.");
      return;
    }
    if (selected.definition === "oim" && selected.support !== "official" && !digest) {
      setError("This package has no digest to approve.");
      return;
    }
    const approval =
      selected.definition !== "oim" || !result
        ? undefined
        : selected.support === "official"
          ? {
              ref: result.ref,
              signedRelease: reviewedSignedRelease,
              ...(request.kind === "install" &&
              !selected.installed &&
              selected.autoPatchEligible === true
                ? { autoPatchOptIn }
                : {}),
            }
          : { ref: result.ref, digest };
    setBusy(true);
    setError(undefined);
    try {
      if (request.kind === "update") {
        await updateIntegration(request.name, source.trim(), approval);
      } else {
        await installIntegration(source.trim(), selected.name, approval);
      }
      onComplete();
      onClose();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={request !== undefined}
      onClose={onClose}
      title={
        request?.kind === "update" || selected?.installed
          ? "Review integration update"
          : "Install from Git or HTTPS"
      }
      className="max-w-2xl"
    >
      {!request ? null : (
        <div className="space-y-5">
          <form className="space-y-3" onSubmit={inspect}>
            <Field
              label="Git or HTTPS source"
              required
              help="Use an HTTPS Git repository or direct oim.yml URL. Git sources can add #branch or #tag."
              htmlFor="integration-source"
            >
              <Input
                id="integration-source"
                type="text"
                inputMode="url"
                autoComplete="url"
                aria-describedby="integration-source-help"
                value={source}
                required
                placeholder="https://github.com/example/integration.git#v1"
                onChange={(event) => {
                  setSource(event.target.value);
                  setResult(undefined);
                  setAutoPatchOptIn(false);
                  setError(undefined);
                }}
              />
            </Field>
            <Field
              label="Signed release envelope"
              help="Optional. Paste the publisher-provided JSON envelope to verify an Official release."
              htmlFor="integration-signed-release"
            >
              <Textarea
                id="integration-signed-release"
                value={signedReleaseText}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="integration-signed-release-help"
                placeholder='{"envelopeVersion":1,...}'
                onChange={(event) => {
                  setSignedReleaseText(event.target.value);
                  setResult(undefined);
                  setReviewedSignedRelease(undefined);
                  setAutoPatchOptIn(false);
                  setError(undefined);
                }}
              />
            </Field>
            <Button type="submit" variant={result ? "outline" : "default"} disabled={busy}>
              {busy ? "Inspecting…" : result ? "Inspect again" : "Inspect source"}
            </Button>
          </form>

          {error ? <FormStatus tone="error">{error}</FormStatus> : null}

          {result ? (
            <div className="space-y-4">
              <div className="rounded-md bg-muted px-3 py-2 text-xs">
                <p>
                  <span className="text-muted-foreground">Source </span>
                  <code className="break-all">{result.source}</code>
                </p>
                {result.sourceType ? (
                  <p className="mt-1">
                    <span className="text-muted-foreground">Source type </span>
                    <span>{result.sourceType}</span>
                  </p>
                ) : null}
                <p className="mt-1">
                  <span className="text-muted-foreground">Resolved ref </span>
                  <code className="break-all">{result.ref}</code>
                </p>
              </div>

              {candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {request.kind === "update"
                    ? `This source does not contain ${request.name}.`
                    : "This source contains no integration package."}
                </p>
              ) : (
                candidates.map((candidate) => (
                  <CandidateReview
                    key={candidateKey(candidate)}
                    candidate={candidate}
                    selected={candidateKey(candidate) === selectedKey}
                    selectable={candidates.length > 1}
                    onSelect={() => {
                      setSelectedKey(candidateKey(candidate));
                      setAutoPatchOptIn(
                        request.kind === "install" &&
                          candidate.definition === "oim" &&
                          candidate.autoPatchEligible === true &&
                          !candidate.installed
                      );
                    }}
                    current={request.kind === "update" ? current : undefined}
                  />
                ))
              )}

              {selected ? (
                <div className="sticky bottom-0 flex flex-col gap-2 border-border border-t bg-card pt-4">
                  {selected.definition === "oim" ? (
                    selected.autoPatchEligible ? (
                      request.kind === "install" && !selected.installed ? (
                        <label className="flex min-h-7 items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={autoPatchOptIn}
                            onChange={(event) => setAutoPatchOptIn(event.target.checked)}
                            className="mt-0.5 size-4 accent-foreground"
                          />
                          <span>
                            <span className="font-medium">
                              Install verified patch updates automatically
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              Enabled by default. Only releases verified by an active trusted key
                              can be applied.
                            </span>
                          </span>
                        </label>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          The existing automatic patch setting will be preserved.
                        </p>
                      )
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Automatic patch updates are unavailable for this package.
                      </p>
                    )
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {selected.definition === "oim"
                      ? selected.support === "official"
                        ? "The publisher signature covers the package digest shown above. The server verifies the exact release."
                        : "Approval names the digest shown above. If the source changes before the write, the server refuses it."
                      : "This legacy package has no content digest. Review its source before continuing."}
                  </p>
                  <Button
                    type="button"
                    disabled={busy || !selected.installable}
                    onClick={approve}
                    className="self-start"
                  >
                    <Check aria-hidden />
                    {busy
                      ? request.kind === "update" || selected.installed
                        ? "Updating…"
                        : "Installing…"
                      : request.kind === "update" || selected.installed
                        ? selected.support === "official"
                          ? "Verify release and update"
                          : "Approve this digest and update"
                        : selected.definition === "oim"
                          ? selected.support === "official"
                            ? "Verify release and install"
                            : "Approve this digest and install"
                          : "Install reviewed package"}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
