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
  ) {
    super(code);
  }
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
export const fileImportSelectionSchema = z.discriminatedUnion('format', [
  z.strictObject({ format: z.literal('csv'), delimiter: z.enum([',', ';', '\t', '|']), ...tabular }),
  z.strictObject({ format: z.literal('xlsx'), sheet: z.string().min(1).max(31), ...tabular }),
]);
export type FileImportSelection = z.infer<typeof fileImportSelectionSchema>;
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
function collector(selection: Pick<FileImportSelection, 'header' | 'conversions' | 'empty'>) {
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
        throw new TableImportError('malformed-row');
      rows.push(
        Object.fromEntries(
          names.map((name, index) => [
            name,
            value(
              cells[index] ?? null,
              Object.hasOwn(selection.conversions, name) ? (selection.conversions[name] ?? 'text') : 'text',
              selection.empty,
            ),
          ]),
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

export async function parseImportFile(bytes: Uint8Array, input: unknown): Promise<ImportSnapshot['rows']> {
  const selection = validated(fileImportSelectionSchema, input, 'invalid-selection');
  if (!bytes.byteLength || bytes.byteLength > importLimits.bytes) throw new TableImportError('byte-limit');
  const output = collector(selection);
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
      for await (const row of parser) output.add(validated(csvRowSchema, row, 'column-limit'));
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
        output.add(cells, true);
      }
    }
    return output.finish();
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
    ) =>
      safe(async () => {
        const reference = validated(referenceSchema, input, 'invalid-selection');
        if (reference.kind !== 'file') throw new TableImportError('invalid-selection');
        const selection = validated(fileImportSelectionSchema, decision, 'invalid-selection');
        await runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await owned(tx, actor, origin);
          await attachment(tx, actor, origin, reference);
          await reserve(tx, actor, origin, fileKey(tx, actor, origin, reference), 'file', reference.attachmentId);
        });
        return runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await owned(tx, actor, origin);
          await retain(tx, fileKey(tx, actor, origin, reference));
          const stored = await attachment(tx, actor, origin, reference);
          const bytes = await options.attachments.read(`${tx.workspaceId}/${stored.object_key}`, stored.size);
          if (bytes.byteLength !== stored.size || sha(bytes) !== reference.contentDigest)
            throw new TableImportError('digest-mismatch');
          await parseImportFile(bytes, selection);
          await save(fileKey(tx, actor, origin, reference), selection);
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
          const selection = validated(
            fileImportSelectionSchema,
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
