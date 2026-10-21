# Memory Postgres adapters

The Postgres/pgvector/FTS implementation of the
[memory-core ports](../memory-core/README.md). This package owns the extracted
document, retrieval, search-session, lexical/vector, embedding, and
personal-memory storage operations. Provider ACLs and host-only permission
queries remain in Knowledge.

Every factory receives an already-scoped query client and
`{ schema, tablePrefix }`. Factories do not choose a tenant, authorize a
principal, create a pool, or start/commit a transaction. The host supplies
these within its existing runtime and authorization locks.

Knowledge tables use the host's `tf_knowledge_` prefix; personal memory and
conversation storage use `tf_`. Identifiers are escaped and data uses bound
values. Escaping names is not a permission check: only trusted host
composition chooses the schema, prefix, and eligibility SQL callback.

```ts
import { createPostgresMemoryRepository } from '@tulipfarm/memory-postgres';

const repository = createPostgresMemoryRepository(transactionClient, {
  schema: workspaceSchema,
  tablePrefix: 'tf_',
});
```

Return the driver's real results and errors. `rows` and `rowCount` satisfy
the core interface; callers must not depend on driver-private metadata.
Preserve SQL order, parameter identity/order, transaction boundaries,
eligibility predicates, revision/proof bindings, and lease/attempt fencing.
The extracted SQL is deliberately unchanged rather than translated into a
new generic query language.

## Verification

Unit tests check adapter calls. The shared personal-memory conformance
suite also runs against the real factories using disposable, uniquely named
schemas and a nondefault prefix. It requires `TEST_ADMIN_DATABASE_URL`:

```sh
pnpm exec turbo run build --filter=@tulipfarm/memory-postgres
node --test --test-concurrency=1 \
  packages/memory-postgres/test/memory-conformance.integration.mjs
```

Use only a disposable local test cluster. Each conformance schema and
connection is cleaned up by the suite. These minimal port fixtures do not
replace the full-workspace Postgres and Temporal tests in Knowledge,
Conversations, API, and Worker. Phase 1 adds no application migration and
does not change API responses or the default embedding profile.
