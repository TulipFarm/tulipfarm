import type { PGlite } from "@electric-sql/pglite";
import { KV_TOOLS, KvService, PgKvRepo } from "@tulipfarm/kv";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import {
  AUTHORIZATION_STORAGE_STATEMENTS,
  PgGroupRepo,
  PgPrincipalRepo,
  PgRoleRepo,
} from "@tulipfarm/storage";
import {
  defineApiTool,
  InMemoryToolCatalog,
  LiveAuthorityLayerResolver,
  LiveToolGate,
  ok,
  RegistryToolDispatcher,
  type RequestContext,
  type ToolDef,
  type TurnAuthority,
  toToolDef,
} from "@tulipfarm/tool-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../db";
import { makeMigratedPglite } from "../test/pglite";

/**
 * The durable runtime hosts KV Tools itself, composing the dispatcher without a `SoulLoader`,
 * without a renderer registry and without provider credentials. That reduced composition is the
 * part that can silently go wrong in either direction — deny everything, or authorize everything —
 * so this exercises it against real migrations, real principal/Role rows and the real gate.
 */

const BUSINESS_ID = "tulipfarm-local";
const USER_ID = "44444444-4444-4444-4444-444444444444";
const RUN_ID = "run-colocated-1";

function authority(overrides: Partial<TurnAuthority> = {}): TurnAuthority {
  return {
    businessId: BUSINESS_ID,
    runId: RUN_ID,
    turn: { id: "turn-1", conversationId: "conversation-1", attempt: 1 },
    subject: { kind: "user", id: USER_ID },
    source: "chat",
    bundleDigest: "sha256:bundle",
    ...overrides,
  };
}

/** The chat request Artifact the dispatcher reads for autonomy and agent id. */
function fakeArtifacts(content: unknown = { autonomy: "full" }): ArtifactService {
  return { read: async () => ({ content }) } as unknown as ArtifactService;
}

function kvCatalog(service: KvService): InMemoryToolCatalog {
  const catalog = new InMemoryToolCatalog();
  for (const definition of KV_TOOLS) {
    catalog.register(
      toToolDef(definition, (ctx: RequestContext) => ({
        userId: ctx.userId,
        service,
        ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
      }))
    );
  }
  return catalog;
}

describe("co-located KV dispatch (worker composition)", () => {
  let db: PGlite;
  let dispatcher: RegistryToolDispatcher;
  let kv: KvService;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    for (const statement of AUTHORIZATION_STORAGE_STATEMENTS) {
      await db.exec(statement).catch(() => undefined);
    }

    const transactions = transactionPort(db);
    const principals = new PgPrincipalRepo(transactions);
    const roles = new PgRoleRepo(transactions);
    await principals.put({ businessId: BUSINESS_ID, id: USER_ID, kind: "user", status: "active" });
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "member",
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [
        { action: "kv.set", resourceType: "platform.kv", effect: "allow" },
        { action: "kv.get", resourceType: "platform.kv", effect: "allow" },
      ],
    });
    await roles.assign({ businessId: BUSINESS_ID, principalId: USER_ID, roleId: "member" });

    kv = new KvService(new PgKvRepo(db));
    dispatcher = new RegistryToolDispatcher({
      registry: kvCatalog(kv),
      artifacts: fakeArtifacts(),
      gate: new LiveToolGate(),
      authorityLayers: new LiveAuthorityLayerResolver({
        principals,
        roles,
        groups: new PgGroupRepo(transactions),
      }),
      localDispatchOnly: true,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it("authorizes and executes a write, then reads it back, with no Soul and no renderer", async () => {
    const written = await dispatcher.dispatch(authority(), {
      callId: "call-1",
      name: "kv_set",
      arguments: { namespace: "prefs", key: "theme", value: { mode: "dark" } },
    });
    expect(written.status).toBe("succeeded");

    const read = await dispatcher.dispatch(authority(), {
      callId: "call-2",
      name: "kv_get",
      arguments: { namespace: "prefs", key: "theme" },
    });

    expect(read).toMatchObject({
      status: "succeeded",
      output: { found: true, namespace: "prefs", key: "theme", value: { mode: "dark" } },
    });
  });

  it("denies a principal the durable Role rows do not authorize", async () => {
    const result = await dispatcher.dispatch(
      authority({ subject: { kind: "user", id: "55555555-5555-5555-5555-555555555555" } }),
      { callId: "call-3", name: "kv_set", arguments: { namespace: "n", key: "k", value: 1 } }
    );

    expect(result.status).toBe("denied");
  });

  it("refuses any Tool that is not co-locatable, even when it is in the catalog", async () => {
    const catalog = kvCatalog(kv);
    const soulScoped: ToolDef = toToolDef(
      defineApiTool({
        name: "create_record",
        description: "a Soul-scoped Tool",
        tier: "platform",
        mutating: true,
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        authorization: { action: "record.create", resources: ["resource.ticket"] },
        handler: async () => ok({}),
      }),
      () => ({})
    );
    catalog.register(soulScoped);

    const guarded = new RegistryToolDispatcher({
      registry: catalog,
      artifacts: fakeArtifacts(),
      gate: new LiveToolGate(),
      authorityLayers: { resolvePrincipalLayer: async () => ({ name: "user", grants: [] }) },
      localDispatchOnly: true,
    });

    const result = await guarded.dispatch(authority(), {
      callId: "call-4",
      name: "create_record",
      arguments: {},
    });

    expect(result).toMatchObject({ status: "denied" });
    expect(result.status === "denied" && result.reason).toContain("soul_scoped_resource");
  });

  it("refuses to be composed at all without a gate", () => {
    expect(
      () =>
        new RegistryToolDispatcher({
          registry: kvCatalog(kv),
          artifacts: fakeArtifacts(),
          localDispatchOnly: true,
        })
    ).toThrow(/requires both a ToolGate and an authority layer source/);
  });
});
