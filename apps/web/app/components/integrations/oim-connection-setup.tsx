import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { ApiError } from "~/lib/api";
import {
  createOimConnection,
  getOimConnectionSetup,
  type OimConnectionRefreshStep,
  type OimConnectionSetup as OimConnectionSetupModel,
  type OimConnectionVerificationError,
  refreshOimConnection,
  startOimConnectionAuthorization,
  updateOimConnectionCredentials,
} from "~/lib/integrations";
import { followAuthAction } from "./auth-flow";
import { IntegrationChoice } from "./integration-choice";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "The Connection changed or is no longer editable. Reload its setup before retrying.";
  }
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Request failed.";
}

function ownerScopeLabel(scope: OimConnectionSetupModel["allowedOwnerScopes"][number]): string {
  if (scope === "organization") return "Business";
  if (scope === "team") return "Team";
  return "Personal";
}

function connectionReadyStatus(setup: OimConnectionSetupModel): string {
  return setup.pendingAuthorizationStepIds?.length
    ? "Connection created. Finish provider authorization."
    : "Connection added.";
}

function connectionLoadedStatus(setup: OimConnectionSetupModel): string {
  return setup.pendingAuthorizationStepIds?.length
    ? "Connection setup loaded. Finish provider authorization."
    : "Connection setup loaded.";
}

type RequestToken = {
  connectionId: string | undefined;
  selectionGeneration: number;
  requestGeneration: number;
};

type OwnerScope = OimConnectionSetupModel["allowedOwnerScopes"][number];
type VerificationIssue = OimConnectionVerificationError | "unknown";

function isVerificationError(
  error: OimConnectionRefreshStep["error"]
): error is OimConnectionVerificationError {
  return (
    error === "provider_proof_failed" ||
    error === "verification_unavailable" ||
    error === "verification_persistence_failed"
  );
}

function verificationMessage(issue: VerificationIssue): string {
  if (issue === "provider_proof_failed") {
    return "The provider rejected the saved credentials. Correct or reconnect the credentials before retrying.";
  }
  if (issue === "verification_persistence_failed") {
    return "The credentials were verified, but the result could not be saved. Retry verification.";
  }
  if (issue === "verification_unavailable") {
    return "The provider could not verify this Connection. Retry verification.";
  }
  return "Verify the saved credentials before this Connection can be used.";
}

function verificationStatus(issue: VerificationIssue, created: boolean): string {
  const prefix = created ? "Connection created, but " : "Connection ";
  if (issue === "provider_proof_failed") {
    return `${prefix}credentials were rejected. Correct or reconnect them before retrying.`;
  }
  return `${prefix}verification needs another try.`;
}

export function OimConnectionSetup({
  integrationKey,
  setup,
  setupError,
  connectionId: initialConnectionId,
  onConnectionSelected,
  onChanged,
  teams = [],
  teamsError,
  onAddAnother,
  unavailable,
  connectionLabel,
}: {
  integrationKey: string;
  setup?: OimConnectionSetupModel;
  setupError?: string;
  connectionId?: string;
  onConnectionSelected?: (connectionId: string) => void;
  onChanged: () => void;
  teams?: readonly { id: string; name: string }[];
  teamsError?: string;
  onAddAnother?: () => void;
  unavailable?: string;
  connectionLabel?: string;
}) {
  const [currentSetup, setCurrentSetup] = useState(setup);
  const [connectionId, setConnectionId] = useState(initialConnectionId);
  const [label, setLabel] = useState("");
  const [ownerScope, setOwnerScope] = useState<OwnerScope | undefined>(
    setup?.allowedOwnerScopes[0]
  );
  const [ownerId, setOwnerId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [setupLoadState, setSetupLoadState] = useState<"idle" | "loading" | "failed">(
    setupError ? "failed" : "idle"
  );
  const [authorizingStep, setAuthorizingStep] = useState<string>();
  const initialVerificationIssue: VerificationIssue | undefined =
    initialConnectionId && setup?.connectionHealth === "action_required" ? "unknown" : undefined;
  const [verificationIssue, setVerificationIssue] = useState<VerificationIssue | undefined>(
    initialVerificationIssue
  );
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<{ id: string; message: string }>();
  const [setupLoadError, setSetupLoadError] = useState(setupError);
  const [status, setStatus] = useState(
    setupError
      ? "Connection setup could not load. Retry to continue."
      : initialVerificationIssue
        ? verificationStatus(initialVerificationIssue, false)
        : ""
  );
  const nextStepHeading = useRef<HTMLHeadingElement>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const selection = useRef({ connectionId: initialConnectionId, generation: 0 });
  const previousInitialConnectionId = useRef(initialConnectionId);
  const createRequestGeneration = useRef(0);
  const setupRequestGeneration = useRef(0);
  const authorizationRequestGeneration = useRef(0);
  const verificationRequestGeneration = useRef(0);
  const verificationIssueRef = useRef<VerificationIssue | undefined>(initialVerificationIssue);
  const locallyVerifiedConnectionId = useRef<string | undefined>(undefined);
  const exactSetupConnectionId = useRef<string | undefined>(
    initialConnectionId && setup && !setupError ? initialConnectionId : undefined
  );
  const setupFailureConnectionId = useRef<string | undefined>(
    initialConnectionId && setupError ? initialConnectionId : undefined
  );
  const setupFailurePending = useRef(setupError !== undefined);
  const locallyCreatedConnectionId = useRef<string | undefined>(undefined);
  const creationAnnouncementPending = useRef(false);
  const selectedOwnerScope =
    ownerScope !== undefined && currentSetup?.allowedOwnerScopes.includes(ownerScope)
      ? ownerScope
      : currentSetup?.allowedOwnerScopes[0];
  const selectedOwnerId = ownerScope === selectedOwnerScope ? ownerId : "";

  const invalidateRequests = useCallback(() => {
    createRequestGeneration.current += 1;
    setupRequestGeneration.current += 1;
    authorizationRequestGeneration.current += 1;
    verificationRequestGeneration.current += 1;
  }, []);

  const updateVerificationIssue = useCallback((issue: VerificationIssue | undefined) => {
    verificationIssueRef.current = issue;
    setVerificationIssue(issue);
  }, []);

  function requestIsCurrent(token: RequestToken, requestGeneration: { current: number }): boolean {
    return (
      token.requestGeneration === requestGeneration.current &&
      token.selectionGeneration === selection.current.generation &&
      token.connectionId === selection.current.connectionId
    );
  }

  function beginRequest(requestGeneration: { current: number }): RequestToken {
    requestGeneration.current += 1;
    return {
      connectionId: selection.current.connectionId,
      selectionGeneration: selection.current.generation,
      requestGeneration: requestGeneration.current,
    };
  }

  useLayoutEffect(() => {
    const previousConnectionId = previousInitialConnectionId.current;
    previousInitialConnectionId.current = initialConnectionId;
    const switchedConnections =
      initialConnectionId !== undefined && initialConnectionId !== selection.current.connectionId;
    const clearedConnection =
      initialConnectionId === undefined &&
      previousConnectionId !== undefined &&
      selection.current.connectionId === previousConnectionId;

    if (switchedConnections || clearedConnection) {
      invalidateRequests();
      selection.current = {
        connectionId: initialConnectionId,
        generation: selection.current.generation + 1,
      };
      exactSetupConnectionId.current =
        initialConnectionId && setup && !setupError ? initialConnectionId : undefined;
      setupFailureConnectionId.current =
        initialConnectionId && setupError ? initialConnectionId : undefined;
      setupFailurePending.current = setupError !== undefined;
      locallyCreatedConnectionId.current = undefined;
      creationAnnouncementPending.current = false;
      locallyVerifiedConnectionId.current = undefined;
      const nextVerificationIssue =
        initialConnectionId && setup?.connectionHealth === "action_required"
          ? "unknown"
          : undefined;
      verificationIssueRef.current = nextVerificationIssue;
      setConnectionId(initialConnectionId);
      setValues({});
      setLabel("");
      setOwnerId("");
      setCurrentSetup(setup);
      setSubmitting(false);
      setVerifying(false);
      setVerificationIssue(nextVerificationIssue);
      setSetupLoadState(setupError ? "failed" : "idle");
      setAuthorizingStep(undefined);
      setError(undefined);
      setFieldError(undefined);
      setSetupLoadError(setupError);
      setStatus(
        setupError
          ? "Connection setup could not load. Retry to continue."
          : nextVerificationIssue
            ? verificationStatus(nextVerificationIssue, false)
            : initialConnectionId && setup
              ? connectionLoadedStatus(setup)
              : "Connection setup reset. Add Connection details."
      );
      return;
    }

    if (initialConnectionId === undefined) {
      if (selection.current.connectionId === undefined) {
        setCurrentSetup(setup);
        if (setupError) {
          setupFailurePending.current = true;
          setSetupLoadState("failed");
          setSetupLoadError(setupError);
          setStatus("Connection setup could not load. Retry to continue.");
        } else if (setup) {
          const recoveredSetup = setupFailurePending.current;
          setupFailurePending.current = false;
          setSetupLoadState("idle");
          setSetupLoadError(undefined);
          if (recoveredSetup) {
            setStatus("Connection setup loaded. Add Connection details.");
          }
        }
      }
      return;
    }

    if (setupError) {
      if (exactSetupConnectionId.current === initialConnectionId) return;
      setupFailureConnectionId.current = initialConnectionId;
      setupFailurePending.current = true;
      setSetupLoadState("failed");
      setSetupLoadError(setupError);
      setStatus("Connection setup could not load. Retry to continue.");
      return;
    }

    if (!setup) return;
    const recoveredConnection =
      setupFailurePending.current && setupFailureConnectionId.current === initialConnectionId;
    setupRequestGeneration.current += 1;
    exactSetupConnectionId.current = initialConnectionId;
    setupFailureConnectionId.current = undefined;
    setupFailurePending.current = false;
    setCurrentSetup(setup);
    setSetupLoadState("idle");
    setSetupLoadError(undefined);
    if (setup.connectionHealth === "healthy") {
      updateVerificationIssue(undefined);
    } else if (
      setup.connectionHealth === "action_required" &&
      locallyVerifiedConnectionId.current !== initialConnectionId &&
      verificationIssueRef.current === undefined
    ) {
      updateVerificationIssue("unknown");
    }
    const currentVerificationIssue = verificationIssueRef.current;
    if (currentVerificationIssue !== undefined) {
      setStatus(
        verificationStatus(
          currentVerificationIssue,
          locallyCreatedConnectionId.current === initialConnectionId
        )
      );
      creationAnnouncementPending.current = false;
      return;
    }
    if (
      creationAnnouncementPending.current &&
      locallyCreatedConnectionId.current === initialConnectionId
    ) {
      setStatus(connectionReadyStatus(setup));
      creationAnnouncementPending.current = false;
    } else if (recoveredConnection) {
      setStatus(connectionLoadedStatus(setup));
    }
  }, [setup, setupError, initialConnectionId, invalidateRequests, updateVerificationIssue]);

  useEffect(() => {
    if (!status.startsWith("Connection ")) return;
    if (connectionId === undefined && currentSetup !== undefined && setupLoadState === "idle") {
      formHeading.current?.focus();
    } else {
      nextStepHeading.current?.focus();
    }
  }, [status, connectionId, currentSetup, setupLoadState]);

  useEffect(() => {
    if (!fieldError) return;
    const input = Array.from(sectionRef.current?.querySelectorAll("input") ?? []).find(
      (input) => input.name === fieldError.id
    );
    input?.focus();
  }, [fieldError]);

  useEffect(() => {
    if (!currentSetup) {
      if (ownerScope !== undefined) setOwnerScope(undefined);
      if (ownerId) setOwnerId("");
      return;
    }
    if (ownerScope !== undefined && currentSetup.allowedOwnerScopes.includes(ownerScope)) {
      return;
    }
    setOwnerScope(currentSetup.allowedOwnerScopes[0]);
    setOwnerId("");
  }, [currentSetup, ownerScope, ownerId]);

  async function loadSelectedConnectionSetup(selectedConnectionId: string) {
    const token = beginRequest(setupRequestGeneration);
    if (token.connectionId !== selectedConnectionId) return;
    setSetupLoadState("loading");
    setStatus("Connection setup loading…");
    setSetupLoadError(undefined);
    try {
      const nextSetup = await getOimConnectionSetup(integrationKey, selectedConnectionId);
      if (!requestIsCurrent(token, setupRequestGeneration)) return;
      const locallyCreated = locallyCreatedConnectionId.current === selectedConnectionId;
      let currentVerificationIssue = verificationIssueRef.current;
      if (nextSetup.connectionHealth === "healthy") {
        locallyVerifiedConnectionId.current = selectedConnectionId;
        updateVerificationIssue(undefined);
        currentVerificationIssue = undefined;
      } else if (
        nextSetup.connectionHealth === "action_required" &&
        locallyVerifiedConnectionId.current !== selectedConnectionId &&
        currentVerificationIssue === undefined
      ) {
        updateVerificationIssue("unknown");
        currentVerificationIssue = "unknown";
      }
      exactSetupConnectionId.current = selectedConnectionId;
      setupFailureConnectionId.current = undefined;
      setupFailurePending.current = false;
      setCurrentSetup(nextSetup);
      setSetupLoadState("idle");
      setStatus(
        currentVerificationIssue === undefined
          ? locallyCreated
            ? connectionReadyStatus(nextSetup)
            : connectionLoadedStatus(nextSetup)
          : verificationStatus(currentVerificationIssue, locallyCreated)
      );
      creationAnnouncementPending.current = false;
      onChanged();
    } catch (requestError) {
      if (!requestIsCurrent(token, setupRequestGeneration)) return;
      setupFailureConnectionId.current = selectedConnectionId;
      setupFailurePending.current = true;
      setSetupLoadState("failed");
      setSetupLoadError(errorMessage(requestError));
      setStatus(
        locallyCreatedConnectionId.current === selectedConnectionId
          ? "Connection created. Setup details could not load. Retry to continue."
          : "Connection setup could not load. Retry to continue."
      );
    }
  }

  async function createConnection() {
    if (selectedOwnerScope === undefined) {
      setError("No owner scope is available.");
      return;
    }
    if (selectedOwnerScope === "team" && !teams.some((team) => team.id === selectedOwnerId)) {
      setError("Choose an available Team.");
      return;
    }
    const token = beginRequest(createRequestGeneration);
    setSubmitting(true);
    setError(undefined);
    setFieldError(undefined);
    try {
      const result = await createOimConnection(integrationKey, {
        label,
        ownerScope: selectedOwnerScope,
        ...(selectedOwnerScope === "team" ? { ownerId: selectedOwnerId } : {}),
        values,
      });
      if (!requestIsCurrent(token, createRequestGeneration)) return;
      invalidateRequests();
      selection.current = {
        connectionId: result.connectionId,
        generation: selection.current.generation + 1,
      };
      locallyCreatedConnectionId.current = result.connectionId;
      creationAnnouncementPending.current = true;
      const nextVerificationIssue =
        result.verification.status === "action_required" ? result.verification.error : undefined;
      updateVerificationIssue(nextVerificationIssue);
      locallyVerifiedConnectionId.current =
        result.verification.status === "verified" ? result.connectionId : undefined;
      exactSetupConnectionId.current = undefined;
      setConnectionId(result.connectionId);
      setValues({});
      setSubmitting(false);
      setSetupLoadError(undefined);
      if (nextVerificationIssue !== undefined) {
        setStatus(verificationStatus(nextVerificationIssue, true));
      }
      onConnectionSelected?.(result.connectionId);
      await loadSelectedConnectionSetup(result.connectionId);
    } catch (requestError) {
      if (!requestIsCurrent(token, createRequestGeneration)) return;
      setError(errorMessage(requestError));
      captureFieldError(requestError);
      setSubmitting(false);
    }
  }

  async function retryVerification() {
    if (connectionId === undefined) return;
    const token = beginRequest(verificationRequestGeneration);
    if (token.connectionId !== connectionId) return;
    setVerifying(true);
    setError(undefined);
    try {
      const result = await refreshOimConnection(integrationKey, connectionId);
      if (!requestIsCurrent(token, verificationRequestGeneration)) return;
      const verificationStep = result.steps.find(
        (step) => step.stepId === "verification" && step.status === "action_required"
      );
      const nextIssue =
        result.health === "healthy"
          ? undefined
          : verificationStep && isVerificationError(verificationStep.error)
            ? verificationStep.error
            : "unknown";
      updateVerificationIssue(nextIssue);
      if (nextIssue === undefined) {
        locallyVerifiedConnectionId.current = connectionId;
        setStatus("Connection verified.");
      } else {
        setStatus(
          verificationStatus(nextIssue, locallyCreatedConnectionId.current === connectionId)
        );
      }
      onChanged();
    } catch (requestError) {
      if (!requestIsCurrent(token, verificationRequestGeneration)) return;
      setError(errorMessage(requestError));
      setStatus("Connection verification could not be retried.");
    } finally {
      if (requestIsCurrent(token, verificationRequestGeneration)) {
        setVerifying(false);
      }
    }
  }

  async function saveCredentials() {
    if (!connectionId) return;
    const token = beginRequest(verificationRequestGeneration);
    setVerifying(true);
    setError(undefined);
    setFieldError(undefined);
    try {
      const replacements = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== "")
      );
      if (Object.keys(replacements).length === 0) {
        setError("Enter at least one replacement value.");
        return;
      }
      const result = await updateOimConnectionCredentials(
        integrationKey,
        connectionId,
        replacements
      );
      if (!requestIsCurrent(token, verificationRequestGeneration)) return;
      setValues({});
      const issue =
        result.verification.status === "action_required"
          ? result.verification.error
          : result.verification.status === "pending"
            ? "unknown"
            : undefined;
      updateVerificationIssue(issue);
      locallyVerifiedConnectionId.current =
        result.verification.status === "verified" ? connectionId : undefined;
      setStatus(
        issue
          ? verificationStatus(issue, false)
          : result.verification.status === "verified"
            ? "Connection verified."
            : "Credentials saved."
      );
      onChanged();
    } catch (cause) {
      if (requestIsCurrent(token, verificationRequestGeneration)) {
        setError(errorMessage(cause));
        captureFieldError(cause);
      }
    } finally {
      if (requestIsCurrent(token, verificationRequestGeneration)) setVerifying(false);
    }
  }

  function captureFieldError(cause: unknown) {
    if (cause instanceof ApiError && cause.path?.startsWith("/values/")) {
      setFieldError({
        id: cause.path.slice("/values/".length).replaceAll("~1", "/").replaceAll("~0", "~"),
        message: cause.message,
      });
    }
  }

  async function authorize(stepId: string) {
    if (connectionId === undefined) return;
    const token = beginRequest(authorizationRequestGeneration);
    if (token.connectionId !== connectionId) return;
    setAuthorizingStep(stepId);
    setError(undefined);
    try {
      const action = await startOimConnectionAuthorization(integrationKey, connectionId, stepId);
      if (!requestIsCurrent(token, authorizationRequestGeneration)) return;
      if (action.action === "pending") {
        setStatus("Webhook setup is pending provider confirmation.");
        const nextSetup = await getOimConnectionSetup(integrationKey, connectionId);
        if (!requestIsCurrent(token, authorizationRequestGeneration)) return;
        exactSetupConnectionId.current = connectionId;
        setCurrentSetup(nextSetup);
        onChanged();
      } else {
        followAuthAction(action);
      }
      if (action.action === "completed") {
        const nextSetup = await getOimConnectionSetup(integrationKey, connectionId);
        if (!requestIsCurrent(token, authorizationRequestGeneration)) return;
        exactSetupConnectionId.current = connectionId;
        setCurrentSetup(nextSetup);
        setStatus("Authorization step completed.");
        onChanged();
      }
    } catch (requestError) {
      if (!requestIsCurrent(token, authorizationRequestGeneration)) return;
      setError(errorMessage(requestError));
    } finally {
      if (requestIsCurrent(token, authorizationRequestGeneration)) {
        setAuthorizingStep(undefined);
      }
    }
  }

  const pendingSteps =
    currentSetup?.initialAuthorizationSteps.filter((step) =>
      currentSetup.pendingAuthorizationStepIds?.includes(step.id)
    ) ?? [];

  return (
    <section ref={sectionRef} className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 ref={formHeading} tabIndex={-1} className="text-sm font-semibold text-foreground">
          {connectionId === undefined ? "Add Connection" : "Connection setup"}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Add the reviewed settings, then finish any provider authorization.
        </p>
        {connectionId && connectionLabel ? (
          <p className="mt-1 text-sm text-foreground">Editing {connectionLabel}</p>
        ) : null}
        {connectionId && onAddAnother ? (
          <Button type="button" variant="outline" className="mt-3" onClick={onAddAnother}>
            Add another Connection
          </Button>
        ) : null}
      </div>

      {unavailable ? (
        <p role="status" className="text-sm text-muted-foreground">
          {unavailable}
        </p>
      ) : setupLoadState === "loading" ? (
        <h3 ref={nextStepHeading} tabIndex={-1} className="text-sm font-medium text-foreground">
          Loading Connection setup…
        </h3>
      ) : setupLoadState === "failed" || currentSetup === undefined ? (
        <div className="space-y-3">
          <h3 ref={nextStepHeading} tabIndex={-1} className="text-sm font-medium text-foreground">
            {connectionId !== undefined && locallyCreatedConnectionId.current === connectionId
              ? "Connection created"
              : connectionId
                ? "Connection selected"
                : "Connection setup unavailable"}
          </h3>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              connectionId === undefined
                ? onChanged()
                : void loadSelectedConnectionSetup(connectionId)
            }
          >
            Retry setup
          </Button>
        </div>
      ) : connectionId === undefined ? (
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createConnection();
          }}
        >
          <Field label="Connection name">
            <Input
              name="connection-label"
              autoComplete="off"
              value={label}
              required
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>

          <Field label="Owner">
            <IntegrationChoice
              label="Owner"
              value={selectedOwnerScope ?? ""}
              options={currentSetup.allowedOwnerScopes.map((scope) => ({
                value: scope,
                label: ownerScopeLabel(scope),
              }))}
              onChange={(value) => {
                const scope = currentSetup.allowedOwnerScopes.find((scope) => scope === value);
                if (scope) {
                  setOwnerScope(scope);
                  setOwnerId("");
                }
              }}
              disabled={submitting}
            />
          </Field>

          {selectedOwnerScope === "team" ? (
            <Field
              label="Team"
              help={
                teamsError ??
                (teams.length === 0 ? "No authorized Teams are available." : undefined)
              }
            >
              <IntegrationChoice
                label="Team"
                value={selectedOwnerId}
                options={teams.map((team) => ({ value: team.id, label: team.name }))}
                onChange={setOwnerId}
                disabled={submitting || !!teamsError}
              />
            </Field>
          ) : null}

          {currentSetup.fieldSteps.flatMap((step) =>
            step.fields.map((field) => (
              <Field
                key={`${step.id}:${field.id}`}
                label={field.label}
                help={field.description}
                error={fieldError?.id === field.id ? fieldError.message : undefined}
              >
                <Input
                  name={field.id}
                  autoComplete="off"
                  type={field.input}
                  value={values[field.id] ?? ""}
                  required={field.required}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.id]: event.target.value }))
                  }
                />
              </Field>
            ))
          )}

          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                submitting ||
                selectedOwnerScope === undefined ||
                (selectedOwnerScope === "team" &&
                  !teams.some((team) => team.id === selectedOwnerId))
              }
            >
              {submitting ? "Creating…" : "Create Connection"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          {currentSetup.fieldSteps.some((step) => step.fields.length > 0) ? (
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void saveCredentials();
              }}
            >
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Correct settings or replace credentials for this exact Connection. Leave a field
                blank to keep its saved value. Stored secrets are never shown.
              </p>
              {currentSetup.fieldSteps.flatMap((step) =>
                step.fields.map((field) => (
                  <Field
                    key={`${step.id}:${field.id}`}
                    label={field.label}
                    help={field.description}
                    error={fieldError?.id === field.id ? fieldError.message : undefined}
                  >
                    <Input
                      name={field.id}
                      type={field.input}
                      autoComplete="off"
                      disabled={verifying || authorizingStep !== undefined}
                      value={values[field.id] ?? ""}
                      onChange={(event) =>
                        setValues((current) => ({ ...current, [field.id]: event.target.value }))
                      }
                    />
                  </Field>
                ))
              )}
              <div className="sm:col-span-2">
                <Button type="submit" disabled={verifying || authorizingStep !== undefined}>
                  {verifying ? "Verifying…" : "Save credentials and verify"}
                </Button>
              </div>
            </form>
          ) : null}
          {pendingSteps.length > 0 ? (
            <>
              <h3
                ref={nextStepHeading}
                tabIndex={-1}
                className="text-sm font-medium text-foreground"
              >
                Finish provider authorization
              </h3>
              <div className="flex flex-wrap gap-2">
                {pendingSteps.map((step) => (
                  <Button
                    key={step.id}
                    type="button"
                    variant="outline"
                    disabled={authorizingStep !== undefined || verifying}
                    onClick={() => void authorize(step.id)}
                  >
                    {authorizingStep === step.id ? "Opening…" : `Continue with ${step.title}`}
                  </Button>
                ))}
              </div>
            </>
          ) : verificationIssue !== undefined ? (
            <>
              <h3
                ref={nextStepHeading}
                tabIndex={-1}
                className="text-sm font-medium text-foreground"
              >
                Connection needs verification
              </h3>
              <p className="text-sm text-destructive">{verificationMessage(verificationIssue)}</p>
              <Button
                type="button"
                variant="outline"
                disabled={verifying}
                onClick={() => void retryVerification()}
              >
                {verifying ? "Verifying…" : "Retry verification"}
              </Button>
            </>
          ) : (
            <h3 ref={nextStepHeading} tabIndex={-1} className="text-sm font-medium text-foreground">
              Connection added
            </h3>
          )}
        </div>
      )}

      <p role="status" className="sr-only">
        {status}
      </p>
      {setupLoadError || error ? (
        <p role="alert" className="text-sm text-destructive">
          {setupLoadError ?? error}
        </p>
      ) : null}
    </section>
  );
}
