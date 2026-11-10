import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { parse } from 'csv-parse';
import ExcelJS from 'exceljs';
import { fromBuffer, type Entry } from 'yauzl';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  requireNoMcpDerived,
  sourceDependenciesSchema,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import type { AttachmentBytes } from '@tulipfarm/conversations/attachments';
import { mergeSources } from '@tulipfarm/conversations/results';
import { createFiles } from '@tulipfarm/files';
import { canonicalJson } from './canonical.ts';
import { importAdjustmentsSchema, type ImportAdjustment } from './proposal-contracts.ts';
import { table, type TableRuntime, type TableTransaction } from './service-store.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export const importLimits = Object.freeze({
  bytes: 10 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  rows: 100000,
  columns: 64,
  cellCharacters: 10000,
  archiveEntries: 1024,
});
export class TableImportError extends Error {
  constructor(
    readonly code:
      | 'invalid-selection'
      | 'ambiguous-selection'
      | 'attachment-unknown'
      | 'snapshot-unavailable'
      | 'snapshot-conflict'
      | 'digest-mismatch'
      | 'byte-limit'
      | 'row-limit'
      | 'column-limit'
      | 'duplicate-header'
      | 'invalid-header'
      | 'malformed-row'
      | 'malformed-file'
      | 'unsupported-cell'
      | 'invalid-value'
      | 'import-unavailable',
    /**
     * Where a row or value failed: the 1-based data row (counting from the first row after the header, as
     * import reviews do), the 1-based row of the file or sheet, the header column and, for a value, a
     * shortened copy of it.
     */
    readonly location?: ImportFailureLocation,
    readonly candidates?: { sheet?: string; row: number }[],
  ) {
    super(code);
  }
}
export type ImportFailureLocation = {
  row: number;
  sourceRow?: number;
  source?: 'file' | 'sheet' | 'source';
  column?: string;
  value?: string;
};
type ImportFailureCode = TableImportError['code'];
/** Who can fix a failure: the assistant by correcting its selection, the person by fixing the file, or nobody now. */
const importFailures: Record<
  ImportFailureCode,
  { reason: string; fix: 'reference' | 'selection' | 'value' | 'file' | 'retry' | 'prepared' | 'choose' }
> = {
  'attachment-unknown': {
    reason: 'The file reference doesn’t match a file attached to this chat.',
    fix: 'reference',
  },
  'invalid-selection': {
    reason:
      'The import settings don’t match the file. Check the format, delimiter, sheet name, header row and conversions.',
    fix: 'selection',
  },
  'ambiguous-selection': {
    reason: 'More than one sheet or header row could be imported.',
    fix: 'choose',
  },
  'invalid-header': {
    reason: 'The header row is missing, or a column name in it is blank or too long.',
    fix: 'selection',
  },
  'duplicate-header': { reason: 'Two columns in the header row have the same name.', fix: 'file' },
  'malformed-row': { reason: 'A row has a different number of cells than the header.', fix: 'selection' },
  'invalid-value': { reason: 'A value doesn’t fit its column’s conversion.', fix: 'value' },
  'unsupported-cell': {
    reason: 'The sheet has merged cells, formulas or rich text, which can’t be imported.',
    fix: 'file',
  },
  'malformed-file': {
    reason: 'The file couldn’t be read. A CSV must be UTF-8 text and an XLSX an unprotected workbook.',
    fix: 'file',
  },
  'byte-limit': { reason: 'The file is empty or larger than 10 MB.', fix: 'file' },
  'row-limit': { reason: 'The file has more than 100,000 rows.', fix: 'file' },
  'column-limit': { reason: 'The file has more than 64 columns.', fix: 'file' },
  'digest-mismatch': { reason: 'The file changed after it was listed.', fix: 'selection' },
  'snapshot-unavailable': { reason: 'The prepared file couldn’t be saved.', fix: 'retry' },
  'snapshot-conflict': {
    reason: 'This file was already prepared in this reply with other settings, and that preparation stands.',
    fix: 'prepared',
  },
  'import-unavailable': { reason: 'The file couldn’t be prepared because storage didn’t respond.', fix: 'retry' },
};
const personSteps = {
  reference: 'Ask again and the assistant will pick the attached file again.',
  selection: 'Ask again and the assistant will correct the settings.',
  value: 'Correct the value in the file and attach it again.',
  file: 'Fix the file, attach it again and ask again.',
  retry: 'Try again in a moment.',
  prepared: 'The assistant can continue with the file as first prepared.',
  choose: 'Specify the sheet and header row to import, then ask again.',
};
const assistantSteps = {
  reference:
    'Call tables.import.attachments in this reply, then call tables.import.file again with one returned attachmentId and its contentDigest copied exactly. If the file is not listed, ask the person to attach it to this chat.',
  value:
    'If the conversion for that column does not match its destination field type, correct the selection and call tables.import.file again in this reply. Otherwise ask the person to correct that value.',
  selection:
    'Correct the selection and call tables.import.file again in this reply with the same attachmentId and contentDigest from tables.import.attachments.',
  file: 'The file itself must change. Tell the person the reason and ask them to fix and reattach it; do not retry with the same file.',
  retry:
    'Call tables.import.file once more in this reply; if it fails again, tell the person preparation failed and to try later.',
  prepared:
    'Do not call tables.import.file again for this file in this reply, and do not schedule a retry. Continue now: call tables.propose with this same attachmentId and contentDigest as the import reference.',
  choose:
    'Use the requested destination table to disambiguate the listed candidates. If more than one still matches, ask the person which sheet and header row to use; never guess.',
};

function failureWhere(location: ImportFailureLocation) {
  const { row, sourceRow, source = 'file', column, value } = location;
  return [
    `data row ${row}${sourceRow !== undefined && sourceRow !== row ? ` (row ${sourceRow} of the ${source})` : ''}`,
    ...(column ? [`column "${column.slice(0, 40)}"`] : []),
    ...(value !== undefined ? [`value "${value}"`] : []),
  ].join(', ');
}

/**
 * A tool result for a failed file preparation: the reason with the person's next step, which
 * activity shows as the step detail, and the assistant's own next step. Rows are numbered as data
 * rows, like import review problems, and a failing value is quoted in shortened form.
 */
export function tableImportFailure(error: TableImportError) {
  const { reason, fix } = importFailures[error.code];
  const where = error.location ? `: ${failureWhere(error.location)}` : '';
  const candidates = error.candidates?.length
    ? ` Candidates: ${error.candidates.map(item => `${item.sheet ? `"${item.sheet}" ` : ''}row ${item.row}`).join(', ')}.`
    : '';
  return {
    error: 'import-file-failed' as const,
    code: error.code,
    reason: `${reason.replace(/\.$/, '')}${where}. ${personSteps[fix]}${candidates}`,
    ...(error.candidates ? { candidates: error.candidates } : {}),
    ...(error.location ? { location: error.location } : {}),
    instruction:
      fix === 'prepared'
        ? `The file is already prepared from an earlier call in this reply; no review was created yet. This is not a permission denial. ${assistantSteps[fix]}`
        : `No file was prepared and no review was created. This is not a permission denial, and tables.import.file is available. ${assistantSteps[fix]} Tell the person this reason, with its data row and file row as given, not a guessed one.`,
  };
}
// Stored keys and the tf_table_import_objects object_key CHECK use this prefix.
const objectPrefix = 'resource-imports';
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const referenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), attachmentId: z.uuid(), contentDigest: digestSchema }),
  z.strictObject({ kind: z.literal('integration'), resultId: z.uuid(), contentDigest: digestSchema }),
]);
export type ImportReference = z.infer<typeof referenceSchema>;
export type ImportOrigin = { conversationId: string; turnId: string; sources: readonly SourceDependency[] };
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(value => [...value].every(char => char.charCodeAt(0) >= 32) && !/[\uD800-\uDFFF]/u.test(value));
const conversionSchema = z.enum(['text', 'numeric', 'boolean', 'date', 'timestamp']);
const conversionsSchema = z.record(nameSchema, conversionSchema);
const csvRowSchema = z.array(z.string()).max(importLimits.columns);
const headerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('row'), row: z.int().min(1).max(100001) }),
  z.strictObject({ kind: z.literal('provided'), names: z.array(nameSchema).min(1).max(64) }),
]);
const tabular = { header: headerSchema, conversions: conversionsSchema, empty: z.enum(['null', 'text']) };
// Files usually start with a header row, so a file selection may omit it or give the row number alone.
const fileTabular = {
  header: z
    .preprocess(
      value =>
        value === true ? { kind: 'row', row: 1 } : typeof value === 'number' ? { kind: 'row', row: value } : value,
      headerSchema,
    )
    .default({ kind: 'row', row: 1 }),
  conversions: conversionsSchema.default({}),
  empty: tabular.empty.default('null'),
};
export const fileImportSelectionSchema = z.discriminatedUnion('format', [
  z.strictObject({ format: z.literal('csv'), delimiter: z.enum([',', ';', '\t', '|']), ...fileTabular }),
  z.strictObject({ format: z.literal('xlsx'), sheet: z.string().min(1).max(31), ...fileTabular }),
]);
export type FileImportSelection = z.infer<typeof fileImportSelectionSchema>;
export const fileImportPreparationSchema = z.strictObject({
  format: z.enum(['csv', 'xlsx']).optional(),
  delimiter: z.enum([',', ';', '\t', '|']).optional(),
  sheet: z.string().min(1).max(31).optional(),
  header: fileTabular.header.unwrap().optional(),
  conversions: fileTabular.conversions,
  empty: fileTabular.empty,
});
type FileImportPreparation = z.infer<typeof fileImportPreparationSchema>;
// A prepared file stores its fitted selection with the adjustments made; files prepared before then store the bare selection.
const preparedFileSchema = z.union([
  z.strictObject({ selection: fileImportSelectionSchema, adjustments: importAdjustmentsSchema }),
  fileImportSelectionSchema.transform(selection => ({ selection, adjustments: [] as ImportAdjustment[] })),
]);

type Conversion = z.infer<typeof conversionSchema>;
const conversionAliases: Record<string, Conversion> = {
  number: 'numeric',
  integer: 'numeric',
  int: 'numeric',
  decimal: 'numeric',
  float: 'numeric',
  double: 'numeric',
  currency: 'numeric',
  money: 'numeric',
  percent: 'numeric',
  percentage: 'numeric',
  bool: 'boolean',
  checkbox: 'boolean',
  datetime: 'timestamp',
  'date-time': 'timestamp',
  date_time: 'timestamp',
  time: 'timestamp',
};
const delimiterAliases: Record<string, string> = {
  comma: ',',
  semicolon: ';',
  tab: '\t',
  '\\t': '\t',
  tsv: '\t',
  pipe: '|',
};
const selectionKeys = new Set(['format', 'delimiter', 'sheet', 'header', 'conversions', 'empty']);

/**
 * A conversion written as a field kind or a synonym. Field kinds without a conversion of their own, such as
 * single-select, multi-select, status or url, stay text: import plans match and convert text to the field's kind.
 */
function conversion(value: unknown): Conversion {
  const kind =
    value && typeof value === 'object'
      ? ((value as Record<string, unknown>).kind ?? (value as Record<string, unknown>).type)
      : value;
  if (typeof kind !== 'string') return 'text';
  const key = kind.trim().toLowerCase();
  const parsed = conversionSchema.safeParse(key);
  return parsed.success ? parsed.data : (conversionAliases[key] ?? 'text');
}

/**
 * Rewrites a chat model's loose file selection into the strict contract where its meaning is clear: a field kind
 * or synonym as a conversion, a named delimiter, header and sheet under common other names, and keys the
 * selection has no use for. A selection that is still invalid after this fails as `invalid-selection`.
 */
export function lenientFileImportSelection(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const loose = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(loose)) if (selectionKeys.has(key)) out[key] = value;
  out.sheet ??= loose.sheetName ?? loose.sheet_name ?? loose.worksheet ?? loose.tab;
  out.delimiter ??= loose.separator ?? loose.sep ?? loose.delimeter;
  if (out.header === undefined) {
    const row = loose.headerRow ?? loose.header_row;
    const has = loose.hasHeader ?? loose.has_header ?? loose.headers;
    if (typeof row === 'number' || (typeof row === 'string' && /^\d+$/.test(row))) out.header = Number(row);
    else if (has === true) out.header = true;
  }
  if (typeof out.format === 'string') out.format = out.format.trim().toLowerCase().replace(/^\./, '');
  if (out.format === 'excel' || out.format === 'xls') out.format = 'xlsx';
  if (out.format === 'tsv') {
    out.format = 'csv';
    out.delimiter ??= '\t';
  }
  if (out.format === undefined && out.sheet !== undefined) out.format = 'xlsx';
  if (typeof out.delimiter === 'string')
    out.delimiter = delimiterAliases[out.delimiter.trim().toLowerCase()] ?? out.delimiter;
  if (out.format === 'csv') delete out.sheet;
  else if (out.format === 'xlsx') delete out.delimiter;
  if (out.sheet === undefined) delete out.sheet;
  if (out.delimiter === undefined) delete out.delimiter;
  if (typeof out.header === 'string' && /^\d+$/.test(out.header)) out.header = Number(out.header);
  if (typeof out.empty === 'string') {
    const empty = out.empty.trim().toLowerCase();
    out.empty = ['text', 'string', 'empty-string', 'empty_string', 'keep'].includes(empty) ? 'text' : 'null';
  } else if (out.empty === null) out.empty = 'null';
  else if (out.empty !== undefined && typeof out.empty !== 'string') delete out.empty;
  const conversions = out.conversions;
  if (Array.isArray(conversions))
    out.conversions = Object.fromEntries(
      conversions.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const entry = item as Record<string, unknown>;
        const column = entry.column ?? entry.name ?? entry.sourceColumn ?? entry.header;
        return typeof column === 'string'
          ? [[column, conversion(entry.conversion ?? entry.to ?? entry.kind ?? entry.type)]]
          : [];
      }),
    );
  else if (conversions && typeof conversions === 'object')
    out.conversions = Object.fromEntries(
      Object.entries(conversions).map(([column, value]) => [column, conversion(value)]),
    );
  else if (conversions === null) delete out.conversions;
  return out;
}
export const integrationImportSelectionSchema = z.discriminatedUnion('format', [
  z.strictObject({ format: z.literal('matrix'), path: z.array(z.string().min(1).max(120)).max(12), ...tabular }),
  z.strictObject({
    format: z.enum(['object', 'objects']),
    path: z.array(z.string().min(1).max(120)).max(12),
    columns: z.array(nameSchema).min(1).max(64),
    conversions: conversionsSchema,
    empty: z.enum(['null', 'text']),
  }),
]);
type IntegrationSelection = z.infer<typeof integrationImportSelectionSchema>;
type Scalar = string | number | boolean | Date | null;
export type ImportValue =
  | null
  | { kind: 'text'; value: string }
  | { kind: 'numeric'; value: string }
  | { kind: 'date'; value: string }
  | { kind: 'timestamp'; value: string }
  | { kind: 'boolean'; value: boolean };
export type ImportSnapshot = {
  contentDigest: string;
  sources: SourceDependency[];
  rows: Record<string, ImportValue>[];
  adjustments?: ImportAdjustment[];
};

function validated<T>(schema: z.ZodType<T>, value: unknown, code: TableImportError['code']): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TableImportError(code);
  return result.data;
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TableImportError || error instanceof AccessDenied) throw error;
    // Parser, provider, storage, and SQL errors can contain private values.
    throw new TableImportError('import-unavailable');
  }
}
function headers(values: unknown[]): string[] {
  if (values.length > importLimits.columns) throw new TableImportError('column-limit');
  const names = validated(z.array(nameSchema).min(1), values, 'invalid-header');
  if (new Set(names).size !== names.length) throw new TableImportError('duplicate-header');
  return names;
}
function value(cell: Scalar, kind: z.infer<typeof conversionSchema>, empty: 'null' | 'text'): ImportValue {
  if (cell === null || cell === '') return empty === 'null' ? null : { kind: 'text', value: '' };
  if (cell instanceof Date) {
    if (!Number.isFinite(cell.valueOf()) || !['date', 'timestamp'].includes(kind))
      throw new TableImportError('invalid-value');
    if (kind === 'date' && cell.toISOString().slice(11) !== '00:00:00.000Z')
      throw new TableImportError('invalid-value');
    cell = kind === 'date' ? cell.toISOString().slice(0, 10) : cell.toISOString();
  }
  const text = String(cell);
  if (text.length > importLimits.cellCharacters || text.includes('\u0000') || /[\uD800-\uDFFF]/u.test(text))
    throw new TableImportError('invalid-value');
  switch (kind) {
    case 'text':
      return { kind, value: text };
    case 'numeric':
      if (
        !/^-?(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,10})?$/.test(text) ||
        (typeof cell === 'number' && !Number.isSafeInteger(cell) && Number.isInteger(cell))
      )
        throw new TableImportError('invalid-value');
      return { kind, value: text };
    case 'boolean':
      if (text !== 'true' && text !== 'false') throw new TableImportError('invalid-value');
      return { kind, value: text === 'true' };
    case 'date':
      validated(
        z.iso.date().refine(date => !date.startsWith('0000-')),
        text,
        'invalid-value',
      );
      return { kind, value: text };
    case 'timestamp': {
      validated(
        z.iso
          .datetime({ offset: true })
          .regex(
            /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/,
          ),
        text,
        'invalid-value',
      );
      const date = new Date(text);
      if (!Number.isFinite(date.valueOf()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
        throw new TableImportError('invalid-value');
      return { kind, value: date.toISOString() };
    }
  }
}
function shownValue(cell: Scalar) {
  const text =
    cell instanceof Date ? (Number.isFinite(cell.valueOf()) ? cell.toISOString() : 'Invalid Date') : String(cell);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
function collector(
  selection: Pick<FileImportSelection, 'header' | 'conversions' | 'empty'>,
  source: NonNullable<ImportFailureLocation['source']>,
) {
  let names = selection.header.kind === 'provided' ? headers(selection.header.names) : null;
  const rows: ImportSnapshot['rows'] = [];
  let ordinal = 0;
  return {
    add(cells: Scalar[], spreadsheet = false) {
      ordinal++;
      if (ordinal > importLimits.rows + 1) throw new TableImportError('row-limit');
      if (!names) {
        if (selection.header.kind !== 'row' || ordinal < selection.header.row) return;
        names = headers(cells);
        return;
      }
      if (rows.length >= importLimits.rows) throw new TableImportError('row-limit');
      if (cells.length > names.length || (!spreadsheet && cells.length !== names.length))
        throw new TableImportError('malformed-row', { row: rows.length + 1, sourceRow: ordinal, source });
      rows.push(
        Object.fromEntries(
          names.map((name, index) => {
            try {
              return [
                name,
                value(
                  cells[index] ?? null,
                  Object.hasOwn(selection.conversions, name) ? (selection.conversions[name] ?? 'text') : 'text',
                  selection.empty,
                ),
              ];
            } catch (error) {
              if (error instanceof TableImportError)
                throw new TableImportError(error.code, {
                  row: rows.length + 1,
                  sourceRow: ordinal,
                  source,
                  column: name,
                  ...(error.code === 'invalid-value' ? { value: shownValue(cells[index] ?? null) } : {}),
                });
              throw error;
            }
          }),
        ),
      );
    },
    finish() {
      if (!names) throw new TableImportError('invalid-header');
      const selected = names;
      if (Object.keys(selection.conversions).some(name => !selected.includes(name)))
        throw new TableImportError('invalid-selection');
      return rows;
    },
  };
}

async function checkArchive(bytes: Uint8Array) {
  await new Promise<void>((resolve, reject) => {
    fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new TableImportError('malformed-file'));
          return;
        }
        let total = 0;
        let settled = false;
        const names = new Set<string>();
        const fail = (code: TableImportError['code']) => {
          if (settled) return;
          settled = true;
          zip.close();
          reject(new TableImportError(code));
        };
        zip.on('error', () => fail('malformed-file'));
        zip.on('end', () => {
          if (!names.has('xl/workbook.xml') || !names.has('[Content_Types].xml')) fail('malformed-file');
          else {
            settled = true;
            resolve();
          }
        });
        zip.on('entry', (entry: Entry) => {
          if (settled) return;
          if (names.has(entry.fileName) || entry.isEncrypted()) {
            fail('malformed-file');
            return;
          }
          names.add(entry.fileName);
          total += entry.uncompressedSize;
          if (total > importLimits.expandedBytes || names.size > importLimits.archiveEntries) {
            fail('byte-limit');
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail('malformed-file');
              return;
            }
            let actual = 0;
            stream.on('data', (chunk: Buffer) => {
              actual += chunk.byteLength;
              if (actual > entry.uncompressedSize) {
                stream.destroy();
                fail('byte-limit');
              }
            });
            stream.on('error', () => fail('malformed-file'));
            stream.on('end', () => {
              if (!settled) zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

const csvDelimiters = [',', ';', '\t', '|'] as const;
function unquotedCount(line: string, delimiter: string) {
  let count = 0;
  let quoted = false;
  for (const character of line)
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === delimiter) count++;
  return count;
}
const columnKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
type HeaderCandidate = { sheet?: string; row: number; width: number };

function headerWidth(cells: unknown[], fields: string[][]) {
  const parsed = z.array(nameSchema).min(1).max(importLimits.columns).safeParse(cells);
  if (!parsed.success) return 0;
  const names = parsed.data.map(columnKey);
  if (new Set(names).size !== names.length) return 0;
  return fields.some(labels => {
    const known = new Set(labels.map(columnKey));
    return names.every(name => known.has(name));
  })
    ? names.length
    : 0;
}

function chooseHeader<T extends HeaderCandidate>(candidates: T[]) {
  const width = candidates.reduce((maximum, candidate) => Math.max(maximum, candidate.width), 0);
  const best = candidates.filter(candidate => candidate.width === width);
  if (best.length > 1)
    throw new TableImportError(
      'ambiguous-selection',
      undefined,
      best.slice(0, 100).map(({ sheet, row }) => ({ ...(sheet ? { sheet } : {}), row })),
    );
  return best[0];
}

async function csvHeaders(
  bytes: Uint8Array,
  delimiter: ',' | ';' | '\t' | '|',
  fields: string[][],
  header: FileImportPreparation['header'],
) {
  const candidates: (HeaderCandidate & { delimiter: typeof delimiter })[] = [];
  const parser = parse({ bom: true, delimiter, relax_column_count: true, max_record_size: 1024 * 1024 });
  let row = 0;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    Readable.from([text]).pipe(parser);
    for await (const cells of parser) {
      if (++row > importLimits.rows + 1) break;
      if (header?.kind === 'row' && row !== header.row) continue;
      const width = headerWidth(cells, fields);
      if (width) candidates.push({ row, width, delimiter });
    }
  } catch {
    // A guessed delimiter may not parse. The selected parser still reports the actual file error.
  } finally {
    parser.destroy();
  }
  return candidates;
}

/**
 * Models often give the first data row as the header row. When an earlier row reads as a header and names more
 * of the selection's conversion columns, or the requested row cannot be a header at all, that row is used instead.
 */
async function headerRowFit(bytes: Uint8Array, selection: FileImportSelection) {
  if (selection.header.kind !== 'row' || selection.header.row < 2) return null;
  const requestedRow = selection.header.row;
  const lines: Scalar[][] = [];
  try {
    await fileCells(bytes, selection, cells => {
      lines.push(cells);
      return lines.length <= requestedRow;
    });
  } catch (error) {
    if (error instanceof TableImportError) return null;
    throw error;
  }
  const wanted = Object.keys(selection.conversions).map(columnKey);
  // A header row holds unique non-blank text names, and the row after it has no more cells than it.
  const score = (row: number) => {
    const cells = lines[row - 1];
    const next = lines[row];
    if (!cells || !next || cells.some(cell => typeof cell !== 'string')) return null;
    const names = cells.map(cell => columnKey(String(cell)));
    if (names.some(name => !name) || new Set(names).size !== names.length || next.length > names.length) return null;
    return wanted.filter(name => names.includes(name)).length;
  };
  const requested = score(requestedRow);
  let best: { row: number; score: number } | null = null;
  for (let row = 1; row < Math.min(requestedRow, 6); row++) {
    const found = score(row);
    if (found !== null && (requested === null || found > requested) && (!best || found > best.score))
      best = { row, score: found };
  }
  if (!best) return null;
  return {
    adjustment: { kind: 'header' as const, requested: requestedRow, used: best.row },
    selection: { ...selection, header: { kind: 'row' as const, row: best.row } },
  };
}

/**
 * Resolves omitted format, sheet and header choices from the file and destination fields; an explicit sheet
 * remains authoritative, and an explicit header row only moves to an earlier row that reads as the header. Fits the delimiter, conversions keyed by a header in another case or
 * spacing (others are dropped, so the column stays text), and a conversion that a column's values don't fit
 * replaced by text, or a timestamp for spreadsheet dates. Import plans still convert text to each field's kind.
 * Each change is returned as an adjustment, so the import review can list it.
 */
export async function fitFileImportSelection(
  bytes: Uint8Array,
  input: unknown,
  fields: string[][] = [],
): Promise<{ selection: FileImportSelection; adjustments: ImportAdjustment[] }> {
  const requested = validated(fileImportPreparationSchema, input, 'invalid-selection');
  if (!bytes.byteLength || bytes.byteLength > importLimits.bytes) throw new TableImportError('byte-limit');
  const format = requested.format ?? (bytes[0] === 0x50 && bytes[1] === 0x4b ? 'xlsx' : 'csv');
  let selection: FileImportSelection;
  const adjustments: ImportAdjustment[] = [];
  if (format === 'csv') {
    let delimiter = requested.delimiter ?? ',';
    const candidates =
      fields.length && requested.header?.kind !== 'provided'
        ? (
            await Promise.all(csvDelimiters.map(candidate => csvHeaders(bytes, candidate, fields, requested.header)))
          ).flat()
        : [];
    const matched = chooseHeader([
      ...new Map(
        candidates.map(candidate => [
          `${candidate.row}:${candidate.width === 1 ? '' : candidate.delimiter}`,
          candidate,
        ]),
      ).values(),
    ]);
    if (matched) delimiter = matched.delimiter;
    const head = new TextDecoder().decode(bytes.subarray(0, 64 * 1024)).replace(/^\uFEFF/, '');
    const line = head.split(/\r?\n/, 1)[0] ?? '';
    if (!matched && !unquotedCount(line, delimiter)) {
      const [best] = csvDelimiters
        .map(delimiter => ({ delimiter, count: unquotedCount(line, delimiter) }))
        .sort((a, b) => b.count - a.count);
      if (best?.count) delimiter = best.delimiter;
    }
    if (delimiter !== (requested.delimiter ?? ','))
      adjustments.push({ kind: 'delimiter', requested: requested.delimiter ?? ',', used: delimiter });
    selection = validated(
      fileImportSelectionSchema,
      {
        format,
        delimiter,
        header: requested.header ?? { kind: 'row', row: matched?.row ?? 1 },
        conversions: requested.conversions,
        empty: requested.empty,
      },
      'invalid-selection',
    );
  } else {
    const workbook = new ExcelJS.Workbook();
    await checkArchive(bytes);
    await workbook.xlsx.read(Readable.from([Buffer.from(bytes)])).catch(() => {
      throw new TableImportError('malformed-file');
    });
    const exact = workbook.worksheets.find(sheet => sheet.name === requested.sheet);
    const sheets = exact
      ? [exact]
      : requested.sheet
        ? workbook.worksheets.filter(sheet => columnKey(sheet.name) === columnKey(requested.sheet!))
        : workbook.worksheets;
    if (!sheets.length) throw new TableImportError('invalid-selection');
    const candidates: HeaderCandidate[] = [];
    if (fields.length && requested.header?.kind !== 'provided')
      for (const sheet of sheets) {
        for (let row = 1; row <= Math.min(sheet.rowCount, importLimits.rows + 1); row++) {
          if (requested.header?.kind === 'row' && row !== requested.header.row) continue;
          const cells = sheet.getRow(row);
          if (cells.cellCount > importLimits.columns) continue;
          const width = headerWidth(
            Array.from({ length: cells.cellCount }, (_, column) => cells.getCell(column + 1).value),
            fields,
          );
          if (width) candidates.push({ sheet: sheet.name, row, width });
        }
      }
    const matched = chooseHeader(candidates);
    if (!matched && sheets.length > 1)
      throw new TableImportError(
        'ambiguous-selection',
        undefined,
        sheets.slice(0, 100).map(sheet => ({
          sheet: sheet.name,
          row: requested.header?.kind === 'row' ? requested.header.row : 1,
        })),
      );
    const sheet = matched?.sheet ?? sheets[0]!.name;
    if (requested.sheet && requested.sheet !== sheet)
      adjustments.push({ kind: 'sheet', requested: requested.sheet, used: sheet, only: false });
    selection = validated(
      fileImportSelectionSchema,
      {
        format,
        sheet,
        header: requested.header ?? { kind: 'row', row: matched?.row ?? 1 },
        conversions: requested.conversions,
        empty: requested.empty,
      },
      'invalid-selection',
    );
  }
  const headed = requested.header?.kind === 'row' ? await headerRowFit(bytes, selection) : null;
  if (headed) {
    adjustments.push(headed.adjustment);
    selection = headed.selection;
  }
  if (Object.keys(selection.conversions).length) {
    const rows = await parseImportFile(bytes, { ...selection, conversions: {} }).catch(error => {
      if (error instanceof TableImportError) return null;
      throw error;
    });
    if (!rows) return { selection, adjustments };
    const columns = new Map(Object.keys(rows[0] ?? {}).map(name => [columnKey(name), name]));
    const conversions: Record<string, Conversion> = {};
    for (const [name, kind] of Object.entries(selection.conversions)) {
      const column = columns.get(columnKey(name));
      if (!column) adjustments.push({ kind: 'conversion-dropped', column: name.slice(0, 120), conversion: kind });
      else if (!(column in conversions)) {
        if (column !== name) adjustments.push({ kind: 'column', requested: name.slice(0, 120), used: column });
        conversions[column] = kind;
      }
    }
    selection = { ...selection, conversions };
  }
  const tried = new Map<string, Set<Conversion>>();
  const changed = new Map<string, Extract<ImportAdjustment, { kind: 'conversion-changed' }>>();
  for (;;) {
    try {
      await parseImportFile(bytes, selection);
      adjustments.push(...[...changed.values()].filter(change => change.requested !== change.used));
      return { selection, adjustments };
    } catch (error) {
      const column = error instanceof TableImportError ? error.location?.column : undefined;
      if (!(error instanceof TableImportError) || error.code !== 'invalid-value' || column === undefined) throw error;
      const current = selection.conversions[column] ?? 'text';
      const kinds = tried.get(column) ?? new Set<Conversion>();
      kinds.add(current);
      tried.set(column, kinds);
      const next: Conversion =
        /^\d{4}-\d{2}-\d{2}T/.test(error.location?.value ?? '') && !kinds.has('timestamp') ? 'timestamp' : 'text';
      if (kinds.has(next)) throw error;
      const example = (error.location?.value ?? '').slice(0, 40);
      changed.set(column, {
        kind: 'conversion-changed',
        column: column.slice(0, 120),
        requested: changed.get(column)?.requested ?? current,
        used: next,
        example: changed.get(column)?.example ?? example,
      });
      selection = { ...selection, conversions: { ...selection.conversions, [column]: next } };
    }
  }
}

export async function parseImportFile(bytes: Uint8Array, input: unknown): Promise<ImportSnapshot['rows']> {
  const selection = validated(fileImportSelectionSchema, input, 'invalid-selection');
  const output = collector(selection, selection.format === 'csv' ? 'file' : 'sheet');
  await fileCells(bytes, selection, cells => output.add(cells, selection.format === 'xlsx'));
  try {
    return output.finish();
  } catch (error) {
    if (error instanceof TableImportError) throw error;
    throw new TableImportError('malformed-file');
  }
}

/** Reads the file's rows of cells in order until visit returns false. */
async function fileCells(
  bytes: Uint8Array,
  selection: FileImportSelection,
  visit: (cells: Scalar[]) => boolean | void,
) {
  if (!bytes.byteLength || bytes.byteLength > importLimits.bytes) throw new TableImportError('byte-limit');
  try {
    if (selection.format === 'csv') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parser = parse({
        bom: true,
        delimiter: selection.delimiter,
        relax_column_count: true,
        max_record_size: 1024 * 1024,
      });
      Readable.from([text]).pipe(parser);
      for await (const row of parser)
        if (visit(validated(csvRowSchema, row, 'column-limit')) === false) {
          parser.destroy();
          return;
        }
    } else {
      await checkArchive(bytes);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.read(Readable.from([Buffer.from(bytes)]));
      const sheet = workbook.getWorksheet(selection.sheet);
      if (!sheet) throw new TableImportError('invalid-selection');
      if (sheet.rowCount > importLimits.rows + 1) throw new TableImportError('row-limit');
      if (sheet.columnCount > importLimits.columns) throw new TableImportError('column-limit');
      for (let index = 1; index <= sheet.rowCount; index++) {
        const row = sheet.getRow(index);
        const cells: Scalar[] = [];
        for (let column = 1; column <= row.cellCount; column++) {
          const cell = row.getCell(column);
          const raw = cell.value;
          if (cell.isMerged || (raw !== null && typeof raw === 'object' && !(raw instanceof Date)))
            throw new TableImportError('unsupported-cell');
          cells.push(raw ?? null);
        }
        if (visit(cells) === false) return;
      }
    }
  } catch (error) {
    if (error instanceof TableImportError) throw error;
    throw new TableImportError('malformed-file');
  }
}

function integrationRows(result: unknown, selection: IntegrationSelection) {
  let target = result;
  for (const part of selection.path) {
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, part))
      throw new TableImportError('invalid-selection');
    target = validated(z.record(z.string(), z.unknown()), target, 'invalid-selection')[part];
  }
  const entries =
    selection.format === 'object'
      ? [target]
      : validated(
          z.array(z.unknown()).max(importLimits.rows + (selection.format === 'matrix' ? 1 : 0)),
          target,
          'row-limit',
        );
  const output = collector(
    selection.format === 'matrix'
      ? selection
      : { ...selection, header: { kind: 'provided', names: selection.columns } },
    'source',
  );
  const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
  for (const entry of entries) {
    if (selection.format === 'matrix') output.add(validated(z.array(scalar).max(64), entry, 'malformed-row'));
    else {
      const row = validated(z.record(z.string(), z.unknown()), entry, 'malformed-row');
      if (selection.columns.some(column => !Object.hasOwn(row, column))) throw new TableImportError('malformed-row');
      output.add(selection.columns.map(column => validated(scalar, row[column], 'unsupported-cell')));
    }
  }
  return output.finish();
}

type SnapshotBytes = Pick<AttachmentBytes, 'putIfAbsent' | 'read'>;
export type TableImportOptions = {
  attachments: Pick<AttachmentBytes, 'read'>;
  snapshots: SnapshotBytes;
  requireSources(tx: TableTransaction, actor: HumanActor, sources: readonly SourceDependency[]): Promise<void>;
};
const toolSchema = z.enum(['github.issue.read', 'google.read', 'atlassian.read']);
type ImportTool = z.infer<typeof toolSchema>;
export type ImportCaptureContext = {
  workspaceId: string;
  actor: HumanActor;
  origin: ImportOrigin;
  resultId: string;
  tool: ImportTool;
};
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: z.uuid(),
  conversationId: z.uuid(),
  turnId: z.uuid(),
  membershipId: z.uuid(),
  userId: z.string(),
  resultId: z.uuid(),
  tool: toolSchema,
  sources: sourceDependenciesSchema.min(1),
  result: z.unknown(),
  selection: integrationImportSelectionSchema,
});

export function createTableImports(options: TableImportOptions) {
  async function owned(tx: TableTransaction, actor: HumanActor, origin: ImportOrigin) {
    await requireNoMcpDerived(tx, [
      { kind: 'private-conversation', conversationId: origin.conversationId },
      ...origin.sources,
    ]);
    await lockAuthorization(tx);
    await currentMember(tx, actor);
    const allowed = await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'tf_conversations')} c
      JOIN ${table(tx, 'tf_conversation_turns')} t ON t.conversation_id=c.id
      JOIN ${table(tx, 'tf_conversation_messages')} m ON m.id=t.source_message_id AND m.conversation_id=c.id
      WHERE c.id=$1 AND c.kind='private' AND c.owner_user_id=$2 AND c.owner_membership_id=$3
        AND t.id=$4 AND m.author_kind='human' AND m.membership_id=$3 AND t.status NOT IN ('cancelled','blocked')`,
      [z.uuid().parse(origin.conversationId), actor.userId, actor.membershipId, z.uuid().parse(origin.turnId)],
    );
    if (!allowed.rowCount) throw new AccessDenied();
    await options.requireSources(tx, actor, origin.sources);
  }
  async function attachment(
    tx: TableTransaction,
    actor: HumanActor,
    origin: ImportOrigin,
    reference: Extract<ImportReference, { kind: 'file' }>,
  ) {
    const result = await tx.client.query(
      `SELECT a.object_key,a.size,a.sha256 FROM ${table(tx, 'tf_conversation_attachments')} a
      JOIN ${table(tx, 'tf_conversation_parts')} p ON p.attachment_id=a.id AND p.conversation_id=a.conversation_id AND p.message_id=a.message_id
      WHERE a.id=$1 AND a.conversation_id=$2 AND a.membership_id=$3 AND a.sha256=$4 AND a.state='bound'`,
      [reference.attachmentId, origin.conversationId, actor.membershipId, reference.contentDigest],
    );
    if (!result.rowCount) throw new AccessDenied();
    return validated(
      z.object({ object_key: z.uuid(), size: z.int().positive().max(importLimits.bytes), sha256: digestSchema }),
      result.rows[0],
      'byte-limit',
    );
  }
  const fileKey = (
    tx: TableTransaction,
    actor: HumanActor,
    origin: ImportOrigin,
    reference: Extract<ImportReference, { kind: 'file' }>,
  ) =>
    `${tx.workspaceId}/${objectPrefix}/${actor.membershipId}/${origin.conversationId}/${origin.turnId}/file-${reference.attachmentId}-${reference.contentDigest}.json`;
  const resultKey = (tx: TableTransaction, actor: HumanActor, origin: ImportOrigin, id: string) =>
    `${tx.workspaceId}/${objectPrefix}/${actor.membershipId}/${origin.conversationId}/result-${id}.json`;
  async function reserve(
    tx: TableTransaction,
    actor: HumanActor,
    origin: ImportOrigin,
    key: string,
    kind: ImportReference['kind'],
    referenceId: string,
  ) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_table_import_objects')}(object_key,membership_id,conversation_id,turn_id,kind,reference_id)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(object_key) DO NOTHING`,
      [key, actor.membershipId, origin.conversationId, origin.turnId, kind, referenceId],
    );
    await retain(tx, key);
  }
  async function retain(tx: TableTransaction, key: string) {
    const result = await tx.client.query(
      `UPDATE ${table(tx, 'tf_table_import_objects')} SET last_used_at=clock_timestamp()
      WHERE object_key=$1 AND cleanup_pending_at IS NULL RETURNING object_key`,
      [key],
    );
    if (!result.rowCount) throw new TableImportError('snapshot-unavailable');
  }
  async function readBytes(key: string) {
    const lengthBytes = await options.snapshots.read(`${key}.length`, 8);
    const encoded = new TextDecoder('utf-8', { fatal: true }).decode(lengthBytes);
    if (!/^[0-9]{8}$/.test(encoded)) throw new TableImportError('snapshot-unavailable');
    const length = Number(encoded);
    if (length < 1 || length > importLimits.bytes) throw new TableImportError('byte-limit');
    const bytes = await options.snapshots.read(key, length);
    if (bytes.byteLength !== length) throw new TableImportError('byte-limit');
    return bytes;
  }
  async function save(key: string, payload: unknown) {
    const bytes = Buffer.from(canonicalJson(payload));
    if (bytes.byteLength > importLimits.bytes) throw new TableImportError('byte-limit');
    await options.snapshots.putIfAbsent(key, bytes);
    await options.snapshots.putIfAbsent(`${key}.length`, Buffer.from(String(bytes.byteLength).padStart(8, '0')));
    if (sha(await readBytes(key)) !== sha(bytes)) throw new TableImportError('snapshot-conflict');
    return sha(bytes);
  }
  async function receipt(
    tx: TableTransaction,
    origin: ImportOrigin,
    resultId: string,
    tool: ImportTool | null,
    status: 'running' | 'completed',
  ) {
    const row = (
      await tx.client.query(
        `SELECT tool,turn_id FROM ${table(tx, 'tf_conversation_tool_calls')}
      WHERE id=$1 AND conversation_id=$2 AND status=$3 AND ($4::text IS NULL OR tool=$4)`,
        [resultId, origin.conversationId, status, tool],
      )
    ).rows[0];
    if (!row) throw new AccessDenied();
    return validated(z.object({ tool: toolSchema, turn_id: z.uuid() }), row, 'snapshot-unavailable');
  }
  return {
    prepareFile: (
      runtime: TableRuntime,
      workspaceId: string,
      actor: HumanActor,
      origin: ImportOrigin,
      input: unknown,
      decision: unknown,
      fields: string[][] = [],
    ) =>
      safe(async () => {
        const reference = validated(referenceSchema, input, 'invalid-selection');
        if (reference.kind !== 'file') throw new TableImportError('invalid-selection');
        const selection = validated(fileImportPreparationSchema, decision, 'invalid-selection');
        await runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await owned(tx, actor, origin);
          // The reference names no file of the requester's in this chat: a wrong ID or digest, not a denial.
          await attachment(tx, actor, origin, reference).catch(error => {
            throw error instanceof AccessDenied ? new TableImportError('attachment-unknown') : error;
          });
          await reserve(tx, actor, origin, fileKey(tx, actor, origin, reference), 'file', reference.attachmentId);
        });
        return runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await owned(tx, actor, origin);
          await retain(tx, fileKey(tx, actor, origin, reference));
          const stored = await attachment(tx, actor, origin, reference);
          const bytes = await options.attachments.read(`${tx.workspaceId}/${stored.object_key}`, stored.size);
          if (bytes.byteLength !== stored.size || sha(bytes) !== reference.contentDigest)
            throw new TableImportError('digest-mismatch');
          await save(fileKey(tx, actor, origin, reference), await fitFileImportSelection(bytes, selection, fields));
          return reference;
        });
      }),
    // Install only around invokeWithSources for an explicitly requested import read.
    captureIntegration: (
      runtime: TableRuntime,
      context: ImportCaptureContext,
      decision: unknown,
      invokeWithSources: () => Promise<{ result: unknown; sources: SourceDependency[] }>,
    ) =>
      safe(async (): Promise<ImportReference> => {
        const { actor, origin } = context;
        const workspaceId = z.uuid().parse(context.workspaceId);
        const resultId = z.uuid().parse(context.resultId);
        const tool = toolSchema.parse(context.tool);
        const selection = validated(integrationImportSelectionSchema, decision, 'invalid-selection');
        const authorize = async (tx: TableTransaction) => {
          await owned(tx, actor, origin);
          const call = await receipt(tx, origin, resultId, tool, 'running');
          if (call.turn_id !== origin.turnId) throw new AccessDenied();
        };
        await runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await authorize(tx);
          await reserve(tx, actor, origin, resultKey(tx, actor, origin, resultId), 'integration', resultId);
        });
        const response = await invokeWithSources();
        const sources = validated(
          sourceDependenciesSchema.min(1),
          mergeSources([...origin.sources, ...response.sources]),
          'snapshot-unavailable',
        );
        const providerKind = {
          'github.issue.read': 'github-source',
          'google.read': 'google-integration',
          'atlassian.read': 'atlassian-source',
        }[tool];
        if (!response.sources.some(source => source.kind === providerKind)) throw new AccessDenied();
        const envelope = validated(
          envelopeSchema,
          {
            version: 1,
            workspaceId,
            conversationId: origin.conversationId,
            turnId: origin.turnId,
            membershipId: actor.membershipId,
            userId: actor.userId,
            resultId,
            tool,
            sources,
            result: response.result,
            selection,
          },
          'snapshot-unavailable',
        );
        if (Buffer.byteLength(canonicalJson(envelope)) > importLimits.bytes) throw new TableImportError('byte-limit');
        integrationRows(envelope.result, selection);
        return runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await authorize(tx);
          await retain(tx, resultKey(tx, actor, origin, resultId));
          await options.requireSources(tx, actor, sources);
          await requireNoMcpDerived(tx, sources);
          const contentDigest = await save(resultKey(tx, actor, origin, resultId), envelope);
          return { kind: 'integration', resultId, contentDigest };
        });
      }),
    readSnapshot: (tx: TableTransaction, actor: HumanActor, origin: ImportOrigin, input: ImportReference) =>
      safe(async (): Promise<ImportSnapshot> => {
        const reference = validated(referenceSchema, input, 'invalid-selection');
        await owned(tx, actor, origin);
        await retain(
          tx,
          reference.kind === 'file'
            ? fileKey(tx, actor, origin, reference)
            : resultKey(tx, actor, origin, reference.resultId),
        );
        if (reference.kind === 'file') {
          const stored = await attachment(tx, actor, origin, reference);
          const { selection, adjustments } = validated(
            preparedFileSchema,
            JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(fileKey(tx, actor, origin, reference))),
            ),
            'invalid-selection',
          );
          const bytes = await options.attachments.read(`${tx.workspaceId}/${stored.object_key}`, stored.size);
          if (bytes.byteLength !== stored.size || sha(bytes) !== reference.contentDigest)
            throw new TableImportError('digest-mismatch');
          return {
            contentDigest: reference.contentDigest,
            sources: [{ kind: 'private-conversation', conversationId: origin.conversationId }],
            rows: await parseImportFile(bytes, selection),
            ...(adjustments.length ? { adjustments } : {}),
          };
        }
        const call = await receipt(tx, origin, reference.resultId, null, 'completed');
        const bytes = await readBytes(resultKey(tx, actor, origin, reference.resultId));
        if (sha(bytes) !== reference.contentDigest) throw new TableImportError('digest-mismatch');
        const snapshot = validated(
          envelopeSchema,
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          'snapshot-unavailable',
        );
        if (
          snapshot.workspaceId !== tx.workspaceId ||
          snapshot.conversationId !== origin.conversationId ||
          snapshot.membershipId !== actor.membershipId ||
          snapshot.userId !== actor.userId ||
          snapshot.resultId !== reference.resultId ||
          snapshot.tool !== call.tool ||
          snapshot.turnId !== call.turn_id
        )
          throw new AccessDenied();
        await options.requireSources(tx, actor, snapshot.sources);
        await requireNoMcpDerived(tx, snapshot.sources);
        return {
          contentDigest: reference.contentDigest,
          sources: snapshot.sources,
          rows: integrationRows(snapshot.result, snapshot.selection),
        };
      }),
  };
}

export async function requireImportFiles(tx: TableTransaction, actor: HumanActor, fileIds: string[]): Promise<void> {
  return safe(async () => {
    const ids = validated(z.array(z.uuid()).max(256), fileIds, 'invalid-value');
    await lockAuthorization(tx);
    await currentMember(tx, actor);
    const runtime: TableRuntime = {
      transaction: async (workspaceId, range, operation) => {
        if (workspaceId !== tx.workspaceId || tx.commonVersion < range.minimum || tx.commonVersion > range.maximum)
          throw new AccessDenied();
        return operation(tx);
      },
    };
    const files = createFiles(runtime, {
      read: async () => {
        throw new AccessDenied();
      },
      putIfAbsent: async () => {
        throw new AccessDenied();
      },
      remove: async () => {
        throw new AccessDenied();
      },
    });
    for (const id of new Set(ids)) {
      const file = await files.read(tx.workspaceId, actor.userId, id);
      if (file.kind !== 'file' || file.trashed) throw new AccessDenied();
    }
  });
}

export function createTableImportObjectCleanup(runtime: TableRuntime, snapshots: Pick<AttachmentBytes, 'remove'>) {
  return async (workspaceId: string) => {
    const pending = await runtime.transaction(workspaceId, commonCompatibility, async tx =>
      z.array(z.object({ object_key: z.string() })).parse(
        (
          await tx.client.query(`SELECT object_key FROM ${table(tx, 'tf_table_import_objects')}
        WHERE cleanup_pending_at IS NOT NULL AND removed_at IS NULL ORDER BY cleanup_pending_at,object_key LIMIT 10`)
        ).rows,
      ),
    );
    for (const row of pending) {
      if (!row.object_key.startsWith(`${z.uuid().parse(workspaceId)}/${objectPrefix}/`))
        throw new Error('table-import-cleanup-key');
      await snapshots.remove(row.object_key);
      await snapshots.remove(`${row.object_key}.length`);
      await runtime.transaction(workspaceId, commonCompatibility, tx =>
        tx.client.query(
          `UPDATE ${table(tx, 'tf_table_import_objects')}
        SET removed_at=clock_timestamp() WHERE object_key=$1 AND cleanup_pending_at IS NOT NULL AND removed_at IS NULL`,
          [row.object_key],
        ),
      );
    }
    return pending.length ? ('more' as const) : ('completed' as const);
  };
}
