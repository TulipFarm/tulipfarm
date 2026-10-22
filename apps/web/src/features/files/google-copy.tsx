import { useRef, useState, type RefObject } from 'react';
import { Link } from '@tanstack/react-router';
import { Check } from 'reicon-react/icons/Check';
import { googleExportFormats, type GoogleExportFormat } from '@tulipfarm/google-workspace/public-contracts';
import { workspaceRoute } from '@/router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { GoogleRequestError } from '@/lib/google-workspace';
import { formatFileSize } from '@/lib/file-viewer';
import { useFilesApi, useFilesChanges, type FileSummary } from './api';
import { FolderBrowser, useFolderPlace, type FolderPlace } from './folder-browser';
import { googleFileByteLimit, type GoogleFileMetadata, type GoogleFilesApi } from './google-api';

export type CopyFormat = 'original' | GoogleExportFormat;
/** A failure is `uncertain` when the copy may exist; the dialog then locks the request and retries it under the same command id. */
type Status =
  | { kind: 'editing' }
  | { kind: 'copying' }
  | { kind: 'copied'; file: FileSummary; destination: string }
  | { kind: 'failed'; message: string; uncertain: boolean };

const formatLabels: Record<GoogleExportFormat, string> = {
  docx: 'Word document (.docx)',
  xlsx: 'Excel workbook (.xlsx)',
  pptx: 'PowerPoint presentation (.pptx)',
  pdf: 'PDF (.pdf)',
  csv: 'CSV, first sheet only (.csv)',
};

const formatName = (format: CopyFormat) => (format === 'original' ? 'Original file' : formatLabels[format]);

/** Formats Google can produce for this file, editable Office formats first. Ordinary Drive files copy as they are. */
export function copyFormats(file: Pick<GoogleFileMetadata, 'mimeType'>): CopyFormat[] {
  if (!file.mimeType.startsWith('application/vnd.google-apps.')) return ['original'];
  return (['docx', 'xlsx', 'pptx', 'pdf', 'csv'] as const).filter(format =>
    (googleExportFormats[format].sources as readonly string[]).includes(file.mimeType),
  );
}
export const canCopy = (file: Pick<GoogleFileMetadata, 'mimeType'>) => copyFormats(file).length > 0;

function copyName(name: string, format: CopyFormat) {
  if (format === 'original') return name;
  const extension = `.${googleExportFormats[format].extension}`;
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

const messages: Record<string, string> = {
  'file-not-found': 'You can’t add files to this folder anymore. Choose another folder.',
  'file-quota': 'Workspace storage is full. Files in Trash still use storage.',
  'file-size': 'This file is empty or larger than the 10 MB limit.',
  'file-busy': 'Several transfers are already running. Try again in a moment.',
  'source-not-found': 'Google can’t find this file. It may have been deleted, moved to trash, or unshared.',
  'source-access-denied': 'Google denied access, or the owner turned off downloading for this file.',
  'export-rejected': 'Google couldn’t export this file in that format. Choose another format, or open it in Google.',
  'unsupported-representation': 'Google can’t provide this format for this file. Choose another format.',
  'response-too-large': 'This file is larger than the 10 MB limit.',
  'integration-required': 'Your Google integration changed. Reconnect Google Drive, then try again.',
  'reconnect-required': 'Your Google integration changed. Reconnect Google Drive, then try again.',
  'stale-integration': 'Your Google integration changed. Reconnect Google Drive, then try again.',
  'insufficient-scope': 'Google Drive access is missing. Grant Drive access, then try again.',
  'rate-limited': 'Google is limiting requests right now. Try again in a moment.',
  'provider-unavailable': 'Google didn’t finish sending the file. Nothing was saved. Try again.',
  'transfer-busy': 'Several Google transfers are already running. Try again in a moment.',
};

function failure(error: unknown): { message: string; uncertain: boolean; conflict: boolean } {
  if (error instanceof GoogleRequestError) {
    if (error.code === 'file-conflict')
      return {
        message: 'An earlier attempt saved a different copy under this request. Check My files, then save again.',
        uncertain: false,
        conflict: true,
      };
    if (error.status === 401)
      return { message: 'Your session expired. Sign in again, then retry the copy.', uncertain: true, conflict: false };
    const known = messages[error.code];
    if (known && error.status < 500) return { message: known, uncertain: false, conflict: false };
  }
  return {
    message: 'We couldn’t confirm the copy. Retrying checks for it first and won’t create a second copy.',
    uncertain: true,
    conflict: false,
  };
}

export function SaveCopyDialog({
  workspaceId,
  api,
  file,
  finalFocus,
  onClose,
}: {
  workspaceId: string;
  api: GoogleFilesApi;
  file: GoogleFileMetadata;
  finalFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const { changed } = useFilesChanges();
  const formats = copyFormats(file);
  const [format, setFormat] = useState<CopyFormat>(formats[0] ?? 'original');
  const [name, setName] = useState(() => copyName(file.name, formats[0] ?? 'original'));
  const [place, setPlace] = useState<FolderPlace>({ section: 'mine', folder: null });
  const location = useFolderPlace(useFilesApi(workspaceId), place);
  const { destination } = location;
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  const [status, setStatus] = useState<Status>({ kind: 'editing' });
  const sending = useRef(false);
  const tooLarge = format === 'original' && Number(file.size ?? 0) > googleFileByteLimit;
  const copying = status.kind === 'copying';
  const locked = copying || (status.kind === 'failed' && status.uncertain);
  const trimmed = name.trim();

  async function submit() {
    if (sending.current || !destination || !trimmed || tooLarge) return;
    sending.current = true;
    setStatus({ kind: 'copying' });
    try {
      const copied = await api.copy(commandId, {
        fileId: file.id,
        name: trimmed,
        parentId: destination.parentId,
        format,
      });
      setStatus({ kind: 'copied', file: copied, destination: destination.label });
      void changed();
    } catch (error) {
      const outcome = failure(error);
      if (outcome.conflict) setCommandId(crypto.randomUUID());
      setStatus({ kind: 'failed', message: outcome.message, uncertain: outcome.uncertain });
    } finally {
      sending.current = false;
    }
  }

  const close = () => {
    if (!copying) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) close();
      }}
    >
      <DialogContent size="form" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>
            <span className="wrap-anywhere">Save a copy of “{file.name}”</span>
          </DialogTitle>
          <DialogDescription>
            The copy is a separate TulipFarm file. It won’t change when the Google file changes, and the original stays
            in Google unchanged.
          </DialogDescription>
        </DialogHeader>
        {status.kind === 'copied' ? (
          <>
            <div className="-mx-4 min-h-0 overflow-y-auto px-4 pb-1">
              <StatePanel
                kind="success"
                heading="h3"
                title="Copy saved to TulipFarm"
                description={`“${status.file.name}” is in ${status.destination}${status.file.size === null ? '' : ` · ${formatFileSize(status.file.size)}`}.`}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Done
              </Button>
              <Button
                nativeButton={false}
                role="link"
                autoFocus
                render={<Link to="/$workspaceSlug/files/$fileId" params={{ workspaceSlug, fileId: status.file.id }} />}
              >
                Open copy
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="-mx-4 min-h-0 space-y-4 overflow-y-auto px-4 pb-1">
              <section aria-labelledby="copy-destination" className="space-y-3">
                <h3 id="copy-destination" className="text-sm font-medium text-foreground">
                  Save to
                </h3>
                <FolderBrowser
                  place={place}
                  setPlace={setPlace}
                  location={location}
                  disabled={locked}
                  unchanged="Nothing has been copied."
                />
                {destination ? (
                  <p className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
                    <Check size={14} aria-hidden="true" />
                    <span className="min-w-0 truncate">Saving to {destination.label}</span>
                  </p>
                ) : place.folder === null ? (
                  <p className="text-sm text-muted-foreground">Open a shared folder to save into it.</p>
                ) : location.current?.role === 'viewer' ? (
                  <p className="text-sm text-muted-foreground">You can view this folder but can’t add to it.</p>
                ) : null}
              </section>
              <form
                id="copy-form"
                className="space-y-4"
                onSubmit={event => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="copy-name">Name</Label>
                  <Input
                    id="copy-name"
                    value={name}
                    maxLength={255}
                    required
                    disabled={locked}
                    onChange={event => setName(event.target.value)}
                  />
                </div>
                {formats.length > 1 && (
                  <div className="space-y-2">
                    <Label htmlFor="copy-format">Format</Label>
                    <Select
                      value={format}
                      disabled={locked}
                      onValueChange={value => {
                        const next = formats.find(item => item === value) ?? format;
                        if (name === copyName(file.name, format)) setName(copyName(file.name, next));
                        setFormat(next);
                      }}
                    >
                      <SelectTrigger id="copy-format" width="full">
                        <SelectValue>{formatName(format)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {formats.map(item => (
                          <SelectItem key={item} value={item}>
                            {formatName(item)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </form>
              {tooLarge && (
                <Alert variant="destructive">
                  <AlertDescription>
                    This file is {formatFileSize(Number(file.size))}. Copies are limited to 10 MB.
                  </AlertDescription>
                </Alert>
              )}
              <div aria-live="polite">
                {copying && (
                  <p className="flex items-center gap-2 text-sm text-foreground">
                    <Spinner aria-hidden="true" />
                    Copying from Google Drive to {destination?.label ?? 'TulipFarm'}…
                  </p>
                )}
              </div>
              {status.kind === 'failed' && (
                <Alert variant="destructive">
                  <AlertDescription>{status.message}</AlertDescription>
                </Alert>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={copying} onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="copy-form"
                disabled={copying || !destination || !trimmed || tooLarge}
                aria-busy={copying}
              >
                {copying ? (
                  <>
                    <Spinner aria-hidden="true" />
                    Saving copy…
                  </>
                ) : status.kind === 'failed' && status.uncertain ? (
                  'Retry copy'
                ) : (
                  'Save copy'
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
