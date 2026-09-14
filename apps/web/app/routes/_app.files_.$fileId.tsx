import type { ClientLoaderFunctionArgs, MetaFunction } from "@remix-run/react";
import { useLoaderData, useNavigate, useRouteError } from "@remix-run/react";
import { isExtractableMediaType } from "@tulipfarm/files/limits";
import { type ReactNode, useRef, useState } from "react";
import { DownloadButton } from "~/components/files/file-list";
import { FilePreviewPanel } from "~/components/files/file-preview";
import { ShareDialog } from "~/components/files/file-share";
import {
  BookOpen,
  FileClock,
  FileX2,
  Paperclip,
  RotateCcw,
  Share2,
  Trash2,
  Upload,
} from "~/components/icons";
import { PageShell } from "~/components/page-shell";
import { ErrorState } from "~/components/states";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { ConfirmModal } from "~/components/ui/modal";
import { Panel } from "~/components/ui/panel";
import { ApiError, getSession } from "~/lib/api";
import {
  addFileToKnowledge,
  archiveFile,
  deleteFile,
  type FileVersion,
  fetchFile,
  fetchFileVersionObjectUrl,
  fetchFileVersions,
  formatFileSize,
  type LibraryFile,
  removeFileFromKnowledge,
  replaceFile,
  restoreArchivedFile,
  restoreFileVersion,
} from "~/lib/files";

export const meta: MetaFunction = () => [{ title: "File · Files · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const fileId = params.fileId;
  if (!fileId) throw new Response("File not found", { status: 404 });
  const [file, viewer] = await Promise.all([fetchFile(fileId), getSession()]);
  const versions = (file.canManage ?? false) ? await fetchFileVersions(fileId) : [];
  return { file, versions, viewerId: viewer.id };
}

export default function FileDetailRoute() {
  const loaded = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [file, setFile] = useState<LibraryFile>(loaded.file);
  const [versions, setVersions] = useState<readonly FileVersion[]>(loaded.versions);
  const [sharing, setSharing] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replacementRef = useRef<HTMLInputElement | null>(null);

  const owned = file.canManage ?? false;
  const archived = file.archivedAt != null;
  const indexable = isExtractableMediaType(file.mediaType);

  async function refreshVersions() {
    if (!owned) return;
    setVersions(await fetchFileVersions(file.id));
  }

  async function toggleKnowledge() {
    setBusy(true);
    setError(null);
    const adding = !file.inKnowledge;
    setFile((current) => ({ ...current, inKnowledge: adding }));
    try {
      if (adding) await addFileToKnowledge(file.id);
      else await removeFileFromKnowledge(file.id);
    } catch (err) {
      setFile((current) => ({ ...current, inKnowledge: !adding }));
      setError(err instanceof Error ? err.message : "Knowledge could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  async function replaceContent(replacement: File) {
    setBusy(true);
    setError(null);
    try {
      const changed = await replaceFile(file.id, file.revision ?? 1, replacement);
      setFile((current) => ({
        ...changed,
        sharedWithCount: current.sharedWithCount,
        inKnowledge: current.inKnowledge,
      }));
      await refreshVersions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be replaced.");
    } finally {
      setBusy(false);
    }
  }

  async function restoreVersion(version: FileVersion) {
    setBusy(true);
    setError(null);
    try {
      const changed = await restoreFileVersion(file.id, version.id, file.revision ?? 1);
      setFile((current) => ({
        ...changed,
        sharedWithCount: current.sharedWithCount,
        inKnowledge: current.inKnowledge,
      }));
      await refreshVersions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That version could not be restored.");
    } finally {
      setBusy(false);
    }
  }

  async function changeArchiveState() {
    setBusy(true);
    setError(null);
    try {
      const changed = archived
        ? await restoreArchivedFile(file.id, file.revision ?? 1)
        : await archiveFile(file.id, file.revision ?? 1);
      setFile((current) => ({
        ...changed,
        sharedWithCount: current.sharedWithCount,
        inKnowledge: archived ? current.inKnowledge : false,
      }));
      setConfirmingArchive(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The archive state could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    setBusy(true);
    setError(null);
    try {
      await deleteFile(file.id, file.revision ?? 1);
      navigate("/files", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be deleted.");
      setBusy(false);
    }
  }

  return (
    <PageShell
      title={file.filename}
      crumbs={[{ label: "Files", to: "/files" }, { label: file.filename }]}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <span>{file.mediaType}</span>
          {archived ? <Badge variant="neutral">In trash</Badge> : null}
          {file.inKnowledge ? <Badge variant="info">In Knowledge</Badge> : null}
        </span>
      }
      actions={
        <>
          <DownloadButton file={file} label />
          {!archived ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => navigate(`/?attach=${encodeURIComponent(file.id)}`)}
            >
              <Paperclip aria-hidden />
              Attach
            </Button>
          ) : null}
          {owned && !archived ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setSharing(true)}>
              <Share2 aria-hidden />
              Share
            </Button>
          ) : null}
        </>
      }
    >
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Panel title="Preview" flush>
          <FilePreviewPanel file={file} className="min-h-80 bg-muted/20 p-4" />
        </Panel>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="File details">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <Metadata label="Owner" value={owned ? "You" : file.owner} />
              <Metadata
                label="Access"
                value={
                  owned
                    ? file.sharedWithCount
                      ? `Shared with ${file.sharedWithCount}`
                      : "Private"
                    : "Shared with you"
                }
              />
              <Metadata label="Size" value={formatFileSize(file.sizeBytes)} />
              <Metadata
                label="Modified"
                value={formatDateTime(file.modifiedAt ?? file.createdAt)}
              />
              <Metadata label="Created" value={formatDateTime(file.createdAt)} />
              <Metadata
                label="Source"
                value={file.origin === "generated" ? "Agent-generated" : "Uploaded"}
              />
              <Metadata
                label="File ID"
                value={<span className="break-all font-mono text-xs">{file.id}</span>}
              />
            </dl>
            {file.sourceChatId || file.sourceRunId ? (
              <div className="mt-4 flex flex-wrap gap-3 border-t border-border pt-3 text-sm">
                {file.sourceChatId ? (
                  <Link to={`/chat/${encodeURIComponent(file.sourceChatId)}`}>
                    Open source Chat
                  </Link>
                ) : null}
                {file.sourceRunId ? (
                  <Link to={`/runs/${encodeURIComponent(file.sourceRunId)}`}>Open source Run</Link>
                ) : null}
              </div>
            ) : null}
          </Panel>

          {owned ? (
            <Panel title="Manage file">
              <div className="flex flex-wrap gap-2">
                {!archived ? (
                  <>
                    <input
                      ref={replacementRef}
                      type="file"
                      accept={file.mediaType}
                      aria-label={`Choose replacement for ${file.filename}`}
                      className="sr-only"
                      onChange={(event) => {
                        const replacement = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (replacement) void replaceContent(replacement);
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => replacementRef.current?.click()}
                    >
                      <Upload aria-hidden />
                      Replace content
                    </Button>
                    {indexable ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void toggleKnowledge()}
                      >
                        <BookOpen aria-hidden />
                        {file.inKnowledge ? "Remove from Knowledge" : "Add to Knowledge"}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirmingArchive(true)}
                    >
                      <FileX2 aria-hidden />
                      Move to trash
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void changeArchiveState()}
                    >
                      <RotateCcw aria-hidden />
                      Restore
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setConfirmingDelete(true)}
                    >
                      <Trash2 aria-hidden />
                      Delete permanently
                    </Button>
                  </>
                )}
              </div>
              {!archived ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Replacement keeps the same format and creates a new immutable version.
                </p>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  Files in the trash are read-only until you restore them.
                </p>
              )}
            </Panel>
          ) : null}
        </div>
      </div>

      {owned ? (
        <Panel
          title="Version history"
          description="Every replacement and restore remains available."
          flush
        >
          {versions.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No versions were found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-sm">
                <thead>
                  <tr>
                    {["Version", "Change", "Created", "By", "Size", ""].map((label) => (
                      <th
                        key={label || "actions"}
                        scope="col"
                        className="border-b border-border bg-muted/70 px-3 py-1.5 text-start text-xs font-medium text-muted-foreground"
                      >
                        {label || <span className="sr-only">Actions</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="[&>tr:last-child>td]:border-b-0 [&>tr>td]:border-b [&>tr>td]:border-border">
                  {versions.map((version) => {
                    const current = version.id === file.currentVersionId;
                    return (
                      <tr key={version.id}>
                        <td className="px-3 py-2 font-medium">
                          v{version.versionNumber}{" "}
                          {current ? <Badge variant="neutral">Current</Badge> : null}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{versionLabel(version)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                          {formatDateTime(version.createdAt)}
                        </td>
                        <td className="max-w-40 truncate px-3 py-2 text-xs text-muted-foreground">
                          {version.actorId}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">
                          {formatFileSize(version.sizeBytes)}
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="flex justify-end gap-1">
                            <DownloadButton
                              file={file}
                              fetchUrl={() => fetchFileVersionObjectUrl(file.id, version.id)}
                            />
                            {!current && !archived ? (
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                disabled={busy}
                                aria-label={`Restore version ${version.versionNumber}`}
                                onClick={() => void restoreVersion(version)}
                              >
                                <FileClock aria-hidden />
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}

      <ShareDialog file={sharing ? file : null} onClose={() => setSharing(false)} />
      <ConfirmModal
        open={confirmingArchive}
        onClose={() => setConfirmingArchive(false)}
        onConfirm={() => void changeArchiveState()}
        title={`Move ${file.filename} to the trash?`}
        description="It leaves active lists and new Chat attachments. Existing readers can still open it. You can restore it later."
        confirmLabel="Move to trash"
        busy={busy}
      />
      <ConfirmModal
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={() => void destroy()}
        title={`Delete ${file.filename} permanently?`}
        description="The file and every version are erased for good. This cannot be undone."
        confirmLabel="Delete permanently"
        busy={busy}
      />
    </PageShell>
  );
}

function Metadata({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{value}</dd>
    </>
  );
}

function versionLabel(version: FileVersion): string {
  if (version.reason === "created") return "Created";
  if (version.reason === "replaced") return "Replaced";
  return version.restoredFromVersionId ? "Restored from an older version" : "Restored";
}

function formatDateTime(iso: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? "—" : value.toLocaleString();
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status =
    error instanceof ApiError ? error.status : error instanceof Response ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="file" status={status} message={message} />;
}
