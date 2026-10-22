import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/);
const calendarId = z
  .string()
  .min(1)
  .max(320)
  .regex(/^[a-zA-Z0-9_@.-]+$/)
  .refine(value => value !== '.' && value !== '..');
const text = z.string().max(100_000);
const title = z.string().min(1).max(500);
const query = z.string().max(2000);
const pageToken = z.string().min(1).max(2048).optional();
const pageSize = z.number().int().min(1).max(100).optional();
const index = z.number().int().min(0).max(10_000_000);
const sheetId = z.number().int().min(0).max(2_147_483_647);
const singleLine = (value: string) =>
  Array.from(value).every(
    character =>
      character.charCodeAt(0) >= 32 &&
      character.charCodeAt(0) !== 127 &&
      character !== '\u2028' &&
      character !== '\u2029',
  );
const range = z
  .string()
  .min(1)
  .max(512)
  .refine(value => value !== '.' && value !== '..' && !/[\uD800-\uDFFF]/u.test(value) && singleLine(value));
const email = z
  .email()
  .max(254)
  .regex(/^[\x21-\x7e]+$/);
const mimeType = z
  .string()
  .max(127)
  .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/);
const base64 = z
  .string()
  .max(1_398_104)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine(value => {
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const lastSextet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(
      value.charAt(value.length - padding - 1),
    );
    return (
      (value.length * 3) / 4 - padding <= 1_048_576 && (padding === 0 || lastSextet % (padding === 2 ? 16 : 4) === 0)
    );
  });
const message = z.strictObject({
  to: z.array(email).min(1).max(50),
  cc: z.array(email).max(50).optional(),
  bcc: z.array(email).max(50).optional(),
  subject: z.string().max(500).refine(singleLine),
  body: text,
  contentType: z.enum(['text/plain', 'text/html']).optional(),
  threadId: id.optional(),
  inReplyTo: z
    .string()
    .max(254)
    .regex(/^<[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-zA-Z0-9.-]+>$/)
    .optional(),
});
const label = z.strictObject({
  name: title,
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional(),
  messageListVisibility: z.enum(['show', 'hide']).optional(),
});
const calendar = z.strictObject({
  summary: title,
  description: text.optional(),
  location: title.optional(),
  timeZone: z.string().min(1).max(100).optional(),
});
const eventTime = z.union([
  z.strictObject({ date: z.iso.date() }),
  z.strictObject({
    dateTime: z.iso.datetime({ offset: true }),
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine(value => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Use a valid IANA time zone')
      .optional(),
  }),
]);
const eventFields = z.strictObject({
  summary: title,
  description: text.optional(),
  location: title.optional(),
  start: eventTime,
  end: eventTime,
  attendees: z
    .array(z.strictObject({ email, displayName: title.optional() }))
    .max(100)
    .optional(),
  recurrence: z
    .array(
      z
        .string()
        .max(1000)
        .regex(/^(RRULE|RDATE|EXDATE):[^\r\n]+$/),
    )
    .max(20)
    .optional(),
  visibility: z.enum(['default', 'public', 'private', 'confidential']).optional(),
  conferenceData: z
    .strictObject({
      createRequest: z.strictObject({
        requestId: z
          .uuid()
          .optional()
          .describe('Stable conference request ID. TulipFarm binds this to the proposal command before approval.'),
        conferenceSolutionKey: z.strictObject({ type: z.literal('hangoutsMeet') }),
      }),
    })
    .optional(),
});
const validEventTimes = (value: {
  start?: z.infer<typeof eventTime> | undefined;
  end?: z.infer<typeof eventTime> | undefined;
}) => {
  if (!value.start || !value.end) return true;
  if ('date' in value.start && 'date' in value.end) return value.end.date > value.start.date;
  if ('dateTime' in value.start && 'dateTime' in value.end)
    return Date.parse(value.end.dateTime) > Date.parse(value.start.dateTime);
  return false;
};
const event = eventFields.refine(validEventTimes);
const sendUpdates = z.enum(['all', 'externalOnly', 'none']).optional();
const fileMetadata = z.strictObject({
  name: title,
  description: text.optional(),
  mimeType: mimeType.optional(),
  parents: z.array(id).max(1).optional(),
});
const filePatch = z
  .strictObject({
    name: title.optional(),
    description: text.optional(),
    starred: z.boolean().optional(),
    trashed: z.boolean().optional(),
  })
  .refine(value => Object.keys(value).length > 0);
const role = z.enum(['reader', 'commenter', 'writer']);
const permission = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('user'), role, emailAddress: email }),
  z.strictObject({ type: z.literal('group'), role, emailAddress: email }),
  z.strictObject({
    type: z.literal('domain'),
    role,
    domain: z
      .string()
      .max(253)
      .regex(/^[a-zA-Z0-9.-]+$/),
    allowFileDiscovery: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('anyone'), role, allowFileDiscovery: z.boolean().optional() }),
]);
const values = z
  .array(z.array(z.union([z.string().max(50_000), z.number().finite(), z.boolean(), z.null()])).max(100))
  .max(1000);
const valueRange = z.strictObject({ range, majorDimension: z.enum(['ROWS', 'COLUMNS']).optional(), values });
const valueInputOption = z.enum(['RAW', 'USER_ENTERED']);
const gridRange = z
  .strictObject({
    sheetId,
    startRowIndex: index.optional(),
    endRowIndex: index.optional(),
    startColumnIndex: index.optional(),
    endColumnIndex: index.optional(),
  })
  .refine(
    value =>
      (value.endRowIndex === undefined || value.endRowIndex > (value.startRowIndex ?? 0)) &&
      (value.endColumnIndex === undefined || value.endColumnIndex > (value.startColumnIndex ?? 0)),
  );
const dimensionRange = z
  .strictObject({ sheetId, dimension: z.enum(['ROWS', 'COLUMNS']), startIndex: index, endIndex: index })
  .refine(value => value.endIndex > value.startIndex);
const sheetProperties = z.strictObject({
  sheetId: sheetId.optional(),
  title,
  gridProperties: z
    .strictObject({
      rowCount: z.number().int().min(1).max(100_000).optional(),
      columnCount: z.number().int().min(1).max(1000).optional(),
      frozenRowCount: index.optional(),
      frozenColumnCount: index.optional(),
    })
    .optional(),
});
const rgb = z.strictObject({
  red: z.number().min(0).max(1).optional(),
  green: z.number().min(0).max(1).optional(),
  blue: z.number().min(0).max(1).optional(),
});
const cellFormat = z.strictObject({
  backgroundColor: rgb.optional(),
  horizontalAlignment: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional(),
  textFormat: z
    .strictObject({
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      fontSize: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
});
const sheetRequest = z.union([
  z.strictObject({ addSheet: z.strictObject({ properties: sheetProperties }) }),
  z.strictObject({ deleteSheet: z.strictObject({ sheetId }) }),
  z.strictObject({
    updateSheetProperties: z.strictObject({
      properties: sheetProperties.required({ sheetId: true }),
      fields: z.enum(['title', 'gridProperties', 'title,gridProperties']),
    }),
  }),
  z.strictObject({
    repeatCell: z.strictObject({
      range: gridRange,
      cell: z.strictObject({ userEnteredFormat: cellFormat }),
      fields: z.literal('userEnteredFormat'),
    }),
  }),
  z.strictObject({
    insertDimension: z.strictObject({ range: dimensionRange, inheritFromBefore: z.boolean().optional() }),
  }),
  z.strictObject({ deleteDimension: z.strictObject({ range: dimensionRange }) }),
  z.strictObject({ autoResizeDimensions: z.strictObject({ dimensions: dimensionRange }) }),
  z.strictObject({
    mergeCells: z.strictObject({ range: gridRange, mergeType: z.enum(['MERGE_ALL', 'MERGE_COLUMNS', 'MERGE_ROWS']) }),
  }),
  z.strictObject({ unmergeCells: z.strictObject({ range: gridRange }) }),
]);
const tabId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const revisionId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7e]+$/);
const requiredVersion = z
  .string()
  .regex(/^\d{1,19}$/)
  .optional();
const newSlideObjectId = z
  .string()
  .min(5)
  .max(50)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_:-]*$/);
const slideObjectId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_:-]+$/);
const docLocation = z.strictObject({ index, tabId: tabId.optional(), segmentId: tabId.optional() });
const docRange = z
  .strictObject({ startIndex: index, endIndex: index, tabId: tabId.optional(), segmentId: tabId.optional() })
  .refine(value => value.endIndex > value.startIndex);
const points = z.strictObject({ magnitude: z.number().finite().min(0).max(1000), unit: z.literal('PT') });
const textStyle = z.strictObject({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  fontSize: points.extend({ magnitude: z.number().positive().max(400) }).optional(),
});
const styleFields = z
  .string()
  .regex(/^(bold|italic|underline|strikethrough|fontSize)(,(bold|italic|underline|strikethrough|fontSize))*$/)
  .max(100);
const paragraphStyle = z.strictObject({
  namedStyleType: z
    .enum([
      'NORMAL_TEXT',
      'TITLE',
      'SUBTITLE',
      'HEADING_1',
      'HEADING_2',
      'HEADING_3',
      'HEADING_4',
      'HEADING_5',
      'HEADING_6',
    ])
    .optional(),
  alignment: z.enum(['START', 'CENTER', 'END', 'JUSTIFIED']).optional(),
  lineSpacing: z.number().min(1).max(1000).optional(),
  spaceAbove: points.optional(),
  spaceBelow: points.optional(),
});
const paragraphFields = z
  .string()
  .regex(
    /^(namedStyleType|alignment|lineSpacing|spaceAbove|spaceBelow)(,(namedStyleType|alignment|lineSpacing|spaceAbove|spaceBelow))*$/,
  )
  .max(100);
const containsText = z.strictObject({ text: z.string().min(1).max(1000), matchCase: z.boolean() });
const docRequest = z.union([
  z.strictObject({ insertText: z.strictObject({ text, location: docLocation }) }),
  z.strictObject({ replaceAllText: z.strictObject({ containsText, replaceText: text }) }),
  z.strictObject({ deleteContentRange: z.strictObject({ range: docRange }) }),
  z.strictObject({ updateTextStyle: z.strictObject({ range: docRange, textStyle, fields: styleFields }) }),
  z.strictObject({
    updateParagraphStyle: z.strictObject({ range: docRange, paragraphStyle, fields: paragraphFields }),
  }),
  z.strictObject({
    createParagraphBullets: z.strictObject({
      range: docRange,
      bulletPreset: z.enum([
        'BULLET_DISC_CIRCLE_SQUARE',
        'BULLET_CHECKBOX',
        'NUMBERED_DECIMAL_ALPHA_ROMAN',
        'NUMBERED_DECIMAL_NESTED',
      ]),
    }),
  }),
  z.strictObject({
    insertTable: z.strictObject({
      rows: z.number().int().min(1).max(100),
      columns: z.number().int().min(1).max(20),
      location: docLocation,
    }),
  }),
  z.strictObject({ insertPageBreak: z.strictObject({ location: docLocation }) }),
]);
const slideTextRange = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ALL') }),
  z
    .strictObject({ type: z.literal('FIXED_RANGE'), startIndex: index, endIndex: index })
    .refine(value => value.endIndex > value.startIndex),
]);
const cellLocation = z.strictObject({ rowIndex: index, columnIndex: index });
const readRange = z
  .strictObject({ startIndex: index, endIndex: index })
  .refine(
    value => value.endIndex > value.startIndex && value.endIndex - value.startIndex <= 10_000,
    'Read between 1 and 10,000 UTF-16 code units at a time.',
  );
const slideRequest = z.union([
  z.strictObject({
    createSlide: z.strictObject({
      objectId: newSlideObjectId.optional(),
      insertionIndex: index.optional(),
      slideLayoutReference: z
        .strictObject({
          predefinedLayout: z.enum(['BLANK', 'TITLE', 'TITLE_AND_BODY', 'TITLE_ONLY', 'SECTION_HEADER', 'TWO_COLUMNS']),
        })
        .optional(),
    }),
  }),
  z.strictObject({ deleteObject: z.strictObject({ objectId: slideObjectId }) }),
  z.strictObject({ duplicateObject: z.strictObject({ objectId: slideObjectId }) }),
  z.strictObject({
    insertText: z.strictObject({
      objectId: slideObjectId,
      insertionIndex: index.optional(),
      text,
      cellLocation: cellLocation.optional(),
    }),
  }),
  z.strictObject({
    deleteText: z.strictObject({
      objectId: slideObjectId,
      textRange: slideTextRange,
      cellLocation: cellLocation.optional(),
    }),
  }),
  z.strictObject({
    replaceAllText: z.strictObject({
      containsText,
      replaceText: text,
      pageObjectIds: z.array(slideObjectId).max(100).optional(),
    }),
  }),
  z.strictObject({
    updateTextStyle: z.strictObject({
      objectId: slideObjectId,
      textRange: slideTextRange,
      style: textStyle,
      fields: styleFields,
      cellLocation: cellLocation.optional(),
    }),
  }),
  z.strictObject({
    updateSlidesPosition: z.strictObject({
      slideObjectIds: z
        .array(slideObjectId)
        .min(1)
        .max(100)
        .refine(ids => new Set(ids).size === ids.length),
      insertionIndex: index,
    }),
  }),
  z.strictObject({
    updatePageElementTransform: z.strictObject({
      objectId: slideObjectId,
      applyMode: z.enum(['RELATIVE', 'ABSOLUTE']),
      transform: z.strictObject({
        scaleX: z.number().finite(),
        scaleY: z.number().finite(),
        shearX: z.number().finite(),
        shearY: z.number().finite(),
        translateX: z.number().finite(),
        translateY: z.number().finite(),
        unit: z.enum(['PT', 'EMU']),
      }),
    }),
  }),
  z.strictObject({
    createShape: z.strictObject({
      objectId: newSlideObjectId.optional(),
      shapeType: z.enum(['TEXT_BOX', 'RECTANGLE', 'ELLIPSE']),
      elementProperties: z.strictObject({ pageObjectId: slideObjectId }),
    }),
  }),
]);

type Service = 'gmail' | 'calendar' | 'drive' | 'sheets' | 'docs' | 'slides';
const scopes = {
  gmail: 'gmail.modify',
  calendar: 'calendar',
  drive: 'drive',
  sheets: 'spreadsheets',
  docs: 'documents',
  slides: 'presentations',
} satisfies Record<Service, string>;

function operation<const K extends `${Service}.${string}`, S extends z.ZodRawShape>(
  kind: K,
  service: Service,
  effect: 'read' | 'write',
  shape: S,
  scope = scopes[service],
) {
  return {
    schema: z.strictObject({ kind: z.literal(kind), ...shape }),
    metadata: {
      kind,
      service,
      effect,
      approvalRequired: effect === 'write',
      requiredScopes: [`https://www.googleapis.com/auth/${scope}`],
    },
  };
}
/**
 * A Sheets write allowed only on a created or copied spreadsheet. The stored proposal carries the Drive `version` the
 * proposal bound; the agent-facing schema leaves it out because TulipFarm reads and binds it.
 * Reading that version is a Drive `files.get`, which the `spreadsheets` scope does not authorize, so these writes also
 * require the Drive scope that the Google Drive app grants.
 */
function versionedSheetsWrite<const K extends `sheets.${string}`, S extends z.ZodRawShape>(kind: K, shape: S) {
  const agent = operation(kind, 'sheets', 'write', shape);
  return {
    ...agent,
    metadata: {
      ...agent.metadata,
      requiredScopes: [...agent.metadata.requiredScopes, `https://www.googleapis.com/auth/${scopes.drive}`],
    },
    schema: z.strictObject({ kind: z.literal(kind), ...shape, requiredVersion }),
    agentSchema: agent.schema,
  };
}
function sheetsAppend() {
  const agent = operation('sheets.values.append', 'sheets', 'write', {
    spreadsheetId: id,
    range,
    values,
    valueInputOption,
    insertDataOption: z
      .literal('INSERT_ROWS')
      .optional()
      .describe('Appends always insert new rows; existing cells are never overwritten.'),
  });
  return {
    ...agent,
    schema: agent.schema.extend({
      insertDataOption: z
        .enum(['INSERT_ROWS', 'OVERWRITE'])
        .optional()
        .describe('OVERWRITE is always refused with operation-unguarded-update.'),
    }),
    agentSchema: agent.schema,
  };
}

const calendarList = operation('calendar.events.list', 'calendar', 'read', {
  calendarId,
  q: query.optional(),
  timeMin: z.iso.datetime({ offset: true }).optional(),
  timeMax: z.iso.datetime({ offset: true }).optional(),
  singleEvents: z.boolean().optional(),
  orderBy: z.literal('startTime').optional(),
  pageToken,
  maxResults: pageSize,
});
const operations = [
  operation('gmail.messages.list', 'gmail', 'read', {
    q: query.optional(),
    labelIds: z.array(id).max(20).optional(),
    pageToken,
    maxResults: pageSize,
    includeSpamTrash: z.boolean().optional(),
  }),
  operation('gmail.messages.get', 'gmail', 'read', {
    messageId: id,
    format: z.enum(['minimal', 'full', 'metadata', 'raw']).optional(),
  }),
  operation('gmail.messages.modify', 'gmail', 'write', {
    messageId: id,
    addLabelIds: z.array(id).max(100).optional(),
    removeLabelIds: z.array(id).max(100).optional(),
  }),
  operation('gmail.messages.trash', 'gmail', 'write', { messageId: id }),
  operation('gmail.messages.untrash', 'gmail', 'write', { messageId: id }),
  operation('gmail.messages.send', 'gmail', 'write', { message }, 'gmail.send'),
  operation('gmail.drafts.list', 'gmail', 'read', { q: query.optional(), pageToken, maxResults: pageSize }),
  operation('gmail.drafts.get', 'gmail', 'read', {
    draftId: id,
    format: z.enum(['minimal', 'full', 'metadata', 'raw']).optional(),
  }),
  operation('gmail.drafts.create', 'gmail', 'write', { message }),
  operation('gmail.drafts.update', 'gmail', 'write', { draftId: id, message }),
  operation('gmail.drafts.delete', 'gmail', 'write', { draftId: id }),
  operation('gmail.drafts.send', 'gmail', 'write', { draftId: id, message }),
  operation('gmail.labels.list', 'gmail', 'read', {}),
  operation('gmail.labels.get', 'gmail', 'read', { labelId: id }),
  operation('gmail.labels.create', 'gmail', 'write', { label }),
  operation('gmail.labels.update', 'gmail', 'write', { labelId: id, label }),
  operation('gmail.labels.delete', 'gmail', 'write', { labelId: id }),
  operation('calendar.calendars.list', 'calendar', 'read', { pageToken, maxResults: pageSize }),
  operation('calendar.calendars.get', 'calendar', 'read', { calendarId }),
  operation('calendar.calendars.create', 'calendar', 'write', { calendar }),
  operation('calendar.calendars.update', 'calendar', 'write', { calendarId, calendar }),
  operation('calendar.calendars.delete', 'calendar', 'write', { calendarId }),
  {
    ...calendarList,
    schema: calendarList.schema.refine(
      value =>
        (!value.orderBy || value.singleEvents === true) &&
        (!value.timeMin || !value.timeMax || Date.parse(value.timeMax) > Date.parse(value.timeMin)),
      'Start ordering requires expanded events and a valid time window',
    ),
  },
  operation('calendar.events.get', 'calendar', 'read', { calendarId, eventId: id }),
  operation('calendar.events.create', 'calendar', 'write', { calendarId, event, sendUpdates }),
  operation('calendar.events.update', 'calendar', 'write', { calendarId, eventId: id, event, sendUpdates }),
  operation('calendar.events.delete', 'calendar', 'write', { calendarId, eventId: id, sendUpdates }),
  operation('drive.files.list', 'drive', 'read', {
    q: query.optional(),
    pageToken,
    pageSize,
    orderBy: z.enum(['name', 'modifiedTime desc', 'createdTime desc']).optional(),
  }),
  operation('drive.files.get', 'drive', 'read', { fileId: id }),
  operation('drive.files.create', 'drive', 'write', { file: fileMetadata }),
  operation('drive.files.update', 'drive', 'write', {
    fileId: id,
    file: filePatch,
    addParents: z.array(id).max(1).optional(),
    removeParents: z.array(id).max(1).optional(),
  }),
  operation('drive.files.copy', 'drive', 'write', { fileId: id, file: fileMetadata }),
  operation('drive.files.trash', 'drive', 'write', { fileId: id }),
  operation('drive.files.upload', 'drive', 'write', {
    fileId: id.optional(),
    mimeType,
    contentBase64: base64,
    file: fileMetadata.optional(),
  }),
  operation('drive.files.download', 'drive', 'read', { fileId: id }),
  operation('drive.files.export', 'drive', 'read', {
    fileId: id,
    mimeType: z.enum([
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ]),
  }),
  operation('drive.permissions.list', 'drive', 'read', { fileId: id, pageToken, pageSize }),
  operation('drive.permissions.get', 'drive', 'read', { fileId: id, permissionId: id }),
  operation('drive.permissions.create', 'drive', 'write', {
    fileId: id,
    permission,
    sendNotificationEmail: z.boolean().optional(),
  }),
  operation('drive.permissions.update', 'drive', 'write', { fileId: id, permissionId: id, role }),
  operation('drive.permissions.delete', 'drive', 'write', { fileId: id, permissionId: id }),
  operation('sheets.spreadsheets.get', 'sheets', 'read', {
    spreadsheetId: id,
    ranges: z.array(range).max(20).optional(),
    includeGridData: z.boolean().optional(),
  }),
  operation('sheets.spreadsheets.create', 'sheets', 'write', {
    title,
    sheets: z.array(sheetProperties).max(20).optional(),
  }),
  operation('sheets.values.get', 'sheets', 'read', {
    spreadsheetId: id,
    range,
    valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).optional(),
  }),
  versionedSheetsWrite('sheets.values.update', { spreadsheetId: id, range, values, valueInputOption }),
  sheetsAppend(),
  versionedSheetsWrite('sheets.values.clear', { spreadsheetId: id, range }),
  operation('sheets.values.batchGet', 'sheets', 'read', { spreadsheetId: id, ranges: z.array(range).min(1).max(20) }),
  versionedSheetsWrite('sheets.values.batchUpdate', {
    spreadsheetId: id,
    valueInputOption,
    data: z.array(valueRange).min(1).max(20),
  }),
  operation('sheets.values.batchClear', 'sheets', 'write', {
    spreadsheetId: id,
    ranges: z.array(range).min(1).max(20),
  }),
  versionedSheetsWrite('sheets.spreadsheets.batchUpdate', {
    spreadsheetId: id,
    requests: z.array(sheetRequest).min(1).max(100),
  }),
  operation('docs.documents.create', 'docs', 'write', { title }),
  operation('docs.documents.get', 'docs', 'read', {
    documentId: id,
    selection: z
      .discriminatedUnion('view', [
        z.strictObject({ view: z.literal('outline') }),
        z.strictObject({ view: z.literal('range'), tabId, segmentId: tabId.optional(), range: readRange }),
      ])
      .optional()
      .describe(
        'For a large document, read outline for tab IDs, then range for at most 10,000 UTF-16 code units. Returned indexes are original document indexes.',
      ),
  }),
  operation('docs.documents.batchUpdate', 'docs', 'write', {
    documentId: id,
    requests: z.array(docRequest).min(1).max(100),
    requiredRevisionId: revisionId
      .optional()
      .describe('Required for proposals. The revisionId returned by docs.documents.get for the reviewed document.'),
  }),
  operation('slides.presentations.create', 'slides', 'write', { title }),
  operation('slides.presentations.get', 'slides', 'read', {
    presentationId: id,
    view: z
      .enum(['content', 'outline'])
      .optional()
      .describe(
        'outline returns only slide IDs and revisionId. For a large deck, then read each slide with slides.presentations.pages.get.',
      ),
  }),
  operation('slides.presentations.pages.get', 'slides', 'read', {
    presentationId: id,
    pageObjectId: slideObjectId,
    detail: z
      .strictObject({
        elementId: slideObjectId
          .optional()
          .describe('Read one element, including a nested group child, rather than the whole page.'),
        cellLocation: cellLocation.optional(),
        range: readRange.optional(),
      })
      .refine(
        value => (!value.cellLocation && !value.range) || value.elementId !== undefined,
        'A cell or text range requires elementId.',
      )
      .optional()
      .describe('Include styling and grouped content. Use elementId, cellLocation, and range to narrow large results.'),
  }),
  operation('slides.presentations.batchUpdate', 'slides', 'write', {
    presentationId: id,
    requests: z.array(slideRequest).min(1).max(100),
    requiredRevisionId: revisionId
      .optional()
      .describe(
        'Required for proposals. The revisionId returned by slides.presentations.get or slides.presentations.pages.get for the reviewed presentation.',
      ),
  }),
] as const;

const [firstOperation, ...remainingOperations] = operations;
export const googleOperationSchema = z.discriminatedUnion('kind', [
  firstOperation.schema,
  ...remainingOperations.map(value => value.schema),
]);
export type GoogleOperation = z.infer<typeof googleOperationSchema>;
/** What an agent tool call may carry: every operation, without the Sheets `requiredVersion` that a proposal binds and without the refused append `OVERWRITE`. */
export const googleAgentOperationSchema = z.discriminatedUnion('kind', [
  firstOperation.schema,
  ...remainingOperations.map(value => ('agentSchema' in value ? value.agentSchema : value.schema)),
]);
export const googleOperationCatalog = Object.freeze(
  operations.map(value =>
    Object.freeze({ ...value.metadata, requiredScopes: Object.freeze(value.metadata.requiredScopes) }),
  ),
);
export function isGoogleWrite(operation: GoogleOperation): boolean {
  return googleOperationCatalog.some(entry => entry.kind === operation.kind && entry.effect === 'write');
}

export type GoogleWriteTarget =
  | { kind: 'unbound' }
  | { kind: 'revision'; service: 'docs' | 'slides'; id: string; requiredRevisionId: string | undefined }
  | { kind: 'created-spreadsheet'; id: string; requiredVersion: string | undefined }
  | { kind: 'unguarded' };

// Google-original updates are reviewable only when the provider enforces the reviewed revision at write time.
// Sheets has no write precondition, so its in-place writes are allowed only on spreadsheets this workspace created or copied,
// and TulipFarm compares the Drive `version` itself before the write.
export function googleWriteTarget(operation: GoogleOperation): GoogleWriteTarget {
  switch (operation.kind) {
    case 'docs.documents.batchUpdate':
      return {
        kind: 'revision',
        service: 'docs',
        id: operation.documentId,
        requiredRevisionId: operation.requiredRevisionId,
      };
    case 'slides.presentations.batchUpdate':
      return {
        kind: 'revision',
        service: 'slides',
        id: operation.presentationId,
        requiredRevisionId: operation.requiredRevisionId,
      };
    case 'sheets.values.update':
    case 'sheets.values.batchUpdate':
    case 'sheets.values.clear':
    case 'sheets.spreadsheets.batchUpdate':
      return { kind: 'created-spreadsheet', id: operation.spreadsheetId, requiredVersion: operation.requiredVersion };
    case 'sheets.values.batchClear':
      return { kind: 'unguarded' };
    case 'sheets.values.append':
      return operation.insertDataOption === 'OVERWRITE' ? { kind: 'unguarded' } : { kind: 'unbound' };
    case 'drive.files.upload':
      return operation.fileId ? { kind: 'unguarded' } : { kind: 'unbound' };
    default:
      return { kind: 'unbound' };
  }
}

export class GoogleOperationError extends Error {
  readonly code:
    | 'target-stale'
    | 'invalid-operation'
    | 'invalid-credential'
    | 'cancelled'
    | 'provider-unavailable'
    | 'provider-rejected'
    | 'reconnect-required'
    | 'insufficient-scope'
    | 'rate-limited'
    | 'response-too-large'
    | 'invalid-response'
    | 'outcome-unknown';

  constructor(code: GoogleOperationError['code']) {
    super(code);
    this.name = 'GoogleOperationError';
    this.code = code;
  }
}
