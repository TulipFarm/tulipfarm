import { useEffect, useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { FileContent, FileError, LoadingFile } from '@tulipfarm/sprout/file-viewer';
import { fileRenderers } from '@/features/files/viewer/renderers';
import { FileTypeIcon } from '@tulipfarm/sprout/attachment';
import { formatFileSize } from '@/lib/file-viewer';
import type { GoogleProposal } from '@/lib/google-workspace';
import { googleActionTitle, googleDestination } from './action-state';
import { SheetValues } from '@/components/worksheet-grid';

type Operation = GoogleProposal['operation'];
const extensions: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};
const uploadOf = (operation: Operation) => ('contentBase64' in operation ? operation.contentBase64 : null);
const byteLength = (base64: string) =>
  Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);

export function reviewableOperation(operation: Operation): Record<string, unknown> {
  const content = uploadOf(operation);
  return content === null
    ? operation
    : { ...operation, contentBase64: `${formatFileSize(byteLength(content))} file, available as an exact download` };
}

export function GoogleUploadPreview({
  operation,
  submitted = false,
}: {
  operation: Extract<Operation, { kind: 'drive.files.upload' }>;
  submitted?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ bytes: ArrayBuffer; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const extension = extensions[operation.mimeType] ?? '';
  const name = operation.file?.name ?? 'Google upload';
  const filename = extension && !name.toLowerCase().endsWith(extension) ? `${name}${extension}` : name;
  useEffect(() => {
    let url: string | undefined;
    setFailed(false);
    setLoaded(null);
    try {
      const bytes = Uint8Array.from(atob(operation.contentBase64), character => character.charCodeAt(0)).buffer;
      url = URL.createObjectURL(new Blob([bytes], { type: operation.mimeType }));
      setLoaded({ bytes, url });
    } catch {
      setFailed(true);
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [operation.contentBase64, operation.mimeType, attempt]);
  const retry = () => setAttempt(value => value + 1);
  return (
    <section aria-label="Exact proposed file" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {submitted ? 'Exact submitted draft · Not the current Google file' : 'Exact proposed file'} ·{' '}
          {formatFileSize(byteLength(operation.contentBase64))}
        </p>
        {loaded && (
          <Button variant="outline" size="sm" nativeButton={false} render={<a href={loaded.url} download={filename} />}>
            Download exact file
          </Button>
        )}
      </div>
      <div
        className={`flex flex-col overflow-hidden rounded-xl border bg-muted/40 ${operation.contentBase64 ? 'h-96 max-h-svh min-h-64' : ''}`}
      >
        {failed ? (
          <FileError
            message="The proposed file could not be decoded. Check the action before approving."
            onRetry={retry}
          />
        ) : loaded ? (
          <FileContent
            key={attempt}
            name={filename}
            mediaType={operation.mimeType}
            bytes={loaded.bytes}
            url={loaded.url}
            onRetry={retry}
            renderers={fileRenderers}
          />
        ) : (
          <LoadingFile />
        )}
      </div>
    </section>
  );
}

function Consequences({ operation }: { operation: Operation }) {
  if ('message' in operation)
    return (
      <div className="space-y-3">
        <dl className="space-y-2 text-sm">
          {(['to', 'cc', 'bcc'] as const).map(field =>
            operation.message[field]?.length ? (
              <div key={field}>
                <dt className="font-medium">{field === 'to' ? 'To' : field.toUpperCase()}</dt>
                <dd className="break-words">{operation.message[field]?.join(', ')}</dd>
              </div>
            ) : null,
          )}
        </dl>
        <p className="whitespace-pre-wrap break-words">{operation.message.body}</p>
        {operation.message.contentType === 'text/html' && (
          <p className="text-sm text-muted-foreground">HTML source shown as text.</p>
        )}
      </div>
    );
  if (operation.kind === 'drive.permissions.create')
    return (
      <div className="space-y-2">
        <p className="break-words">
          {operation.permission.type === 'anyone'
            ? 'Anyone with the link'
            : operation.permission.type === 'domain'
              ? operation.permission.domain
              : operation.permission.emailAddress}{' '}
          · {operation.permission.role}
        </p>
        <p className="text-sm text-muted-foreground">
          {operation.sendNotificationEmail === false ? 'No notification email' : 'Google may send a notification email'}
        </p>
        {'allowFileDiscovery' in operation.permission && operation.permission.allowFileDiscovery && (
          <p className="text-sm">This file can be discovered by the permitted audience.</p>
        )}
      </div>
    );
  if (operation.kind === 'drive.permissions.update')
    return <p>Change the selected permission to {operation.role}. Check the exact person or audience in Details.</p>;
  if (operation.kind === 'drive.permissions.delete')
    return <p>Remove the selected permission. Check the exact person or audience in Details.</p>;
  if (operation.kind === 'drive.files.trash')
    return <p>Move the selected file to Google Drive trash. Check the exact target in Details.</p>;
  if ('file' in operation)
    return (
      <div className="space-y-2 text-sm">
        {operation.file?.description !== undefined && (
          <p className="whitespace-pre-wrap break-words">
            {operation.file.description || 'Clear the file description'}
          </p>
        )}
        <p>
          {operation.kind === 'drive.files.upload'
            ? operation.fileId
              ? 'Replace the selected file’s content.'
              : 'Upload this file to Google.'
            : operation.kind === 'drive.files.copy'
              ? 'Create a separate copy. The source stays unchanged.'
              : operation.kind === 'drive.files.update'
                ? 'Update the selected file’s details.'
                : 'Create a new file in Google. No file content is attached to this proposal.'}
        </p>
        {operation.file && 'parents' in operation.file && operation.file.parents?.length ? (
          <p>Destination: selected Google Drive folder. Check the exact folder in Details.</p>
        ) : null}
        {operation.kind === 'drive.files.update' &&
        (operation.addParents?.length || operation.removeParents?.length) ? (
          <p>Change the file’s folder. Check the source and destination in Details.</p>
        ) : null}
        {'fileId' in operation && operation.fileId && (
          <p className="text-muted-foreground">Check the exact target in Details before approving.</p>
        )}
      </div>
    );
  if ('values' in operation)
    return (
      <div className="space-y-3">
        <p className="text-sm">
          {operation.range} · {operation.values.length} rows ·{' '}
          {operation.valueInputOption === 'USER_ENTERED'
            ? 'Interpret formulas and values as typed in Google Sheets'
            : 'Store literal values'}
        </p>
        <SheetValues values={operation.values} />
      </div>
    );
  if (operation.kind === 'sheets.values.batchUpdate')
    return (
      <div className="space-y-3">
        <p className="text-sm">
          {operation.data.length} cell ranges ·{' '}
          {operation.valueInputOption === 'USER_ENTERED'
            ? 'Interpret formulas and values as typed in Google Sheets'
            : 'Store literal values'}
        </p>
        {operation.data.map((entry, index) => (
          <section key={index} className="space-y-2">
            <h4 className="text-sm font-medium">{entry.range}</h4>
            <SheetValues values={entry.values} />
          </section>
        ))}
      </div>
    );
  if (operation.kind === 'sheets.values.clear' || operation.kind === 'sheets.values.batchClear')
    return (
      <div className="space-y-2">
        <p className="text-sm">Clear all values in these ranges. Check the exact spreadsheet in Details.</p>
        <ul className="space-y-1 text-sm">
          {('ranges' in operation ? operation.ranges : [operation.range]).map(range => (
            <li key={range}>{range}</li>
          ))}
        </ul>
      </div>
    );
  if ('requests' in operation)
    return (
      <div className="space-y-3">
        <p className="text-sm">
          {operation.requests.length} changes. Review every target and change in Details before approving.
        </p>
        <ol className="list-decimal space-y-3 pl-5">
          {operation.requests.map((request, index) => (
            <li key={index} className="text-sm">
              {Object.keys(request)[0]
                ?.replace(/([a-z])([A-Z])/g, '$1 $2')
                .replace(/^./, value => value.toUpperCase())}
              {'insertText' in request && <p className="whitespace-pre-wrap break-words">{request.insertText.text}</p>}
              {'replaceAllText' in request && (
                <p className="whitespace-pre-wrap break-words">
                  Replace “{request.replaceAllText.containsText.text}” with “{request.replaceAllText.replaceText}”
                </p>
              )}
            </li>
          ))}
        </ol>
      </div>
    );
  return (
    <p className="text-sm text-muted-foreground">
      Review all targets, content, and changes in Details before approving this action.
    </p>
  );
}

export function OperationSummary({ operation }: { operation: Operation }) {
  const title = googleActionTitle(operation);
  return (
    <section aria-label="Proposed action summary" className="min-w-0 space-y-4">
      <header className="flex items-center gap-3">
        {operation.kind.startsWith('drive.files.') && (
          <FileTypeIcon
            name={title}
            mediaType={
              'mimeType' in operation
                ? operation.mimeType
                : 'file' in operation && operation.file && 'mimeType' in operation.file
                  ? (operation.file.mimeType ?? '')
                  : ''
            }
          />
        )}
        <div className="min-w-0">
          <h3 className="break-words text-xl font-medium">{title}</h3>
          <p className="text-sm text-muted-foreground">Destination: {googleDestination(operation)}</p>
        </div>
      </header>
      {operation.kind === 'drive.files.upload' && <GoogleUploadPreview operation={operation} />}
      <Consequences operation={operation} />
    </section>
  );
}
