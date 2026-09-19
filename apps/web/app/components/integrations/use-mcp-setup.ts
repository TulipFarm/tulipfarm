import { useEffect, useRef, useState } from "react";
import { ApiError } from "~/lib/api";
import {
  getMcpSetup,
  listMcpSetups,
  type McpSetupOperation,
  type McpSetupResume,
  type McpSetupStart,
  resumeMcpSetup,
  startMcpSetup,
} from "~/lib/mcp-setup";
import { randomUUID } from "~/lib/uuid";

export function useMcpSetup(
  onChanged: () => void,
  restoreTarget?: { integrationKey: string; accountId?: string }
) {
  const id = useRef<string | undefined>(undefined);
  const dismissed = useRef(new Set<string>());
  const generation = useRef(0);
  const [operation, setOperation] = useState<McpSetupOperation>();
  const [pending, setPending] = useState(false);
  const [resumeAttempted, setResumeAttempted] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<unknown>();
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const integrationKey = restoreTarget?.integrationKey;
  const accountId = restoreTarget?.accountId;
  const restoreKey = integrationKey && accountId ? `${integrationKey}:${accountId}` : undefined;
  const [restoration, setRestoration] = useState<{
    key?: string;
    loading: boolean;
    error?: unknown;
  }>({ loading: false });
  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry repeats only the saved-intent read.
  useEffect(() => {
    if (!integrationKey || !accountId) {
      setRestoration({ loading: false });
      return;
    }
    let live = true;
    const currentGeneration = generation.current;
    setRestoration({ key: restoreKey, loading: true });
    listMcpSetups(integrationKey, accountId)
      .then((operations) => {
        if (!live || generation.current !== currentGeneration) return;
        const latest = operations[0];
        if (
          !id.current &&
          latest &&
          latest.status !== "done" &&
          !dismissed.current.has(latest.id)
        ) {
          id.current = latest.id;
          setOperation(latest);
        }
        setRestoration({ key: restoreKey, loading: false });
      })
      .catch((cause) => {
        if (live && generation.current === currentGeneration)
          setRestoration({ key: restoreKey, loading: false, error: cause });
      });
    return () => {
      live = false;
    };
  }, [integrationKey, accountId, restoreKey, restoreAttempt]);

  async function refresh() {
    if (!id.current) return;
    const currentGeneration = generation.current;
    setPending(true);
    setError(undefined);
    try {
      const saved = await getMcpSetup(id.current);
      if (generation.current !== currentGeneration) return;
      setOperation(saved);
      setUncertain(false);
      onChanged();
    } catch (cause) {
      if (generation.current !== currentGeneration) return;
      if (cause instanceof ApiError && cause.status === 404) {
        setUncertain(false);
        setError(new Error("No saved setup was found. Submit Connect again to retry."));
      } else {
        setUncertain(true);
        setError(cause);
      }
    } finally {
      if (generation.current === currentGeneration) setPending(false);
    }
  }

  async function run(action: (operationId: string) => Promise<McpSetupOperation>) {
    id.current ??= randomUUID();
    const operationId = id.current;
    const currentGeneration = generation.current;
    setPending(true);
    setError(undefined);
    try {
      const next = await action(operationId);
      if (generation.current !== currentGeneration) return;
      setOperation(next);
      setUncertain(false);
      onChanged();
      return next;
    } catch (cause) {
      if (generation.current !== currentGeneration) return;
      setError(cause);
      if (!operation && cause instanceof ApiError && cause.code === "definition_changed") return;
      try {
        const saved = await getMcpSetup(operationId);
        if (generation.current !== currentGeneration) return;
        setOperation(saved);
        setUncertain(false);
        if (saved.status === "done") {
          setError(undefined);
        }
        onChanged();
        return saved;
      } catch (lookupError) {
        if (generation.current === currentGeneration)
          setUncertain(!(lookupError instanceof ApiError && lookupError.status === 404));
      }
    } finally {
      if (generation.current === currentGeneration) setPending(false);
    }
  }

  return {
    operation,
    pending,
    resumeAttempted,
    uncertain,
    error,
    restoring: !!restoreKey && (restoration.key !== restoreKey || restoration.loading),
    restoreError: restoration.key === restoreKey ? restoration.error : undefined,
    retryRestore: () => setRestoreAttempt((value) => value + 1),
    start: (input: McpSetupStart) => run((operationId) => startMcpSetup(operationId, input)),
    resume: (input?: McpSetupResume) => {
      setResumeAttempted(true);
      return run((operationId) => resumeMcpSetup(operationId, input));
    },
    refresh,
    restore(saved: McpSetupOperation) {
      if (id.current && id.current !== saved.id) return;
      id.current = saved.id;
      setOperation(saved);
      setUncertain(false);
      setError(undefined);
    },
    reset() {
      generation.current += 1;
      if (id.current) dismissed.current.add(id.current);
      id.current = undefined;
      setOperation(undefined);
      setUncertain(false);
      setError(undefined);
      setPending(false);
      setResumeAttempted(false);
    },
  };
}
