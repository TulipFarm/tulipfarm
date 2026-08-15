import type { KvEntry, KvRepo, KvScope } from "@tulipfarm/kv";
import { KvService } from "@tulipfarm/kv";
import type { LlmService } from "@tulipfarm/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the AI SDK so no real model is invoked. `jsonSchema` is kept real (pure wrapper).
const generateObject = vi.fn();
vi.mock("ai", async (orig) => {
  const actual = await orig<typeof import("ai")>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObject(...args) };
});

import {
  buildStateKey,
  getPersonalizedOrRefresh,
  type PersonalizeSoulSlice,
  readPersonalizedOnboarding,
  refreshPersonalizedOnboarding,
} from "./personalize";

const VALID = {
  suggestions: [
    { id: "tickets", label: "Set up ticket management?", prompt: "Help me set up tickets." },
  ],
  recommendations: [
    {
      id: "agent-for-tickets",
      label: "Create an agent for tickets",
      prompt: "Help me create an agent.",
    },
  ],
};

/** In-memory KvRepo so the real KvService works end-to-end. */
class FakeKvRepo implements KvRepo {
  private rows = new Map<string, KvEntry>();
  private id(scope: KvScope, ownerId: string | undefined, ns: string, key: string) {
    return `${scope} ${ownerId ?? ""} ${ns} ${key}`;
  }
  async upsert(doc: KvEntry) {
    this.rows.set(this.id(doc.scope, doc.ownerId, doc.namespace, doc.key), doc);
  }
  async get(scope: KvScope, ownerId: string | undefined, ns: string, key: string) {
    return this.rows.get(this.id(scope, ownerId, ns, key)) ?? null;
  }
  async delete(scope: KvScope, ownerId: string | undefined, ns: string, key: string) {
    return this.rows.delete(this.id(scope, ownerId, ns, key));
  }
  async listByNamespace(scope: KvScope, ownerId: string | undefined, ns: string) {
    return [...this.rows.values()].filter(
      (e) => e.scope === scope && e.ownerId === ownerId && e.namespace === ns
    );
  }
}

function soul(
  opts: {
    resources?: string[];
    agents?: string[];
    skills?: string[];
    businessName?: string;
    businessDescription?: string;
  } = {}
): PersonalizeSoulSlice {
  const toMap = (names: string[] = []) => new Map(names.map((n) => [n, {}]));
  const manifest =
    opts.businessName || opts.businessDescription
      ? { businessName: opts.businessName, businessDescription: opts.businessDescription }
      : null;
  return {
    resources: toMap(opts.resources),
    agents: toMap(opts.agents),
    skills: toMap(opts.skills),
    manifest,
  } as unknown as PersonalizeSoulSlice;
}

// biome-ignore lint/suspicious/noExplicitAny: dummy model stand-in for the mocked SDK.
const llmService = { effortModel: () => ({}) as any } as unknown as LlmService;

describe("buildStateKey", () => {
  it("is stable for the same inputs", () => {
    const s = { resources: ["a"], agents: [], skills: [] };
    expect(buildStateKey("desc", s)).toBe(buildStateKey("desc", s));
  });

  it("changes when the description or any soul list changes", () => {
    const base = buildStateKey("desc", { resources: ["a"], agents: [], skills: [] });
    expect(buildStateKey("other", { resources: ["a"], agents: [], skills: [] })).not.toBe(base);
    expect(buildStateKey("desc", { resources: ["a", "b"], agents: [], skills: [] })).not.toBe(base);
    expect(buildStateKey("desc", { resources: ["a"], agents: ["x"], skills: [] })).not.toBe(base);
  });
});

describe("readPersonalizedOnboarding", () => {
  beforeEach(() => generateObject.mockReset());

  it("never calls the LLM, even on a cache miss", async () => {
    const kvService = new KvService(new FakeKvRepo());
    const result = await readPersonalizedOnboarding(soul({ businessDescription: "a SaaS" }), {
      llmService,
      kvService,
    });
    expect(result).toBeNull();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("returns a previously cached personalization", async () => {
    generateObject.mockResolvedValue({ object: VALID });
    const kvService = new KvService(new FakeKvRepo());
    const s = soul({ businessDescription: "a SaaS for tickets", businessName: "Acme" });

    await refreshPersonalizedOnboarding(s, { llmService, kvService });
    expect(await readPersonalizedOnboarding(s, { llmService, kvService })).toEqual(VALID);
  });
});

describe("refreshPersonalizedOnboarding", () => {
  beforeEach(() => generateObject.mockReset());

  it("calls the LLM with business context and caches the result", async () => {
    generateObject.mockResolvedValue({ object: VALID });
    const kvService = new KvService(new FakeKvRepo());
    const s = soul({ businessDescription: "a SaaS for tickets", businessName: "Acme" });

    await refreshPersonalizedOnboarding(s, { llmService, kvService });

    expect(generateObject).toHaveBeenCalledOnce();
    const call = generateObject.mock.calls[0][0];
    expect(call.prompt).toContain("Acme");
    expect(call.prompt).toContain("a SaaS for tickets");
    expect(await readPersonalizedOnboarding(s, { llmService, kvService })).toEqual(VALID);
  });

  it("coalesces concurrent refreshes for the same soul state into one LLM call", async () => {
    generateObject.mockResolvedValue({ object: VALID });
    const kvService = new KvService(new FakeKvRepo());
    const s = soul({ businessDescription: "a SaaS" });

    await Promise.all([
      refreshPersonalizedOnboarding(s, { llmService, kvService }),
      refreshPersonalizedOnboarding(s, { llmService, kvService }),
      refreshPersonalizedOnboarding(s, { llmService, kvService }),
    ]);

    expect(generateObject).toHaveBeenCalledOnce();
  });

  it("does nothing without a businessDescription or llmService", async () => {
    const kvService = new KvService(new FakeKvRepo());
    await refreshPersonalizedOnboarding(soul({ resources: ["tickets"] }), {
      llmService,
      kvService,
    });
    await refreshPersonalizedOnboarding(soul({ businessDescription: "a SaaS" }), { kvService });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("swallows a malformed LLM response and caches nothing", async () => {
    generateObject.mockResolvedValue({ object: { suggestions: "nope" } });
    const kvService = new KvService(new FakeKvRepo());
    const s = soul({ businessDescription: "a SaaS" });

    await expect(
      refreshPersonalizedOnboarding(s, { llmService, kvService })
    ).resolves.toBeUndefined();
    expect(await readPersonalizedOnboarding(s, { llmService, kvService })).toBeNull();
  });

  it("repairs a complete fenced JSON response from providers without structured outputs", async () => {
    generateObject.mockResolvedValue({ object: VALID });

    await refreshPersonalizedOnboarding(soul({ businessDescription: "an online store" }), {
      llmService,
      kvService: new KvService(new FakeKvRepo()),
    });

    const options = generateObject.mock.calls[0][0] as {
      experimental_repairText?: (input: { text: string; error: Error }) => Promise<string | null>;
    };
    expect(options.experimental_repairText).toBeTypeOf("function");
    await expect(
      options.experimental_repairText?.({
        text: `\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``,
        error: new Error("JSON parse failed"),
      })
    ).resolves.toBe(JSON.stringify(VALID));
  });
});

describe("getPersonalizedOrRefresh", () => {
  beforeEach(() => generateObject.mockReset());

  it("returns null on a cache miss without waiting for the LLM, then caches in the background", async () => {
    // A model call the test controls: if the request path awaited it, `getPersonalizedOrRefresh`
    // below could not resolve until we release it.
    let release!: (value: unknown) => void;
    generateObject.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const kvService = new KvService(new FakeKvRepo());
    const s = soul({ businessDescription: "a deferred-LLM SaaS" });

    expect(await getPersonalizedOrRefresh(s, { llmService, kvService })).toBeNull();
    expect(generateObject).toHaveBeenCalledOnce(); // refresh started in the background

    release({ object: VALID });
    await refreshPersonalizedOnboarding(s, { llmService, kvService });
    expect(await readPersonalizedOnboarding(s, { llmService, kvService })).toEqual(VALID);
  });

  it("serves the cache once a refresh has completed, without another LLM call", async () => {
    generateObject.mockResolvedValue({ object: VALID });
    const kvService = new KvService(new FakeKvRepo());
    const s = soul({ businessDescription: "a warm-cache SaaS" });

    await refreshPersonalizedOnboarding(s, { llmService, kvService });
    generateObject.mockClear();

    expect(await getPersonalizedOrRefresh(s, { llmService, kvService })).toEqual(VALID);
    expect(generateObject).not.toHaveBeenCalled();
  });
});
