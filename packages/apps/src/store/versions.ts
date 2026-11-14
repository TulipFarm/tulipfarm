import { createHash, randomUUID } from 'node:crypto';
import { appLimits, type AppFailure, type AppFailureCode } from '../app.ts';
import { checkAppDefinition, type AppDefinition, type AppDefinitionIssue } from '../definition.ts';
import type { AppGeneration, AppId, AppOperationId, AppVersionId, MembershipId } from '../ids.ts';
import { appRole } from './grants.ts';
import { readOperation, type AppOperation } from './operations.ts';
import { failed, rows, table, type AppTransaction } from './sql.ts';

/** A published, immutable copy of a private app's pages. */
export type AppVersion = {
  readonly id: AppVersionId;
  readonly appId: AppId;
  readonly number: number;
  readonly digest: string;
  readonly publishedBy: MembershipId;
  readonly publishedAt: string;
  readonly live: boolean;
};

export type AppVersionList = {
  /** The generation a publish or restore must name to replace what this list shows. */
  readonly generation: AppGeneration;
  readonly versions: AppVersion[];
};

export type AppReferenceKind = 'table' | 'field' | 'file' | 'workflow' | 'agent';
/** A workspace record a definition names, as `<kind>:<id>`. */
export type AppReference = `${AppReferenceKind}:${string}`;

/**
 * A publish or restore either makes a new live version or changes nothing. A failed check carries every issue to
 * fix; `superseded` means another publish or restore went first, and `stale-draft` that the draft changed since the
 * editor reviewed it.
 */
export type AppVersionResult =
  | { readonly ok: true; readonly operation: AppOperation; readonly version: AppVersion }
  | { readonly ok: false; readonly failure: AppFailure; readonly issues: AppDefinitionIssue[] };

type Request = {
  readonly appId: AppId;
  readonly requestId: string;
  readonly requestedBy: MembershipId;
  /** The generation the editor last saw in the version list. */
  readonly generation: number;
};

type VersionRow = {
  id: string;
  app_id: string;
  number: number;
  digest: string;
  published_by: string;
  created_at: Date;
  live: boolean;
};

const versionOf = (row: VersionRow): AppVersion => ({
  id: row.id as AppVersionId,
  appId: row.app_id as AppId,
  number: row.number,
  digest: row.digest,
  publishedBy: row.published_by as MembershipId,
  publishedAt: row.created_at.toISOString(),
  live: row.live,
});

const versionColumns = (tx: AppTransaction) =>
  `v.id, v.app_id, v.number, v.digest, v.published_by, v.created_at,
   v.id IS NOT DISTINCT FROM (SELECT live_version_id FROM ${table(tx, 'tf_apps')} WHERE id = v.app_id) AS live`;

/** The retained versions, newest first, and the generation that fences the next publish or restore. */
export async function listAppVersions(tx: AppTransaction, appId: AppId): Promise<AppVersionList> {
  const [app] = await rows<{ release_generation: string }>(
    tx,
    `SELECT release_generation FROM ${table(tx, 'tf_apps')} WHERE id = $1`,
    [appId],
  );
  const found = await rows<VersionRow>(
    tx,
    `SELECT ${versionColumns(tx)} FROM ${table(tx, 'tf_app_versions')} v WHERE v.app_id = $1 ORDER BY v.number DESC`,
    [appId],
  );
  return { generation: Number(app?.release_generation ?? 0) as AppGeneration, versions: found.map(versionOf) };
}

/** The live version's pages, which viewers see. */
export async function readLiveDefinition(tx: AppTransaction, appId: AppId): Promise<AppDefinition | null> {
  return (await readLiveVersion(tx, appId))?.definition ?? null;
}

/** The live version's id and pages, or null before the first publish. */
export async function readLiveVersion(
  tx: AppTransaction,
  appId: AppId,
): Promise<{ readonly versionId: string; readonly definition: AppDefinition } | null> {
  const [row] = await rows<{ versionId: string; definition: AppDefinition }>(
    tx,
    `SELECT v.id AS "versionId", v.definition FROM ${table(tx, 'tf_app_versions')} v
     JOIN ${table(tx, 'tf_apps')} a ON a.live_version_id = v.id WHERE a.id = $1`,
    [appId],
  );
  return row ?? null;
}

/** The saved draft's pages, or null while the draft has none. Not checked: an edit run may have saved anything. */
export async function readDraftDefinition(tx: AppTransaction, appId: AppId): Promise<unknown> {
  const [row] = await rows<{ definition: unknown }>(
    tx,
    `SELECT definition FROM ${table(tx, 'tf_app_drafts')} WHERE app_id = $1`,
    [appId],
  );
  return row?.definition ?? null;
}

/**
 * Records references a version names that no longer exist and returns the ones recorded for the first time, so a
 * caller tells editors about each broken reference once.
 */
export async function recordBrokenReferences(
  tx: AppTransaction,
  versionId: string,
  references: readonly AppReference[],
): Promise<AppReference[]> {
  if (!references.length) return [];
  return (
    await rows<{ reference: AppReference }>(
      tx,
      `INSERT INTO ${table(tx, 'tf_app_broken_references')} (version_id, reference)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING RETURNING reference`,
      [versionId, references],
    )
  ).map(({ reference }) => reference);
}

/** Publishes the saved draft as the next numbered version and makes it live at once. */
export async function publishAppVersion(
  tx: AppTransaction,
  input: Request & { readonly revision: number },
): Promise<AppVersionResult> {
  return admitVersion(tx, input, 'publish', async () => {
    const [draft] = await rows<{ revision: string; definition: unknown }>(
      tx,
      `SELECT revision, definition FROM ${table(tx, 'tf_app_drafts')} WHERE app_id = $1`,
      [input.appId],
    );
    if (!draft || Number(draft.revision) !== input.revision)
      return refused('stale-draft', 'The draft changed since you reviewed it. Review it again, then publish.');
    if (draft.definition === null) return invalid([{ path: '', message: 'The draft has no pages yet' }]);
    return { ok: true, definition: draft.definition };
  });
}

/** Publishes a copy of a retained version as the next numbered version. Grants are not part of a version. */
export async function restoreAppVersion(
  tx: AppTransaction,
  input: Request & { readonly versionId: AppVersionId },
): Promise<AppVersionResult> {
  return admitVersion(tx, input, 'rollback', async () => {
    const [version] = await rows<{ definition: unknown }>(
      tx,
      `SELECT definition FROM ${table(tx, 'tf_app_versions')} WHERE id = $1 AND app_id = $2`,
      [input.versionId, input.appId],
    );
    if (!version) return refused('not-found', 'Version not found');
    return { ok: true, definition: version.definition };
  });
}

type Refusal = Exclude<AppVersionResult, { ok: true }>;
type Source = { readonly ok: true; readonly definition: unknown } | Refusal;

const refused = (code: AppFailureCode, message: string, issues: AppDefinitionIssue[] = []): Refusal => ({
  ...failed(code, message),
  issues,
});
const invalid = (issues: AppDefinitionIssue[]) =>
  refused('definition-invalid', 'Fix the listed issues, then publish', issues);

/**
 * Checks the definition, then claims the next generation only if it is still the one the editor saw. A concurrent
 * publish or restore that claimed it first makes this one `superseded`; the row lock the claim takes orders version
 * numbers. A repeated request returns the version it made.
 */
async function admitVersion(
  tx: AppTransaction,
  request: Request,
  kind: 'publish' | 'rollback',
  source: () => Promise<Source>,
): Promise<AppVersionResult> {
  const [app] = await rows<{ kind: string; archived_at: Date | null }>(
    tx,
    `SELECT kind, archived_at FROM ${table(tx, 'tf_apps')} WHERE id = $1`,
    [request.appId],
  );
  if (!app || app.archived_at || app.kind !== 'private') return refused('not-found', 'App not found');
  const repeat = await repeated(tx, request);
  if (repeat) return repeat;
  if ((await appRole(tx, request.appId, request.requestedBy)) !== 'edit')
    return refused('forbidden', 'You need edit access to this app');

  const chosen = await source();
  if (!chosen.ok) return chosen;
  const checked = checkAppDefinition(chosen.definition);
  if (!checked.ok) return invalid(checked.issues);
  const missing = await missingReferences(tx, appDefinitionReferences(checked.definition));
  if (missing.length) return invalid(missing);

  const versionId = randomUUID();
  const [claimed] = await rows<{ release_generation: string }>(
    tx,
    `UPDATE ${table(tx, 'tf_apps')} SET release_generation = release_generation + 1, live_version_id = $3
     WHERE id = $1 AND release_generation = $2 AND archived_at IS NULL RETURNING release_generation`,
    [request.appId, request.generation, versionId],
  );
  if (!claimed)
    return (
      (await repeated(tx, request)) ??
      refused('superseded', 'Someone published or restored a newer version. Reload the versions and try again.')
    );

  const definition = canonicalJson(checked.definition);
  const [version] = await rows<VersionRow>(
    tx,
    `INSERT INTO ${table(tx, 'tf_app_versions')} (id, app_id, number, definition, digest, published_by)
     SELECT $1, $2, COALESCE(MAX(number), 0) + 1, $3, $4, $5 FROM ${table(tx, 'tf_app_versions')} WHERE app_id = $2
     RETURNING id, app_id, number, digest, published_by, created_at, true AS live`,
    [versionId, request.appId, definition, createHash('sha256').update(definition).digest('hex'), request.requestedBy],
  );
  const [operation] = await rows<{ id: string }>(
    tx,
    `INSERT INTO ${table(tx, 'tf_app_operations')}
       (id, app_id, request_id, requested_by, kind, generation, target_version_id, status, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'switched', clock_timestamp()) RETURNING id`,
    [randomUUID(), request.appId, request.requestId, request.requestedBy, kind, claimed.release_generation, versionId],
  );
  await tx.client.query(`DELETE FROM ${table(tx, 'tf_app_versions')} WHERE app_id = $1 AND number <= $2`, [
    request.appId,
    version!.number - appLimits.retainedVersions,
  ]);
  return {
    ok: true,
    operation: (await readOperation(tx, operation!.id as AppOperationId))!,
    version: versionOf(version!),
  };
}

async function repeated(tx: AppTransaction, request: Request): Promise<AppVersionResult | null> {
  const [row] = await rows<{ id: string; app_id: string; target_version_id: string | null }>(
    tx,
    `SELECT id, app_id, target_version_id FROM ${table(tx, 'tf_app_operations')}
     WHERE requested_by = $1 AND request_id = $2`,
    [request.requestedBy, request.requestId],
  );
  if (!row) return null;
  const [version] = row.target_version_id
    ? await rows<VersionRow>(
        tx,
        `SELECT ${versionColumns(tx)} FROM ${table(tx, 'tf_app_versions')} v WHERE v.id = $1`,
        [row.target_version_id],
      )
    : [];
  if (row.app_id !== request.appId || !version) return refused('not-found', 'Version not found');
  return { ok: true, operation: (await readOperation(tx, row.id as AppOperationId))!, version: versionOf(version) };
}

/** Every workspace record the definition names, with the first place it names it. */
export function appDefinitionReferences(definition: AppDefinition): { reference: AppReference; path: string }[] {
  const found = new Map<AppReference, string>();
  const add = (reference: AppReference, path: string) => {
    if (!found.has(reference)) found.set(reference, path);
  };
  definition.pages.forEach((page, pageIndex) => {
    const at = `/pages/${pageIndex}`;
    if (page.row) add(`table:${page.row.tableId}`, `${at}/row/tableId`);
    page.sources.forEach((source, index) => {
      const path = `${at}/sources/${index}`;
      if (source.kind === 'rows' || source.kind === 'summary') {
        add(`table:${source.tableId}`, `${path}/tableId`);
        for (const fieldId of queryFieldIds(source.query)) add(`field:${fieldId}`, `${path}/query`);
      }
      if (source.kind === 'file') add(`file:${source.fileId}`, `${path}/fileId`);
    });
    page.actions.forEach((action, index) => {
      const path = `${at}/actions/${index}`;
      if (action.kind === 'run-workflow') add(`workflow:${action.workflowId}`, `${path}/workflowId`);
      if (action.kind === 'ask-agent') add(`agent:${action.agentId}`, `${path}/agentId`);
    });
  });
  return [...found].map(([reference, path]) => ({ reference, path }));
}

/** Field IDs a table query names in its filter, sort, selection, grouping or metrics. */
function queryFieldIds(query: unknown): string[] {
  const ids: string[] = [];
  const visit = (value: unknown, key?: string) => {
    if (typeof value === 'string' && key === 'fieldId') ids.push(value);
    else if (Array.isArray(value))
      for (const item of value) visit(item, key === 'select' || key === 'groupBy' ? 'fieldId' : undefined);
    else if (value && typeof value === 'object')
      for (const [name, item] of Object.entries(value as Record<string, unknown>)) visit(item, name);
  };
  visit(query);
  return ids;
}

/** The references that no longer name a live record, as issues at the place the definition uses them. */
async function missingReferences(
  tx: AppTransaction,
  references: { reference: AppReference; path: string }[],
): Promise<AppDefinitionIssue[]> {
  const absent = await absentReferences(
    tx,
    references.map(({ reference }) => reference),
  );
  return references
    .filter(({ reference }) => absent.has(reference))
    .map(({ reference, path }) => {
      const [kind, id] = reference.split(':');
      return { path, message: `The ${kind} ${id} no longer exists` };
    });
}

/** The references that name a table, field, file, workflow or agent that no longer exists. */
export async function absentReferences(
  tx: AppTransaction,
  references: readonly AppReference[],
): Promise<Set<AppReference>> {
  if (!references.length) return new Set();
  const [present] = await rows<{ present: AppReference[] }>(
    tx,
    `SELECT ARRAY(
       SELECT 'table:' || id FROM ${table(tx, 'tf_table_catalog')} WHERE archived_at IS NULL
         AND 'table:' || id = ANY($1)
       UNION ALL
       SELECT 'field:' || (f->>'id') FROM ${table(tx, 'tf_table_catalog')} c,
         jsonb_array_elements(COALESCE(c.applied_definition->'fields', '[]')) f
         WHERE c.archived_at IS NULL AND 'field:' || (f->>'id') = ANY($1)
       UNION ALL
       SELECT 'file:' || id FROM ${table(tx, 'tf_files')} WHERE kind = 'file' AND trashed_at IS NULL
         AND 'file:' || id = ANY($1)
       UNION ALL
       SELECT 'workflow:' || id FROM ${table(tx, 'tf_workflows')} WHERE archived_at IS NULL
         AND 'workflow:' || id = ANY($1)
       UNION ALL
       SELECT 'agent:' || id FROM ${table(tx, 'tf_agents')} WHERE deleted_at IS NULL AND archived_at IS NULL
         AND 'agent:' || id = ANY($1)
     ) AS present`,
    [references],
  );
  const live = new Set(present!.present);
  return new Set(references.filter(reference => !live.has(reference)));
}

/** JSON with sorted object keys, so the same pages always store and digest the same way. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
