import type { McpAccountSummary, McpKnowledgePut, McpKnowledgeStatus } from "@tulipfarm/schema";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import {
  getMcpKnowledge,
  removeMcpKnowledge,
  saveMcpKnowledge,
  syncMcpKnowledge,
} from "~/lib/mcp-knowledge";
import { randomUUID } from "~/lib/uuid";
import { McpError, McpField } from "./mcp-form";

type SourceFile = McpKnowledgePut["files"][number];
type DraftFile = { id: string; source: SourceFile };
const emptyFile = (): DraftFile => ({
  id: randomUUID(),
  source: { owner: "", repo: "", path: "", ref: "" },
});

function knowledgeMessage(code: string): string {
  const messages: Record<string, string> = {
    unsupported_source: "This server does not support this Knowledge source.",
    unsupported_shared_sync: "Shared Knowledge sync is not supported for this source.",
    invalid_selection: "Check the repository, file path, and full branch reference.",
    identity_mismatch: "The account identity changed. Reconnect and review the source selection.",
    source_unavailable:
      "A source is missing or access was lost. Its copied content cannot be used.",
    source_too_large: "A source exceeds the supported size limit.",
    source_response_invalid: "The source returned content that could not be safely synced.",
    selection_changed: "The source selection changed. Reload before continuing.",
    publication_failed:
      "A source could not be saved to Knowledge. Review the progress before retrying.",
  };
  return (
    messages[code] ?? "Knowledge sync needs attention. Check this account and its source setup."
  );
}

export function McpKnowledge({ account }: { account: McpAccountSummary }) {
  const [status, setStatus] = useState<McpKnowledgeStatus>();
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");

  function accept(next: McpKnowledgeStatus) {
    setStatus(next);
    setEnabled(next.selection?.enabled ?? true);
    setFiles(
      next.selection?.files.map((source) => ({ id: randomUUID(), source })) ?? [emptyFile()]
    );
    setDirty(false);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads the persisted account selection.
  useEffect(() => {
    let live = true;
    setStatus(undefined);
    setError(undefined);
    getMcpKnowledge(account.integrationKey, account.id)
      .then((next) => {
        if (live) accept(next);
      })
      .catch((cause) => {
        if (live) setError(cause);
      });
    return () => {
      live = false;
    };
  }, [account.integrationKey, account.id, attempt]);

  async function mutate(action: () => Promise<McpKnowledgeStatus>, message: string) {
    setPending(true);
    setError(undefined);
    setNotice("");
    try {
      accept(await action());
      setConfirming(false);
      setNotice(message);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }

  const selection = status?.selection;
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <h4 className="text-sm font-medium">Knowledge sync</h4>
      <p className="text-xs text-muted-foreground">
        Choose specific source files. Connecting an account does not copy content. Personal copies
        stay private and synced Pages are read-only.
      </p>
      <McpError error={error} />
      {!status ? (
        error ? (
          <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            Retry Knowledge status
          </Button>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            Loading Knowledge status...
          </p>
        )
      ) : (
        <>
          {!status.eligibility.supported && (
            <p className="text-sm text-muted-foreground">
              {status.eligibility.reason
                ? knowledgeMessage(status.eligibility.reason)
                : "Knowledge sync is not available for this account."}{" "}
              Only supported personal GitHub file sources can be synced. Slack content is never
              synced.
            </p>
          )}
          {selection && (
            <section
              aria-label="Knowledge sync progress"
              className="space-y-1 text-xs text-muted-foreground"
            >
              <p>{selection.enabled ? "Scheduled sync enabled" : "Scheduled sync paused"}</p>
              {selection.progress && (
                <p>
                  {selection.progress.synced} synced · {selection.progress.failed} failed ·{" "}
                  {selection.progress.complete
                    ? "Current pass complete"
                    : "Current pass incomplete"}
                </p>
              )}
              <p>
                Last completed:{" "}
                {selection.lastCompletedAt
                  ? new Date(selection.lastCompletedAt).toLocaleString()
                  : "Never"}
              </p>
              {selection.lastAttemptAt && (
                <p>Last attempted: {new Date(selection.lastAttemptAt).toLocaleString()}</p>
              )}
              {selection.enabled && (
                <p>Next scheduled attempt: {new Date(selection.nextAttemptAt).toLocaleString()}</p>
              )}
              {selection.errorCode && <p role="alert">{knowledgeMessage(selection.errorCode)}</p>}
              {selection.progress?.failures.map((failure) => (
                <p key={`${failure.index}:${failure.code}`}>
                  File {failure.index + 1}: {knowledgeMessage(failure.code)}
                </p>
              ))}
              {selection.cleanupPending > 0 && (
                <p role="status">
                  {selection.cleanupPending} copied Pages await cleanup. Hidden content is not
                  available for retrieval.
                </p>
              )}
            </section>
          )}
          {status.eligibility.supported && (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(
                  () =>
                    saveMcpKnowledge(account.integrationKey, account.id, {
                      ...(selection ? { expectedRevision: selection.revision } : {}),
                      enabled,
                      files: files.map(({ source }) => ({
                        owner: source.owner.trim(),
                        repo: source.repo.trim(),
                        path: source.path.trim(),
                        ref: source.ref.trim(),
                      })),
                      pollIntervalMs: selection?.pollIntervalMs ?? 900_000,
                    }),
                  "Source selection saved. Review sync progress for the actual result."
                );
              }}
            >
              <fieldset disabled={pending} className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Select .md or .txt files on a branch, using its full reference such as
                  refs/heads/main. The current source adapter requires a supported pinned local
                  GitHub MCP server.
                </p>
                {files.map((file, index) => (
                  <fieldset key={file.id} className="space-y-2 rounded-md border border-border p-3">
                    <legend className="px-1 text-xs font-medium">Source file {index + 1}</legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(["owner", "repo", "path", "ref"] as const).map((field) => (
                        <McpField
                          key={field}
                          label={
                            {
                              owner: "Repository owner",
                              repo: "Repository",
                              path: "File path",
                              ref: "Branch reference",
                            }[field]
                          }
                        >
                          <Input
                            required
                            maxLength={1024}
                            value={file.source[field]}
                            pattern={field === "ref" ? "refs/heads/.+" : undefined}
                            onChange={(event) => {
                              setFiles(
                                files.map((entry) =>
                                  entry.id === file.id
                                    ? {
                                        ...entry,
                                        source: { ...entry.source, [field]: event.target.value },
                                      }
                                    : entry
                                )
                              );
                              setDirty(true);
                            }}
                          />
                        </McpField>
                      ))}
                    </div>
                    {files.length > 1 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setFiles(files.filter((entry) => entry.id !== file.id));
                          setDirty(true);
                        }}
                      >
                        Remove file {index + 1}
                      </Button>
                    )}
                  </fieldset>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={files.length >= 1000}
                  onClick={() => {
                    setFiles([...files, emptyFile()]);
                    setDirty(true);
                  }}
                >
                  Add source file
                </Button>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => {
                      setEnabled(event.target.checked);
                      setDirty(true);
                    }}
                  />
                  Enable scheduled sync
                </label>
                <p className="text-xs text-muted-foreground">
                  New selections refresh every 15 minutes. Live source access is checked before use;
                  copied content is unavailable after 24 hours without a successful refresh.
                  Disconnecting or losing source access hides copied content and starts cleanup.
                </p>
                <Button type="submit">{pending ? "Saving..." : "Save Knowledge sources"}</Button>
              </fieldset>
            </form>
          )}
          <div className="flex flex-wrap gap-2">
            {selection && status.eligibility.supported && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || dirty || !selection.enabled}
                onClick={() =>
                  void mutate(
                    () => syncMcpKnowledge(account.integrationKey, account.id, selection.revision),
                    "Sync requested. Review progress; this does not mean every file has been copied."
                  )
                }
              >
                Sync now
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {dirty ? "Discard changes and reload" : "Refresh Knowledge status"}
            </Button>
            {selection && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setConfirming(true)}
              >
                Remove Knowledge sources
              </Button>
            )}
            <Button asChild size="sm" variant="outline">
              <Link to="/knowledge">Open Knowledge</Link>
            </Button>
          </div>
          {dirty && (
            <p className="text-xs text-muted-foreground">
              Save your source changes before starting a sync, or discard them to reload.
            </p>
          )}
          {confirming && selection && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Remove this source selection and its copied Pages? The original provider files are
                not changed.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={pending}
                  onClick={() =>
                    void mutate(
                      () =>
                        removeMcpKnowledge(account.integrationKey, account.id, selection.revision),
                      "Source removal saved. Review cleanup status for any remaining copied Pages."
                    )
                  }
                >
                  Confirm remove Knowledge sources
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
