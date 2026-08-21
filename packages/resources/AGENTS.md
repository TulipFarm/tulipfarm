# Resources (`@tulipfarm/resources`)

Deep domain module for Record write policy and mutation orchestration.

## Read on / Skip

- **Read on if** changing Record validation, transforms, hooks, idempotency, or mutation outcomes.
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
