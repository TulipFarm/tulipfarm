import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { PersistedRun } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgConversationRepo } from "../chat/conversations";
import { PgMessageRepo } from "../chat/messages";
import { ConversationService } from "../conversations/service";
import { PgConversationStore } from "../conversations/store.pg";
import type { Queryable } from "../db";
import { makeMigratedPglite } from "../test/pglite";
import { McpHostContextResolver } from "./mcp-context";

describe("persisted native MCP audience", () => {
  let database: PGlite;
  let db: Queryable & {
    transaction<T>(operation: (transaction: Queryable) => Promise<T>): Promise<T>;
  };
  let store: PgConversationStore;

  beforeEach(async () => {
    database = await makeMigratedPglite();
    db = {
      query: (sql, values) => database.query(sql, values ? [...values] : undefined),
      transaction: (operation) =>
        database.transaction((transaction) =>
          operation({
            query: (sql, values) => transaction.query(sql, values ? [...values] : undefined),
          })
        ),
    };
    store = new PgConversationStore(
      db,
      (queryable) => new PgMessageRepo(queryable),
      (queryable) => new PgConversationRepo(queryable)
    );
  });

  afterEach(async () => {
    await database.close();
  });

  it.each([
    { provider: "slack", audience: "shared", visibility: "shared" },
    { provider: "github", audience: "shared", visibility: "shared" },
    { provider: "slack", audience: undefined, visibility: "shared" },
    { provider: "github", audience: "unknown", visibility: "shared" },
    { provider: undefined, audience: undefined, visibility: "private" },
  ])(
    "resolves $provider audience $audience before delivery correlation as $visibility",
    async ({ provider, audience, visibility }) => {
      const conversationId = randomUUID();
      const principalId = randomUUID();
      const now = new Date();
      const service = new ConversationService({
        store,
        runs: {
          start: async () => {
            throw new Error("Run launch is outside this reservation");
          },
        },
        authorize: async () => ({
          businessId: DEPLOYMENT_BUSINESS_ID,
          principal: principalId,
          abilities: ["start_turn"],
        }),
        newId: randomUUID,
        now: () => now,
      });
      const reservation = await service.reserveTurn({
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId,
        content: "Read the selected ticket.",
        idempotencyKey: randomUUID(),
        newConversation: {
          id: conversationId,
          userId: principalId,
          createdAt: now,
          updatedAt: now,
        },
        ...(provider === undefined
          ? {}
          : {
              requestMetadata: {
                nativeChannel: {
                  provider,
                  ...(audience === undefined ? {} : { audience }),
                  eventId: "event-1",
                  integrationId: "native-1",
                  routeId: "route-1",
                },
              },
            }),
      });
      expect(reservation.runId).toBeNull();
      if (provider !== undefined) {
        expect(
          (await store.listMessages(DEPLOYMENT_BUSINESS_ID, conversationId))[0]?.metadata
        ).toMatchObject({
          turnRequest: {
            nativeChannel: { provider, ...(audience === undefined ? {} : { audience }) },
          },
        });
      }
      const run: PersistedRun = {
        id: randomUUID(),
        businessId: DEPLOYMENT_BUSINESS_ID,
        source: "conversation",
        bundle: { digest: "bundle-1", routineId: "chat", routineVersion: "1" },
        identity: {
          initiator: { kind: "user", id: principalId },
          effectiveSubject: { kind: "user", id: principalId },
          guardrailContextRef: "guard-1",
        },
        status: "running",
        version: 1,
        createdAt: now.toISOString(),
        startedAt: now.toISOString(),
        finishedAt: null,
        resultArtifactId: null,
        errorEvidenceRef: null,
        leaseOwner: "worker",
        leaseGeneration: 1,
        leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      };
      const resolver = new McpHostContextResolver({
        businessId: DEPLOYMENT_BUSINESS_ID,
        db,
        runs: {
          find: async (_businessId, id) => (id === run.id ? run : null),
          listLineage: async () => [],
        },
        turns: {
          findTurnByRunId: async (_businessId, id) => {
            if (id !== run.id) return undefined;
            const turn = await store.findTurn(DEPLOYMENT_BUSINESS_ID, reservation.turnId);
            return turn ? { ...turn, runId: run.id } : undefined;
          },
        },
        conversations: new PgConversationRepo(db),
        accounts: { list: async () => [], grants: async () => [] },
        accountAuthority: {
          resolveForRefresh: async () => {
            throw new Error("Chat audience resolution does not refresh an account");
          },
          resolve: async () => {
            throw new Error("Chat audience resolution does not select an account");
          },
        },
        nativeRoutes: { routineRoutes: async () => [], findByRun: async () => undefined },
        activeBundle: async () => undefined,
        bundles: { load: async () => undefined },
      });
      await expect(
        resolver.chatContext(
          { kind: "user", id: principalId, businessId: DEPLOYMENT_BUSINESS_ID },
          conversationId,
          {
            businessId: DEPLOYMENT_BUSINESS_ID,
            integrationKey: "example",
            definitionDigest: "a".repeat(64),
          }
        )
      ).resolves.toMatchObject({ visibility });
      await expect(resolver.knowledgeReaderForRun(run.id)).resolves.toBe(
        visibility === "private" ? principalId : undefined
      );
    }
  );
});
