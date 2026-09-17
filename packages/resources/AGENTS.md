# Resources (`@tulipfarm/resources`)

Deep domain module for Record write policy and mutation orchestration.

## Read on / Skip

- **Read on if** changing Record validation, transforms, hooks, idempotency, deletion policies, or mutation outcomes.
- **Skip if** changing dynamic SQL, Fastify routes, or sandbox implementation details.

## Map

| Path | Owns |
| --- | --- |
| `src/service.ts` | Command interface, Record write policy, and port-driven mutation orchestration. |
| `src/index.ts` | Public package interface. |

## Rules

- Depend on repository, catalog, clock, and hook ports; never import `apps/*`, Fastify, or sandbox.
- Dynamic Record-table SQL remains in the API adapter after resource-type validation.
- Side effects travel with the mutation port so persistence can enqueue them atomically.
- Storage adapters marked `serializedResourceWrites` run create/update validation and mutation in
  one source-type transaction, using the Resource definition reloaded after its lock is acquired.
- Dependency deletion previews are exact versioned graphs; execution recomputes them inside the
  repository transaction while every Resource table is locked, then refuses stale or partial work.
- A schema-generated human ID is create-only; replace and patch preserve the existing value.
