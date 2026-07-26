import { canonicalHash } from "@tulipfarm/schema";
import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterRequest,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import { POSTGRES_TOOL_IDS } from "./contracts";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type PostgresGrantAction = "read" | "insert" | "update" | "delete";

export interface PostgresIntegrationGrant {
  readonly integrationId: string;
  readonly schema: string;
  readonly table: string;
  readonly actions: readonly PostgresGrantAction[];
  readonly columns: readonly string[];
  readonly rowScope?: {
    readonly column: string;
    readonly value: unknown;
  };
  readonly maximumRows: number;
}

export interface PostgresAdapterContext {
  readonly integrationId: string;
  readonly grant: PostgresIntegrationGrant;
}

export interface PostgresAdapterContextResolver {
  resolve(intent: ToolIntent): Promise<PostgresAdapterContext | undefined>;
}

export interface PostgresQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
}

export interface PostgresIntegrationSession {
  query(text: string, params?: readonly unknown[]): Promise<PostgresQueryResult>;
  withTransaction<T>(callback: (transaction: PostgresIntegrationSession) => Promise<T>): Promise<T>;
}

export interface PostgresConnectionPort {
  withCredential<T>(
    credential: string,
    callback: (session: PostgresIntegrationSession) => Promise<T>
  ): Promise<T>;
}

export interface PostgresIdempotencyPort {
  begin(
    session: PostgresIntegrationSession,
    idempotencyKey: string
  ): Promise<
    | { readonly outcome: "started" }
    | { readonly outcome: "duplicate"; readonly result: PostgresQueryResult }
  >;
  complete(
    session: PostgresIntegrationSession,
    idempotencyKey: string,
    result: PostgresQueryResult
  ): Promise<PostgresQueryResult>;
}

export type PostgresTransactionFailurePhase = "before_commit" | "commit_unknown";

/** Concrete connection ports classify transaction failures without exposing SQL or Credentials. */
export class PostgresTransactionError extends Error {
  readonly name = "PostgresTransactionError";

  constructor(
    readonly phase: PostgresTransactionFailurePhase,
    readonly code: "network" | "timeout"
  ) {
    super(`postgres_transaction:${phase}:${code}`);
  }
}

export interface PostgresAdapterDependencies {
  readonly context: PostgresAdapterContextResolver;
  readonly connection: PostgresConnectionPort;
  readonly idempotency: PostgresIdempotencyPort;
  readonly timeoutMs: number;
}

interface EqualityFilter {
  readonly column: string;
  readonly equals: unknown;
}

interface ReadArguments {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly where: readonly EqualityFilter[];
  readonly limit: number;
}

interface MutationArguments {
  readonly operation: "insert" | "update" | "delete";
  readonly schema: string;
  readonly table: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly where: readonly EqualityFilter[];
  readonly returning: readonly string[];
}

type PreparedOperation =
  | {
      readonly kind: "read";
      readonly input: ReadArguments;
      readonly grant: PostgresIntegrationGrant;
    }
  | {
      readonly kind: "mutation";
      readonly input: MutationArguments;
      readonly grant: PostgresIntegrationGrant;
    };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_identifier", false);
  }
  return value;
}

function identifierList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  const identifiers = value.map(identifier);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return identifiers;
}

function filters(value: unknown): EqualityFilter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value.map((candidate) => {
    const input = record(candidate);
    if (!Object.hasOwn(input, "equals")) {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    return { column: identifier(input.column), equals: input.equals };
  });
}

function readArguments(intent: ToolIntent): ReadArguments {
  const input = record(intent.arguments);
  const limit = input.limit;
  if (!Number.isInteger(limit) || Number(limit) <= 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return {
    schema: identifier(input.schema),
    table: identifier(input.table),
    columns: identifierList(input.columns),
    where: filters(input.where),
    limit: Number(limit),
  };
}

function mutationArguments(intent: ToolIntent): MutationArguments {
  const input = record(intent.arguments);
  if (!["insert", "update", "delete"].includes(String(input.operation))) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  const operation = input.operation as MutationArguments["operation"];
  const values = input.values === undefined ? {} : record(input.values);
  if ((operation === "insert" || operation === "update") && Object.keys(values).length === 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return {
    operation,
    schema: identifier(input.schema),
    table: identifier(input.table),
    values,
    where: filters(input.where),
    returning: identifierList(input.returning),
  };
}

function quote(value: string): string {
  return `"${value}"`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalHash(left) === canonicalHash(right);
}

function scopedFilters(
  requested: readonly EqualityFilter[],
  grant: PostgresIntegrationGrant
): EqualityFilter[] {
  for (const filter of requested) {
    if (!grant.columns.includes(filter.column)) {
      throw new AdapterDispatchError("before_dispatch", "column_denied", false);
    }
  }
  if (grant.rowScope === undefined) return [...requested];
  const declared = requested.find((filter) => filter.column === grant.rowScope?.column);
  if (declared !== undefined && !sameValue(declared.equals, grant.rowScope.value)) {
    throw new AdapterDispatchError("before_dispatch", "row_denied", false);
  }
  return declared === undefined
    ? [{ column: grant.rowScope.column, equals: grant.rowScope.value }, ...requested]
    : [...requested];
}

function assertColumns(columns: readonly string[], grant: PostgresIntegrationGrant): void {
  if (columns.some((column) => !grant.columns.includes(column))) {
    throw new AdapterDispatchError("before_dispatch", "column_denied", false);
  }
}

function assertMutationInput(input: MutationArguments, grant: PostgresIntegrationGrant): void {
  const valueColumns = Object.keys(input.values).map(identifier);
  assertColumns(valueColumns, grant);
  if (
    (input.operation === "insert" || input.operation === "update") &&
    grant.rowScope !== undefined
  ) {
    const existing = input.values[grant.rowScope.column];
    if (existing !== undefined && !sameValue(existing, grant.rowScope.value)) {
      throw new AdapterDispatchError("before_dispatch", "row_denied", false);
    }
  }
  if (input.operation !== "insert") scopedFilters(input.where, grant);
}

function assertGrant(
  intent: ToolIntent,
  context: PostgresAdapterContext,
  schema: string,
  table: string,
  action: PostgresGrantAction
): PostgresIntegrationGrant {
  const { grant } = context;
  const target = intent.targetRefs.find((candidate) => candidate.type === "postgres.table");
  if (
    context.integrationId !== grant.integrationId ||
    grant.schema !== schema ||
    grant.table !== table ||
    target?.id !== `${schema}.${table}` ||
    !grant.actions.includes(action) ||
    !Number.isInteger(grant.maximumRows) ||
    grant.maximumRows <= 0 ||
    grant.columns.length === 0 ||
    new Set(grant.columns).size !== grant.columns.length ||
    grant.columns.some((column) => !IDENTIFIER.test(column)) ||
    (grant.rowScope !== undefined &&
      (!IDENTIFIER.test(grant.rowScope.column) || !grant.columns.includes(grant.rowScope.column)))
  ) {
    throw new AdapterDispatchError("before_dispatch", "postgres_access_denied", false);
  }
  return grant;
}

function whereSql(filtersToApply: readonly EqualityFilter[], params: unknown[]): string {
  if (filtersToApply.length === 0) return "";
  const clauses = filtersToApply.map((filter) => {
    params.push(filter.equals);
    return `${quote(filter.column)} = $${params.length}`;
  });
  return ` WHERE ${clauses.join(" AND ")}`;
}

function sanitizeRows(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[]
): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      columns.filter((column) => Object.hasOwn(row, column)).map((column) => [column, row[column]])
    )
  );
}

export class PostgresAdapter implements ToolAdapter {
  constructor(private readonly dependencies: PostgresAdapterDependencies) {}

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    if (credential === undefined || credential === "") {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }
    const context = await this.resolveContext(request.intent);
    const operation = this.prepare(request.intent, context);
    const mutating = operation.kind === "mutation";
    try {
      return await this.dependencies.connection.withCredential(credential, (session) =>
        session.withTransaction(async (transaction) => {
          await transaction.query("SELECT set_config('statement_timeout', $1, true)", [
            `${this.dependencies.timeoutMs}ms`,
          ]);
          return operation.kind === "mutation"
            ? this.mutate(transaction, request, operation.input, operation.grant)
            : this.read(transaction, operation.input, operation.grant);
        })
      );
    } catch (error) {
      if (error instanceof AdapterDispatchError) throw error;
      if (error instanceof PostgresTransactionError) {
        if (error.phase === "commit_unknown") {
          throw new AdapterDispatchError(
            "after_dispatch",
            "postgres_commit_ambiguous",
            false,
            request.idempotencyKey
          );
        }
        throw new AdapterDispatchError(
          "before_dispatch",
          error.code === "timeout" ? "postgres_timeout" : "postgres_unavailable",
          false
        );
      }
      throw new AdapterDispatchError(
        mutating ? "after_dispatch" : "before_dispatch",
        "postgres_adapter_error",
        false,
        mutating ? request.idempotencyKey : undefined
      );
    }
  }

  private async resolveContext(intent: ToolIntent): Promise<PostgresAdapterContext> {
    try {
      const context = await this.dependencies.context.resolve(intent);
      if (context !== undefined) return context;
    } catch {
      // Default-deny below without exposing the resolver failure.
    }
    throw new AdapterDispatchError("before_dispatch", "postgres_access_denied", false);
  }

  private prepare(intent: ToolIntent, context: PostgresAdapterContext): PreparedOperation {
    if (intent.action === POSTGRES_TOOL_IDS.read) {
      const input = readArguments(intent);
      const grant = assertGrant(intent, context, input.schema, input.table, "read");
      assertColumns(input.columns, grant);
      if (input.limit > grant.maximumRows) {
        throw new AdapterDispatchError("before_dispatch", "result_limit_exceeded", false);
      }
      scopedFilters(input.where, grant);
      return { kind: "read", input, grant };
    }
    if (intent.action === POSTGRES_TOOL_IDS.mutate) {
      const input = mutationArguments(intent);
      const grant = assertGrant(intent, context, input.schema, input.table, input.operation);
      assertColumns(input.returning, grant);
      assertMutationInput(input, grant);
      return { kind: "mutation", input, grant };
    }
    throw new AdapterDispatchError("before_dispatch", "unsupported_action", false);
  }

  private async read(
    session: PostgresIntegrationSession,
    input: ReadArguments,
    grant: PostgresIntegrationGrant
  ): Promise<PostgresQueryResult> {
    const params: unknown[] = [];
    const where = whereSql(scopedFilters(input.where, grant), params);
    params.push(input.limit);
    const result = await session.query(
      `SELECT ${input.columns.map(quote).join(", ")} FROM ${quote(input.schema)}.${quote(
        input.table
      )}${where} LIMIT $${params.length}`,
      params
    );
    if (result.rows.length > input.limit || result.rows.length > grant.maximumRows) {
      throw new AdapterDispatchError("after_dispatch", "result_limit_exceeded", false);
    }
    const rows = sanitizeRows(result.rows, input.columns);
    return { rows, rowCount: rows.length };
  }

  private async mutate(
    session: PostgresIntegrationSession,
    request: ToolAdapterRequest,
    input: MutationArguments,
    grant: PostgresIntegrationGrant
  ): Promise<PostgresQueryResult> {
    const begun = await this.dependencies.idempotency.begin(session, request.idempotencyKey);
    if (begun.outcome === "duplicate") return begun.result;

    const result = await this.executeMutation(session, input, grant);
    if (result.rows.length > grant.maximumRows || result.rowCount > grant.maximumRows) {
      throw new AdapterDispatchError("after_dispatch", "result_limit_exceeded", false);
    }
    const output = {
      rows: sanitizeRows(result.rows, input.returning),
      rowCount: result.rowCount,
    };
    return this.dependencies.idempotency.complete(session, request.idempotencyKey, output);
  }

  private async executeMutation(
    session: PostgresIntegrationSession,
    input: MutationArguments,
    grant: PostgresIntegrationGrant
  ): Promise<PostgresQueryResult> {
    const table = `${quote(input.schema)}.${quote(input.table)}`;
    const returning = ` RETURNING ${input.returning.map(quote).join(", ")}`;
    if (input.operation === "insert") {
      const values = { ...input.values };
      if (grant.rowScope !== undefined) {
        const existing = values[grant.rowScope.column];
        if (existing !== undefined && !sameValue(existing, grant.rowScope.value)) {
          throw new AdapterDispatchError("before_dispatch", "row_denied", false);
        }
        values[grant.rowScope.column] = grant.rowScope.value;
      }
      const columns = Object.keys(values).map(identifier).sort();
      assertColumns(columns, grant);
      const params = columns.map((column) => values[column]);
      const placeholders = params.map((_value, index) => `$${index + 1}`);
      return session.query(
        `INSERT INTO ${table} (${columns.map(quote).join(", ")}) VALUES (${placeholders.join(
          ", "
        )})${returning}`,
        params
      );
    }

    const whereFilters = scopedFilters(input.where, grant);
    if (whereFilters.length === 0) {
      throw new AdapterDispatchError("before_dispatch", "row_scope_required", false);
    }
    if (input.operation === "delete") {
      const params: unknown[] = [];
      return session.query(
        `DELETE FROM ${table}${whereSql(whereFilters, params)}${returning}`,
        params
      );
    }

    const columns = Object.keys(input.values).map(identifier).sort();
    assertColumns(columns, grant);
    const params = columns.map((column) => input.values[column]);
    const assignments = columns.map((column, index) => `${quote(column)} = $${index + 1}`);
    return session.query(
      `UPDATE ${table} SET ${assignments.join(", ")}${whereSql(whereFilters, params)}${returning}`,
      params
    );
  }
}
