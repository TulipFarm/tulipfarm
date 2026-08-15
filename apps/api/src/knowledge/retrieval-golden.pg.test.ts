// Golden retrieval eval: a fixed corpus + query→expected-page set with a recall@5 gate. Shared with
// Plan 3 (semantic search) so the lexical spine has a regression baseline to compare against.

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PageRetrievalService } from "./page-search-adapter";
import { DEFAULT_RANKING } from "./retrieval-config";

interface Page {
  path: string;
  title: string;
  body: string;
}

// A small, distinctive engineering knowledge base.
const CORPUS: Page[] = [
  {
    path: "pg-pooling",
    title: "Postgres Connection Pooling",
    body: "pgbouncer transaction mode max connections",
  },
  {
    path: "k8s-deploy",
    title: "Kubernetes Deployment Guide",
    body: "kubectl rollout pods replicas",
  },
  { path: "incident", title: "Incident Response Playbook", body: "pager escalation severity sev1" },
  {
    path: "oauth",
    title: "OAuth2 Authentication Flow",
    body: "authorization code grant token refresh",
  },
  { path: "redis", title: "Redis Caching Strategy", body: "cache eviction ttl invalidation" },
  { path: "graphql", title: "GraphQL Schema Design", body: "resolvers mutations subscriptions" },
  { path: "ci", title: "CI Pipeline Configuration", body: "github actions workflow runners" },
  {
    path: "migration",
    title: "Database Migration Runbook",
    body: "schema version idempotent rollback",
  },
  {
    path: "ratelimit",
    title: "Rate Limiting Middleware",
    body: "token bucket sliding window throttle",
  },
  {
    path: "observability",
    title: "Observability and Tracing",
    body: "opentelemetry spans metrics dashboards",
  },
  { path: "flags", title: "Feature Flag Rollout", body: "gradual percentage targeting toggles" },
  { path: "secrets", title: "Secrets Management", body: "envelope encryption kek dek rotation" },
  {
    path: "websocket",
    title: "WebSocket Connection Handling",
    body: "heartbeat reconnect backpressure",
  },
  {
    path: "ranking",
    title: "Search Ranking Tuning",
    body: "tsvector ts_rank recency decay weights",
  },
];

// query → the path it should retrieve (mix of title terms and distinctive body terms).
const GOLDEN: Array<[string, string]> = [
  ["connection pooling", "pg-pooling"],
  ["kubectl rollout", "k8s-deploy"],
  ["incident escalation", "incident"],
  ["oauth token refresh", "oauth"],
  ["cache eviction", "redis"],
  ["graphql resolvers", "graphql"],
  ["github actions workflow", "ci"],
  ["migration rollback", "migration"],
  ["rate limiting throttle", "ratelimit"],
  ["opentelemetry tracing", "observability"],
  ["feature flag rollout", "flags"],
  ["envelope encryption", "secrets"],
  ["websocket reconnect", "websocket"],
  ["ranking recency decay", "ranking"],
];

describe("golden retrieval eval (recall@5)", () => {
  let db: PGlite;
  let svc: PageRetrievalService;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    const spaceId = randomUUID();
    await db.query(
      `INSERT INTO knowledge_spaces (id, name, description, created_at, updated_at)
       VALUES ($1, 'engineering', NULL, now(), now())`,
      [spaceId]
    );
    for (const p of CORPUS) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO knowledge_pages
           (id, title, content, plain_text, source, source_id, tags, active, always_load_for_agents,
            version, space_id, path, frontmatter_extra, created_at, updated_at)
         VALUES ($1,$2,$3,$3,'authored',$4,'{}',true,false,1,$5,$6,'{}'::jsonb,now(),now())`,
        [id, p.title, p.body, `okf:${spaceId}:${p.path}`, spaceId, p.path]
      );
      await db.query(
        `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, embedding, tsv, model, dim, created_at)
         VALUES ($1,$2,0,$3,NULL,to_tsvector('english',$3),'m',3,now())`,
        [randomUUID(), id, `${p.title}. ${p.body}`]
      );
    }
    svc = new PageRetrievalService(db, { ...DEFAULT_RANKING, trgmFallback: true });
  });
  afterEach(async () => {
    await db.close();
  });

  it("retrieves the expected page within the top 5 for the golden query set", async () => {
    let hits = 0;
    const misses: string[] = [];
    for (const [query, expected] of GOLDEN) {
      const top5 = (await svc.searchPages({ query, filters: {}, limit: 5 })).map((h) => h.path);
      if (top5.includes(expected)) hits += 1;
      else misses.push(`${query} → expected ${expected}, got [${top5.join(", ")}]`);
    }
    const recall = hits / GOLDEN.length;
    // The corpus is distinctive enough that recall@5 should be effectively perfect.
    expect(
      recall,
      `recall@5=${recall.toFixed(2)}; misses:\n${misses.join("\n")}`
    ).toBeGreaterThanOrEqual(0.9);
  });
});
