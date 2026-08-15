import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the model path's authorization seams.
 *
 * Every finding these assertions encode was a silent gap, not a failing test: governance that
 * read as enforcement but was derived from nothing, and credentials that acted as the deployment
 * for everyone. Silent gaps come back silently, so they are pinned here rather than left to
 * review.
 */

const ROOT = join(import.meta.dirname, "..");

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

describe("model path — authorization fitness", () => {
  it("keeps a principal's model governance on the API→Worker wire", () => {
    // Fastify strips undeclared response properties, so dropping either of these from the schema
    // silently discards the demand instead of failing anywhere.
    const routes = read("apps/api/src/internal/routes.ts");
    expect(routes).toContain("modelPolicy:");
    expect(routes).toContain("principal:");
  });

  it("derives the governance posture a profile declares, so denials can fire", () => {
    // `selectModelProfile` gates residency, retention and training on `profile.constraints`.
    // Nothing derived it before, so every profile read as undeclared and none could ever deny.
    const catalog = read("packages/schema/src/model-catalog.ts");
    expect(catalog).toContain("constraintsFrom");
    expect(catalog).toMatch(/constraints\b/);
  });

  it("gives the turn's governance an authored source on both Agent surfaces", () => {
    // `AGENT.md` frontmatter is `additionalProperties: false`, so an operator can only declare
    // this if the live schema accepts it — the Definition alone would not be reachable.
    expect(read("packages/schema/src/agent.ts")).toContain("modelPolicy");
    expect(read("packages/schema/src/definitions/agent.ts")).toContain("modelPolicy");
  });

  it("lets a model call act as the acting principal, not only as the deployment", () => {
    const provider = read("packages/llm/src/provider.ts");
    expect(provider).toContain("PrincipalCredentialResolver");
    expect(provider).toContain("options.credentials.resolve");
  });

  it("names a principal's sealed credential in exactly one place", () => {
    // The effect plane and the model plane must find the same key; two builders would drift and
    // a credential written by one would be invisible to the other.
    expect(read("apps/api/src/integrations/principal-tokens.ts")).not.toMatch(
      /return `principal\.\$\{/
    );
    expect(read("packages/secrets/src/principal-keys.ts")).toContain("return `principal.");
  });

  it("keeps the model gate wired into the only path that names a model", () => {
    const context = read("apps/api/src/internal/turn-context.ts");
    expect(context).toContain("authorizeModelSelector");
    // The selector must be resolved in exactly one place, inside the gate. A second call site
    // would route around it and reach a provider unasked.
    const calls = context.match(/resolveModelSelector\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const gateAt = context.indexOf("private async authorizeModelSelector");
    expect(gateAt).toBeGreaterThan(-1);
    expect(context.indexOf("resolveModelSelector(request)")).toBeGreaterThan(gateAt);
  });
});

describe("model path — liveness fitness", () => {
  it("bounds every production model port in wall-clock time", () => {
    // Both constructions omitted the optional signal, and the AI SDK sets no default fetch
    // timeout, so a provider that accepted the connection and stopped answering held the Run's
    // lease forever. An optional bound is a bound that gets forgotten.
    const main = read("apps/worker/src/main.ts");
    const ports = main.match(/new LlmModelPort\(\{/g) ?? [];
    expect(ports.length).toBeGreaterThan(0);

    for (const site of main.split("new LlmModelPort({").slice(1)) {
      expect(site.slice(0, 600)).toContain("signal,");
    }
  });

  it("keeps the default wall clock inside the port, not at its call sites", () => {
    const watchdog = read("apps/worker/src/model-watchdog.ts");
    expect(watchdog).toContain("DEFAULT_STALL_TIMEOUT_MS");
    expect(watchdog).toContain("DEFAULT_CALL_TIMEOUT_MS");
    // Signalling the provider is not enough when the provider ignores the signal.
    expect(read("apps/worker/src/model.ts")).toContain("withAbort(result.fullStream");
  });

  it("gates every production model port on the same per-provider limiter", () => {
    // One gate per process, not one per port: two independent gates would each permit the full
    // concurrency cap, so the provider would see twice what was configured.
    const main = read("apps/worker/src/main.ts");
    expect(main.match(/new ProviderGate\(/g)?.length).toBe(1);

    for (const site of main.split("new LlmModelPort({").slice(1)) {
      expect(site.slice(0, 600)).toContain("gate: modelGate,");
    }
  });

  it("reports Worker spend from every production model port", () => {
    // The observability spine had a complete subscriber, metrics and OTLP export, and nothing in
    // production emitted into it: the turn loop moved to the Worker while the emitter stayed in
    // the API as an in-process EventEmitter. Every cost view read zero, which looks exactly like
    // a quiet week. A port constructed without a sink brings that back in silence.
    const main = read("apps/worker/src/main.ts");
    expect(main).toContain("new PgSpendSink(");

    for (const site of main.split("new LlmModelPort({").slice(1)) {
      expect(site.slice(0, 700)).toContain("spend: spendSink,");
    }
    // The turn count and reliability half comes from the executor, not the port.
    expect(main).toContain("spend: spendSink,\n    log: logger,");
  });

  it("only trips the breaker on failures that indict the provider", () => {
    // A missing model or a rejected key is a config error. Counting those would shed a healthy
    // provider for every turn in the process because one Agent named a model that does not exist.
    const gate = read("apps/worker/src/model-gate.ts");
    expect(gate).toContain("INFRASTRUCTURE_FAILURES.has(reason)");
    // The lease must outlive the call, so the slot is held for as long as the provider is busy.
    expect(read("apps/worker/src/model.ts")).toContain("lease?.release();");
  });

  it("forwards the acting principal from every production model port", () => {
    // Dropping the argument in the factory would silently send every call back to acting as the
    // deployment, with the whole credential path still present and passing its own tests.
    const main = read("apps/worker/src/main.ts");
    for (const site of main.split("new LlmModelPort({").slice(1)) {
      expect(site.slice(0, 600)).toContain("principal");
    }
  });
});

describe("the embedding path is metered, bounded and structurally logged", () => {
  it("prices embedding calls into the same table as every other model call", () => {
    // Embeddings were the one metered provider call that no cost view could see. A service built
    // without the sink brings that back in silence — the dashboards would simply read low.
    const index = read("apps/api/src/index.ts");
    expect(index).toContain("new EmbeddingService({");
    expect(index).toContain("usage: createEmbeddingUsageSink(");
    // Pricing stays on the API side, where the operator's overrides live. A second pricing site
    // inside the service is how overrides came to reach only one of two callers before.
    expect(read("packages/llm/src/embeddings.ts")).not.toContain("priceCall");
  });

  it("bounds every embedding call and refuses a failover that would split the corpus", () => {
    const embeddings = read("packages/llm/src/embeddings.ts");
    expect(embeddings).toContain("AbortSignal.timeout(this.timeoutMs)");
    // A standby of a different width writes vectors the next query can never match.
    expect(embeddings).toContain("c.dimension === active.dimension");
  });

  it("decides a re-index from the stored corpus, not only from process memory", () => {
    // The in-memory flag cannot see a dimension change made while the process was down, and that
    // is the case that leaves every stored vector permanently unreachable by vector search.
    const service = read("packages/knowledge/src/service.ts");
    expect(service).toContain("countStaleDimension");
    // Cleared only after the re-index returned: clearing up front loses the signal on a failure.
    expect(service).toMatch(
      /await this\.reindexAll\(\);\s*(\/\/[^\n]*\n\s*)*this\.deps\.embeddings\.clearPendingReindex\(\);/
    );
    expect(read("apps/api/src/index.ts")).toContain("boot re-index check failed");
  });

  it("keeps model-layer logging inside the injected pipeline", () => {
    // A direct console write skips the log viewer and the redaction the pipeline applies.
    const dir = resolve(ROOT, "packages/llm/src");
    const offenders = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) =>
        /\bconsole\.(log|info|warn|error|debug)\(/.test(read(`packages/llm/src/${f}`))
      );
    expect(offenders).toEqual([]);
  });

  it("keeps prompt and business content out of the zero-output diagnostic", () => {
    // This error reaches the operator's process logs. The request body is the assembled prompt and
    // the response body is the model's answer; a digest correlates repeat failures without either.
    const model = read("apps/worker/src/model.ts");
    expect(model).toContain("request=${fingerprint(sdkRequest)}");
    expect(model).toContain("lastMessage: describeMessage(messages.at(-1))");
    expect(model).not.toContain("lastMessage: messages.at(-1)");
  });
});
