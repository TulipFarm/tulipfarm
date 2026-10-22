import type { GoogleProposal } from '@/lib/google-workspace';
import { googleWebLink } from '@/features/files/google-api';
import { googleDocument } from '@/lib/file-viewer';

export type GoogleMutation =
  | { kind: 'idle' }
  | { kind: 'pending'; action: 'approve' | 'reject' | 'execute' }
  | { kind: 'uncertain'; action: 'approve' | 'reject' | 'execute' }
  | { kind: 'refused'; action: 'approve' | 'execute' };
type Operation = GoogleProposal['operation'];

export function isGoogleFileSave(operation: Operation) {
  return (
    /^drive\.files\.(create|upload|update|copy)$/.test(operation.kind) ||
    /^(docs\.documents|slides\.presentations|sheets\.spreadsheets)\.create$/.test(operation.kind)
  );
}

export function googleExecutionLabel(operation: Operation, pending = false) {
  if (isGoogleFileSave(operation)) return pending ? 'Saving approved action…' : 'Save approved action to Google';
  return pending
    ? operation.kind === 'gmail.messages.send' || operation.kind === 'gmail.drafts.send'
      ? 'Sending approved email…'
      : 'Running approved action…'
    : 'Run approved Google action';
}

export function googleDestination(operation: Operation | Pick<Operation, 'kind'>) {
  const mime =
    'file' in operation && operation.file && 'mimeType' in operation.file ? operation.file.mimeType : undefined;
  if (mime === 'application/vnd.google-apps.presentation' || operation.kind.startsWith('slides.'))
    return 'Google Slides';
  if (mime === 'application/vnd.google-apps.document' || operation.kind.startsWith('docs.')) return 'Google Docs';
  if (mime === 'application/vnd.google-apps.spreadsheet' || operation.kind.startsWith('sheets.'))
    return 'Google Sheets';
  if (operation.kind.startsWith('gmail.')) return 'Gmail';
  if (operation.kind.startsWith('calendar.')) return 'Google Calendar';
  return 'Google Drive';
}

export function googleActionTitle(operation: Operation | Pick<Operation, 'kind'>) {
  if ('file' in operation && operation.file?.name) return operation.file.name;
  if ('title' in operation) return operation.title;
  if ('message' in operation) return operation.message.subject || 'Email without a subject';
  if ('calendar' in operation) return operation.calendar.summary ?? 'Google calendar';
  if ('label' in operation) return operation.label.name;
  const verbs: Record<string, string> = {
    create: 'Create',
    upload: 'Upload',
    update: 'Update',
    copy: 'Copy',
    trash: 'Move to trash',
    delete: 'Delete',
    send: 'Send',
    untrash: 'Restore',
    modify: 'Change',
    append: 'Append',
    clear: 'Clear',
    batchClear: 'Clear',
    batchUpdate: 'Update',
  };
  const [service, object, action] = operation.kind.split('.');
  const objects: Record<string, string> = {
    files: 'file',
    permissions: 'file access',
    documents: 'document',
    presentations: 'presentation',
    spreadsheets: 'spreadsheet',
    values: 'cells',
    messages: 'email',
    drafts: 'draft',
    labels: 'label',
    calendars: 'calendar',
    events: 'event',
  };
  return `${verbs[action ?? ''] ?? 'Review'} ${objects[object ?? ''] ?? service ?? 'Google action'}`;
}

export function googleActionState(proposal: GoogleProposal, mutation: GoogleMutation = { kind: 'idle' }) {
  const fileSave = isGoogleFileSave(proposal.operation);
  const running = fileSave
    ? 'Saving'
    : proposal.operation.kind === 'gmail.messages.send' || proposal.operation.kind === 'gmail.drafts.send'
      ? 'Sending'
      : 'Running';
  const unknown = fileSave ? 'Save not confirmed' : 'Outcome unknown';
  if (mutation.kind === 'uncertain') return { kind: 'unknown', label: unknown, tone: 'destructive' } as const;
  if (mutation.kind === 'pending')
    return {
      kind: 'pending',
      label:
        mutation.action === 'execute' ? `${running}…` : mutation.action === 'approve' ? 'Approving…' : 'Rejecting…',
      tone: 'warning',
    } as const;
  if (mutation.kind === 'refused') return { kind: 'failed', label: 'Action blocked', tone: 'destructive' } as const;
  if (proposal.receipt) {
    switch (proposal.receipt.status) {
      case 'succeeded':
        return {
          kind: 'succeeded',
          label:
            proposal.operation.kind === 'drive.files.trash'
              ? 'Moved to trash in Google Drive'
              : proposal.operation.kind.startsWith('drive.permissions.')
                ? 'Access updated in Google Drive'
                : proposal.operation.kind === 'gmail.messages.send' || proposal.operation.kind === 'gmail.drafts.send'
                  ? 'Sent in Gmail'
                  : proposal.operation.kind.startsWith('drive.files.') ||
                      /^(slides|docs|sheets)\./.test(proposal.operation.kind)
                    ? `Saved in ${googleDestination(proposal.operation)}`
                    : 'Completed in Google',
          tone: 'success',
        } as const;
      case 'failed':
        return { kind: 'failed', label: 'Failed', tone: 'destructive' } as const;
      case 'executing':
        return { kind: 'saving', label: running, tone: 'warning' } as const;
      case 'outcome-unknown':
        return { kind: 'unknown', label: unknown, tone: 'destructive' } as const;
    }
  }
  if (proposal.decision === 'reject') return { kind: 'rejected', label: 'Rejected', tone: 'secondary' } as const;
  if (Date.parse(proposal.expiresAt) <= Date.now())
    return { kind: 'expired', label: 'Expired', tone: 'secondary' } as const;
  return proposal.decision === 'approve'
    ? ({
        kind: 'approved',
        label: fileSave ? 'Approved · Not saved yet' : 'Approved · Not yet run',
        tone: 'info',
      } as const)
    : ({ kind: 'review', label: 'Waiting for review', tone: 'warning' } as const);
}

export function googleReceiptFile(
  proposal: GoogleProposal,
): { title: string; url: string | null; destination: string } | null {
  if (
    proposal.receipt?.status !== 'succeeded' ||
    !/^(drive\.files\.(create|upload|update|copy)|docs\.documents\.|slides\.presentations\.|sheets\.)/.test(
      proposal.operation.kind,
    )
  )
    return null;
  const data = proposal.receipt.result.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const expectedId =
    'fileId' in proposal.operation
      ? proposal.operation.fileId
      : 'documentId' in proposal.operation
        ? proposal.operation.documentId
        : 'presentationId' in proposal.operation
          ? proposal.operation.presentationId
          : 'spreadsheetId' in proposal.operation
            ? proposal.operation.spreadsheetId
            : undefined;
  const returnedId = data.id ?? data.documentId ?? data.presentationId ?? data.spreadsheetId;
  if (
    typeof returnedId !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(returnedId) ||
    (expectedId && proposal.operation.kind !== 'drive.files.copy' && expectedId !== returnedId)
  )
    return null;
  const destination = googleDestination(proposal.operation);
  const supplied = googleWebLink(
    typeof data.webViewLink === 'string'
      ? data.webViewLink
      : typeof data.spreadsheetUrl === 'string'
        ? data.spreadsheetUrl
        : undefined,
  );
  const parsed = supplied ? new URL(supplied) : null;
  const document = supplied ? googleDocument(supplied) : null;
  const safe =
    document && new URL(document.url).pathname.split('/')[3] === returnedId
      ? document.url
      : parsed?.hostname === 'drive.google.com' &&
          (parsed.pathname === `/file/d/${returnedId}/view` || parsed.pathname === `/drive/folders/${returnedId}`)
        ? supplied
        : null;
  const family =
    destination === 'Google Slides'
      ? 'presentation'
      : destination === 'Google Docs'
        ? 'document'
        : destination === 'Google Sheets'
          ? 'spreadsheets'
          : null;
  return {
    title:
      typeof data.name === 'string'
        ? data.name
        : typeof data.title === 'string'
          ? data.title
          : googleActionTitle(proposal.operation),
    destination,
    url:
      safe ??
      (family
        ? `https://docs.google.com/${family}/d/${returnedId}/edit`
        : `https://drive.google.com/file/d/${returnedId}/view`),
  };
}
