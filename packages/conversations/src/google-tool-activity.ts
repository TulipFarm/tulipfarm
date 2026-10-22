import { z } from 'zod';
import { googleOperationSchema, type GoogleOperation } from '@tulipfarm/google-workspace/operation-contracts';

const labels = {
  'gmail.messages.list': 'Searching Gmail messages',
  'gmail.messages.get': 'Reading a Gmail message',
  'gmail.messages.modify': 'Change Gmail message labels',
  'gmail.messages.trash': 'Move a Gmail message to trash',
  'gmail.messages.untrash': 'Restore a Gmail message',
  'gmail.messages.send': 'Send a Gmail message',
  'gmail.drafts.list': 'Finding Gmail drafts',
  'gmail.drafts.get': 'Reading a Gmail draft',
  'gmail.drafts.create': 'Create a Gmail draft',
  'gmail.drafts.update': 'Update a Gmail draft',
  'gmail.drafts.delete': 'Delete a Gmail draft',
  'gmail.drafts.send': 'Send a Gmail draft',
  'gmail.labels.list': 'Listing Gmail labels',
  'gmail.labels.get': 'Reading a Gmail label',
  'gmail.labels.create': 'Create a Gmail label',
  'gmail.labels.update': 'Update a Gmail label',
  'gmail.labels.delete': 'Delete a Gmail label',
  'calendar.calendars.list': 'Listing Google calendars',
  'calendar.calendars.get': 'Reading Google calendar details',
  'calendar.calendars.create': 'Create a Google calendar',
  'calendar.calendars.update': 'Update a Google calendar',
  'calendar.calendars.delete': 'Delete a Google calendar',
  'calendar.events.list': 'Finding Google Calendar events',
  'calendar.events.get': 'Reading a Google Calendar event',
  'calendar.events.create': 'Create a Google Calendar event',
  'calendar.events.update': 'Update a Google Calendar event',
  'calendar.events.delete': 'Delete a Google Calendar event',
  'drive.files.list': 'Searching Google Drive files',
  'drive.files.get': 'Reading Google Drive file details',
  'drive.files.create': 'Create a Google Drive file',
  'drive.files.update': 'Update a Google Drive file',
  'drive.files.copy': 'Copy a Google Drive file',
  'drive.files.trash': 'Move a Google Drive file to trash',
  'drive.files.upload': 'Upload a Google Drive file',
  'drive.files.download': 'Downloading a Google Drive file',
  'drive.files.export': 'Exporting a Google Drive file',
  'drive.permissions.list': 'Listing Google Drive sharing permissions',
  'drive.permissions.get': 'Reading a Google Drive sharing permission',
  'drive.permissions.create': 'Share a Google Drive file',
  'drive.permissions.update': 'Update a Google Drive sharing permission',
  'drive.permissions.delete': 'Remove a Google Drive sharing permission',
  'sheets.spreadsheets.get': 'Reading Google Sheets spreadsheet details',
  'sheets.spreadsheets.create': 'Create a Google Sheets spreadsheet',
  'sheets.values.get': 'Reading Google Sheets cells',
  'sheets.values.update': 'Update Google Sheets cells',
  'sheets.values.append': 'Append Google Sheets rows',
  'sheets.values.clear': 'Clear Google Sheets cells',
  'sheets.values.batchGet': 'Reading Google Sheets ranges',
  'sheets.values.batchUpdate': 'Update Google Sheets ranges',
  'sheets.values.batchClear': 'Clear Google Sheets ranges',
  'sheets.spreadsheets.batchUpdate': 'Update Google Sheets structure and formatting',
  'docs.documents.create': 'Create a Google Docs document',
  'docs.documents.get': 'Reading a Google Docs document',
  'docs.documents.batchUpdate': 'Update a Google Docs document',
  'slides.presentations.create': 'Create a Google Slides presentation',
  'slides.presentations.get': 'Reading a Google Slides presentation',
  'slides.presentations.pages.get': 'Reading a Google Slides slide',
  'slides.presentations.batchUpdate': 'Update a Google Slides presentation',
} satisfies Record<GoogleOperation['kind'], string>;

const documentLabels = {
  docx: 'Create a Google Doc',
  xlsx: 'Create a Google Sheet',
  pptx: 'Create a Google Slides presentation',
};
const callSchema = z.object({ tool: z.enum(['google.read', 'google.propose']), operation: googleOperationSchema });
const readCallSchema = z.object({ tool: z.literal('google.read'), operation: z.object({ kind: z.string() }) });
const readLabels = {
  gmail: 'Reading your Gmail data',
  calendar: 'Reading your Google Calendar data',
  drive: 'Reading your Google Drive data',
  sheets: 'Reading your Google Sheets data',
  docs: 'Reading your Google Docs data',
  slides: 'Reading your Google Slides data',
};

export function googleToolActivity(tool: string, call: unknown, storedActivity?: string | null): string | null {
  if (tool === 'google.read') {
    const read = readCallSchema.safeParse(call);
    if (read.success)
      return (
        Object.entries(readLabels).find(([service]) => read.data.operation.kind.startsWith(`${service}.`))?.[1] ??
        'Reading your Google data'
      );
    const stored = Object.entries(readLabels).find(
      ([service, label]) =>
        label === storedActivity ||
        Object.entries(labels).some(
          ([kind, previous]) => kind.startsWith(`${service}.`) && previous === storedActivity,
        ),
    );
    return stored?.[1] ?? 'Reading your Google data';
  }
  const document = z
    .object({ tool: z.literal('google.propose'), document: z.object({ format: z.enum(['docx', 'xlsx', 'pptx']) }) })
    .safeParse(call);
  if (tool === 'google.propose' && document.success)
    return `Preparing: ${documentLabels[document.data.document.format]}`;
  const parsed = callSchema.safeParse(call);
  if (!parsed.success || parsed.data.tool !== tool) {
    if (!['google.read', 'google.propose', 'google.execute', 'google.status'].includes(tool)) return null;
    const prefix =
      tool === 'google.propose'
        ? 'Preparing: '
        : tool === 'google.execute'
          ? 'Executing approved action: '
          : tool === 'google.status'
            ? 'Checking approval and outcome: '
            : '';
    return (
      [...Object.values(labels), ...Object.values(documentLabels)]
        .map(label => `${prefix}${label}`)
        .find(label => label === storedActivity) ?? null
    );
  }
  const label = labels[parsed.data.operation.kind];
  return tool === 'google.propose' ? `Preparing: ${label}` : label;
}
