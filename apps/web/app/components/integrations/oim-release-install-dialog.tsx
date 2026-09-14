import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Modal } from "~/components/ui/modal";
import {
  type InstallOimReleaseInput,
  inspectOimReleaseSource,
  installOimRelease,
  type OimReleaseInspection,
} from "~/lib/integrations";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

export function OimReleaseInstallDialog({
  open,
  onClose,
  onInstalled,
}: {
  open: boolean;
  onClose: () => void;
  onInstalled: (integrationId: string) => void;
}) {
  const [source, setSource] = useState("");
  const [inspection, setInspection] = useState<OimReleaseInspection>();
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [trustClass, setTrustClass] = useState<"official" | "community">("official");
  const [approved, setApproved] = useState(false);
  const [activity, setActivity] = useState<"idle" | "inspect" | "install">("idle");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [retryInput, setRetryInput] = useState<InstallOimReleaseInput>();
  const generation = useRef(0);
  const sourceInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) sourceInput.current?.focus();
  }, [open]);

  function resetReview(nextSource = source) {
    if (activity === "install") return;
    generation.current += 1;
    setActivity("idle");
    setSource(nextSource);
    setInspection(undefined);
    setCandidateIndex(0);
    setApproved(false);
    setRetryInput(undefined);
    setError("");
    setStatus("");
  }

  function close() {
    if (activity === "install") return;
    generation.current += 1;
    setActivity("idle");
    onClose();
  }

  async function inspect() {
    const requestedSource = source.trim();
    if (!requestedSource) {
      setError("Enter a source to inspect.");
      sourceInput.current?.focus();
      return;
    }
    const request = ++generation.current;
    setActivity("inspect");
    setError("");
    setStatus("Inspecting source.");
    try {
      const result = await inspectOimReleaseSource(requestedSource);
      if (request !== generation.current) return;
      setInspection(result);
      setCandidateIndex(0);
      setApproved(false);
      setRetryInput(undefined);
      setStatus(
        `Found ${result.candidates.length} release candidate${result.candidates.length === 1 ? "" : "s"} to review.`
      );
    } catch (cause) {
      if (request !== generation.current) return;
      setError(errorMessage(cause));
      setStatus("Source inspection failed.");
    } finally {
      if (request === generation.current) setActivity("idle");
    }
  }

  const candidate = inspection?.candidates[candidateIndex];

  function makeInstallInput(): InstallOimReleaseInput | undefined {
    if (!inspection || !candidate?.review || candidate.issues.length > 0) return undefined;
    return {
      source: inspection.source,
      sourceRef: inspection.ref,
      slug: candidate.integrationId,
      selection: {
        integrationId: candidate.integrationId,
        version: candidate.version,
        packageDigest: candidate.packageDigest,
      },
      trustClass,
      ...(trustClass === "community" ? { approvedCommunityDigest: candidate.packageDigest } : {}),
      autoPatchOptIn: false,
    };
  }

  async function install(input: InstallOimReleaseInput) {
    const request = ++generation.current;
    setActivity("install");
    setError("");
    setStatus(
      input.trustClass === "official"
        ? "Server verification and installation in progress."
        : "Installing the approved Community package."
    );
    try {
      const result = await installOimRelease(input);
      if (request !== generation.current) return;
      setRetryInput(undefined);
      setStatus(
        result.trustClass === "official"
          ? "Official package verified and installed."
          : "Reviewed Community package installed."
      );
      onInstalled(input.selection.integrationId);
    } catch (cause) {
      if (request !== generation.current) return;
      setRetryInput(input);
      setError(errorMessage(cause));
      setStatus("Installation failed. Retry will use the same reviewed package.");
    } finally {
      if (request === generation.current) setActivity("idle");
    }
  }

  const canInstall =
    candidate?.review !== undefined &&
    candidate.issues.length === 0 &&
    (trustClass === "official" || approved);

  return (
    <Modal
      open={open}
      onClose={close}
      title="Install an integration"
      className="max-w-2xl"
      dismissible={activity !== "install"}
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <label htmlFor="oim-release-source" className="block font-medium">
            Package source
          </label>
          <input
            ref={sourceInput}
            id="oim-release-source"
            value={source}
            onChange={(event) => resetReview(event.target.value)}
            disabled={activity === "install"}
            placeholder="https://example.com/integrations.git"
            className="w-full rounded-md border border-input bg-background px-3 py-2"
          />
          <Button type="button" onClick={() => void inspect()} disabled={activity !== "idle"}>
            {activity === "inspect" ? "Inspecting…" : "Inspect source"}
          </Button>
        </div>

        {inspection && inspection.candidates.length > 1 ? (
          <div className="space-y-2">
            <label htmlFor="oim-release-candidate" className="block font-medium">
              Release candidate
            </label>
            <select
              id="oim-release-candidate"
              value={candidateIndex}
              disabled={activity === "install"}
              onChange={(event) => {
                generation.current += 1;
                setActivity("idle");
                setCandidateIndex(Number(event.target.value));
                setApproved(false);
                setRetryInput(undefined);
                setError("");
                setStatus("Review the selected release candidate.");
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2"
            >
              {inspection.candidates.map((item, index) => (
                <option key={`${item.sourcePath}:${item.packageDigest}`} value={index}>
                  {item.integrationId} {item.version}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {candidate ? (
          <section aria-labelledby="oim-release-review" className="space-y-4">
            <div>
              <h3 id="oim-release-review" className="font-medium">
                {candidate.review?.name ?? `${candidate.integrationId} ${candidate.version}`}
              </h3>
              <p className="text-muted-foreground">
                {candidate.review?.description ??
                  "Detailed package review is unavailable. Installation is blocked."}
              </p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                Reviewed ref {inspection.ref} · digest {candidate.packageDigest}
              </p>
            </div>

            {candidate.review ? (
              <>
                <div>
                  <h4 className="font-medium">Capabilities and effects</h4>
                  <ul className="mt-1 space-y-2">
                    {candidate.review.operations.map((operation) => (
                      <li
                        key={`${operation.name}:${operation.destination}`}
                        className="rounded-md border p-2"
                      >
                        <span className="font-medium">{operation.name}</span>
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                          {operation.effect}
                        </span>
                        <p>{operation.description}</p>
                        <p className="break-all text-xs text-muted-foreground">
                          Destination: {operation.destination}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium">Authorization</h4>
                  <p className="text-muted-foreground">
                    {candidate.review.auth.steps.length === 0
                      ? "No provider authorization steps."
                      : candidate.review.auth.steps
                          .map((step) => `${step.title} (${step.type})`)
                          .join(", ")}
                  </p>
                  {candidate.review.auth.credentialLabels.length +
                    candidate.review.auth.configurationLabels.length >
                  0 ? (
                    <p className="text-muted-foreground">
                      Required setup:{" "}
                      {[
                        ...candidate.review.auth.credentialLabels,
                        ...candidate.review.auth.configurationLabels,
                      ].join(", ")}
                    </p>
                  ) : null}
                </div>
                <div>
                  <h4 className="font-medium">Incoming data</h4>
                  <p className="text-muted-foreground">
                    {[
                      candidate.review.ingress.events && "events",
                      candidate.review.ingress.polling && "polling",
                      candidate.review.ingress.knowledge && "Knowledge sync",
                    ]
                      .filter(Boolean)
                      .join(", ") || "None declared"}
                  </p>
                </div>
              </>
            ) : null}

            {candidate.issues.length > 0 ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 p-3 text-destructive"
              >
                This candidate cannot be installed: {candidate.issues.join("; ")}
              </div>
            ) : null}

            {candidate.review && candidate.issues.length === 0 ? (
              <fieldset className="space-y-2">
                <legend className="font-medium">Trust verification</legend>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="oim-trust"
                    checked={trustClass === "official"}
                    disabled={activity === "install"}
                    onChange={() => {
                      generation.current += 1;
                      setActivity("idle");
                      setTrustClass("official");
                      setApproved(false);
                      setRetryInput(undefined);
                    }}
                  />
                  <span>Verify as Official on the server before installation</span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="oim-trust"
                    checked={trustClass === "community"}
                    disabled={activity === "install"}
                    onChange={() => {
                      generation.current += 1;
                      setActivity("idle");
                      setTrustClass("community");
                      setApproved(false);
                      setRetryInput(undefined);
                    }}
                  />
                  <span>Install as a reviewed Community package</span>
                </label>
                {trustClass === "community" ? (
                  <label className="flex items-start gap-2 rounded-md border p-3">
                    <input
                      type="checkbox"
                      checked={approved}
                      disabled={activity === "install"}
                      onChange={(event) => setApproved(event.target.checked)}
                    />
                    <span>
                      I approve the capabilities, destinations, effects, and exact digest shown
                      above.
                    </span>
                  </label>
                ) : null}
              </fieldset>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={activity === "install"}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={activity !== "idle" || (!retryInput && !canInstall)}
                onClick={() => {
                  const input = retryInput ?? makeInstallInput();
                  if (input) void install(input);
                }}
              >
                {activity === "install"
                  ? "Installing…"
                  : retryInput
                    ? "Retry same package"
                    : "Install"}
              </Button>
            </div>
          </section>
        ) : null}

        {error ? <p role="alert">{error}</p> : null}
        <p role="status" className="sr-only">
          {status}
        </p>
      </div>
    </Modal>
  );
}
