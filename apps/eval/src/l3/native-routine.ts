import {
  accountDefinitionForIntegration,
  admitNativeRoutine,
  McpAccountAccessError,
  type McpAccountUseContext,
  mcpServerRevision,
  mcpToolContract,
  NativeRoutineAdmissionError,
} from "@tulipfarm/integrations";
import {
  ArtifactService,
  DurableInvocationGateway,
  InvocationDeniedError,
  PgDurableInvocationStore,
  routineStateDefinitionRef,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import {
  ajv,
  canonicalHash,
  MANUAL_REQUEST_SCHEMA,
  MANUAL_REQUEST_SCHEMA_REF,
  routine,
} from "@tulipfarm/schema";
import {
  ArtifactStore,
  ambientTransactionPort,
  NativeChannelInboxStore,
  type NativeChannelRoutineRoute,
} from "@tulipfarm/storage";
import { stringify } from "yaml";
import type { L3NativeRoutineFixture } from "../case.ts";
import type { EvalSoul } from "../eval-soul.ts";
import type { EvalDatabase } from "./database.ts";
import { evalMcpAccounts } from "./mcp-accounts.ts";
import { EVAL_MCP_SERVER } from "./mcp-provider.ts";
import { SOUL_WRITE_TOOL, soulWriterTool } from "./soul-write.ts";

const ROUTINE_ID = "eb8b34d6-a1b9-45e1-b51f-22a30749e042";
const ROUTINE_SLUG = "eval-native-review";
const EVENT_ID = "eval-native-event";
const BUSINESS_ID = "eval";
const OWNER_ID = "eval";
const isRoutine = ajv.compile<routine.RoutineDefinition>(routine.RoutineDefinitionSchema);

export async function runNativeRoutineAdmission(
  database: EvalDatabase,
  soul: EvalSoul,
  fixture: L3NativeRoutineFixture
) {
  const writes = soulWriterTool(soul);
  try {
    const definitions = await writes.mcpDefinitions();
    const integration = definitions.get(EVAL_MCP_SERVER);
    if (integration === undefined) throw new Error("Native admission needs the Eval MCP server.");
    const capability = integration.reviewed.tools[0];
    if (capability === undefined) throw new Error("Native admission needs a reviewed MCP Tool.");
    const contract = mcpToolContract(EVAL_MCP_SERVER, mcpServerRevision(integration), capability);
    const authored: routine.RoutineDefinition = {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: ROUTINE_ID,
        slug: ROUTINE_SLUG,
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: {
        owner: OWNER_ID,
        start: "Read",
        states: [
          {
            type: "tool",
            name: "Read",
            toolRef: {
              id: contract.metadata.id,
              name: contract.metadata.slug,
              version: String(contract.metadata.authoredVersion),
            },
            action: contract.spec.action,
            input: { probe: "native-admission" },
            destination: fixture.destination,
            end: true,
          },
        ],
      },
    };
    const write = await writes.port.dispatch({
      businessId: BUSINESS_ID,
      runId: "eval-native-setup",
      stateId: "native-routine-publication",
      callId: "native-routine",
      name: SOUL_WRITE_TOOL,
      arguments: {
        kind: "Routine",
        slug: ROUTINE_SLUG,
        definitionMode: "canonical",
        content: stringify(authored),
      },
    });
    if (write.status !== "succeeded") {
      throw new Error(`Native Routine publication failed: ${JSON.stringify(write)}`);
    }
    const bundle = await writes.activeBundle();
    const published = bundle.get("Routine", ROUTINE_SLUG);
    if (published === undefined || !isRoutine(published.document)) {
      throw new Error("Native Routine is absent from the verified active bundle.");
    }
    const definition = published.document;
    await database.query(
      "INSERT INTO users (id, status, role) VALUES ($1, 'active', 'admin') ON CONFLICT DO NOTHING",
      [OWNER_ID]
    );
    const { accounts, authority } = await evalMcpAccounts(database, soul, undefined, {
      visibility: "shared",
      accounts: [
        { id: fixture.accountId, scope: "shared", status: "active" },
        { id: "unapproved-default", scope: "shared", status: "active", isDefault: true },
      ],
    });
    const account = await accounts.get(BUSINESS_ID, fixture.accountId);
    if (account === undefined) throw new Error("Native Routine account was not persisted.");
    const accountDefinition = accountDefinitionForIntegration(integration);
    const destination = {
      id: "eval-native-route",
      businessId: BUSINESS_ID,
      provider: "github" as const,
      integrationId: "github",
      destination: fixture.destination,
      eventType: "issues.opened",
      routineId: published.id,
    };
    const configurationDigest = canonicalHash({
      routine: published.hash,
      tool: contract,
      destination,
      account: { id: account.id, revision: account.revision, ...accountDefinition },
    });
    const context: Extract<McpAccountUseContext, { kind: "routine" }> = {
      kind: "routine",
      businessId: BUSINESS_ID,
      integrationKey: EVAL_MCP_SERVER,
      definitionDigest: accountDefinition.definitionDigest,
      routineId: published.id,
      ownerPrincipalId: definition.spec.owner,
      visibility: "shared",
      accountId: account.id,
      accountRevision: account.revision,
      configurationDigest,
    };
    const granted = await accounts.saveGrant({
      businessId: BUSINESS_ID,
      accountId: account.id,
      accountRevision: account.revision,
      subject: { kind: "routine", id: published.id, configurationDigest },
      grantedBy: OWNER_ID,
      grantedAt: new Date().toISOString(),
    });
    if (!granted) throw new Error("Native Routine account approval was not persisted.");
    const inbox = new NativeChannelInboxStore(database.transactions);
    const approved = {
      definitionRef: `published:routine:${published.slug}`,
      principal: { kind: "user", id: definition.spec.owner },
      configurationDigest: canonicalHash({ context, destination }),
    };
    const route: NativeChannelRoutineRoute = {
      ...destination,
      enabled: true,
      authority: approved,
    };
    await inbox.putRoutineRoute(route);
    const payload = { action: "opened", issue: { number: 42 } };
    await inbox.accept({
      id: EVENT_ID,
      businessId: BUSINESS_ID,
      provider: route.provider,
      integrationId: route.integrationId,
      externalAppId: "eval-github-app",
      externalTenantId: "eval-github-installation",
      deliveryId: "eval-github-delivery",
      payloadDigest: canonicalHash(payload),
      eventType: route.eventType,
      payload,
      binding: { routineRoute: route },
    });
    const [event] = await inbox.claim(
      BUSINESS_ID,
      "eval-native-lease",
      1,
      new Date(Date.now() + 1_000)
    );
    if (event === undefined) throw new Error("Native Routine inbox event was not claimable.");
    if (fixture.fault === "route_changed") {
      await inbox.putRoutineRoute({
        ...route,
        authority: { ...approved, configurationDigest: canonicalHash("changed-route") },
      });
    }
    if (fixture.fault === "account_revoked") {
      await accounts.revokeGrant(BUSINESS_ID, account.id, "routine", published.id);
    }
    const validator = new TypedOutputValidator([
      { ref: MANUAL_REQUEST_SCHEMA_REF, schema: MANUAL_REQUEST_SCHEMA },
    ]);
    const store = new PgDurableInvocationStore(
      database.transactions,
      (transaction) =>
        new ArtifactService(new ArtifactStore(ambientTransactionPort(transaction)), validator)
    );
    const invocations = new DurableInvocationGateway({
      validator,
      store: {
        persist: async (record, transaction) => {
          const result = await store.persist(record, transaction);
          // Lose the inbox fence after Run insertion, not before its initial claim check.
          if (fixture.fault === "lease_lost") {
            await (transaction ?? database.queryable).query(
              "UPDATE native_channel_inbox SET lease_token = 'other-worker' WHERE id = $1",
              [event.id]
            );
          }
          return result;
        },
      },
      routineDefinitions: {
        resolve: async (input) => {
          if (
            input.businessId !== bundle.businessId ||
            input.definitionRef !== approved.definitionRef
          ) {
            return undefined;
          }
          const pin = {
            digest: bundle.digest,
            routineId: published.id,
            routineVersion: String(published.authoredVersion),
          };
          return {
            bundle: pin,
            startState: {
              key: definition.spec.start,
              definitionRef: routineStateDefinitionRef(pin, definition.spec.start),
            },
          };
        },
      },
    });
    let resolvedAccountId: string | null = null;
    const authorizeRoutine = async () => {
      const resolved = await authority.resolve(context);
      resolvedAccountId = resolved.id;
      return approved;
    };
    let denial: string | null = null;
    try {
      await admitNativeRoutine(event, {
        inbox,
        transactions: database.transactions,
        invocations,
        authorizeRoutine,
      });
    } catch (error) {
      if (
        error instanceof McpAccountAccessError ||
        error instanceof InvocationDeniedError ||
        error instanceof NativeRoutineAdmissionError
      ) {
        denial = error.code;
      } else if (error instanceof Error && error.message === "native_delivery_lease_lost") {
        denial = error.message;
      } else {
        throw error;
      }
    }
    const runs = await database.query("SELECT id FROM runs WHERE business_id = $1", [BUSINESS_ID]);
    const states = await database.query("SELECT status FROM run_states WHERE business_id = $1", [
      BUSINESS_ID,
    ]);
    const artifacts = await database.query("SELECT content FROM artifacts WHERE business_id = $1", [
      BUSINESS_ID,
    ]);
    const admissions = await database.query(
      "SELECT run_id FROM durable_invocations WHERE business_id = $1",
      [BUSINESS_ID]
    );
    const storedEvent = await inbox.find(BUSINESS_ID, event.id);
    if (storedEvent === undefined) throw new Error("Native inbox event disappeared.");
    const first = runs.rows[0];
    const run =
      first === undefined ? null : await database.runs.find(BUSINESS_ID, String(first.id));
    const correlated = run === null ? undefined : await inbox.findByRun(BUSINESS_ID, run.id);
    return {
      runCount: runs.rows.length,
      stateCount: states.rows.length,
      artifactCount: artifacts.rows.length,
      invocationCount: admissions.rows.length,
      run,
      stateStatus: states.rows[0]?.status ?? null,
      request: artifacts.rows[0]?.content ?? null,
      accountId: resolvedAccountId,
      inboxRunId: storedEvent.runId,
      inboxCorrelated: correlated?.id === event.id && storedEvent.runId === run?.id,
      error: denial,
    };
  } finally {
    await writes.reset();
    await soul.loader.load();
  }
}
