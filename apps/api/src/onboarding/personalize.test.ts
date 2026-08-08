import type { LlmService } from "@tulipfarm/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KvEntry, KvRepo, KvScope } from "../kv/repo";
import { KvService } from "../kv/service";

// Mock the AI SDK so no real model is invoked. `jsonSchema` is kept real (pure wrapper).
const generateObject = vi.fn();
vi.mock("ai", async (orig) => {
  const actual = await orig<typeof import("ai")>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObject(...args) };
});

import { buildStateKey, getPersonalizedOnboarding, type PersonalizeSoulSlice } from "./personalize";

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

describe("getPersonalizedOnboarding", () => {
  beforeEach(() => generateObject.mockReset());

  it("returns null with no businessDescription (static fallback)", async () => {
    const kvService = new KvService(new FakeKvRepo());
    const result = await getPersonalizedOnboarding(soul({ resources: ["tickets"] }), {
      llmService,
      kvService,
    });
    expect(result).toBeNull();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("returns null with no llmService", async () => {
    const kvService = new KvService(new FakeKvRepo());
    const result = await getPersonalizedOnboarding(soul({ businessDescription: "a SaaS" }), {
      kvService,
    });
    expect(result).toBeNull();
  });

  it("calls the LLM, returns + caches the result, and skips the LLM on the next call", async () => {
    generateObject.mockResolvedValue({ object: VALID });
    const kvService = new KvService(new FakeKvRepo());
    const s = soul({ businessDescription: "a SaaS for tickets", businessName: "Acme" });

    const first = await getPersonalizedOnboarding(s, { llmService, kvService });
    expect(first).toEqual(VALID);
    expect(generateObject).toHaveBeenCalledOnce();
    const call = generateObject.mock.calls[0][0];
    expect(call.prompt).toContain("Acme");
    expect(call.prompt).toContain("a SaaS for tickets");

    const second = await getPersonalizedOnboarding(s, { llmService, kvService });
    expect(second).toEqual(VALID);
    expect(generateObject).toHaveBeenCalledOnce(); // served from cache
  });

  it("repairs a complete fenced JSON response from providers without structured outputs", async () => {
    generateObject.mockResolvedValue({ object: VALID });

    const result = await getPersonalizedOnboarding(
      soul({ businessDescription: "an online store" }),
      {
        llmService,
        kvService: new KvService(new FakeKvRepo()),
      }
    );

    expect(result).toEqual(VALID);
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

  it("returns null when the LLM output is malformed / the call fails (static fallback)", async () => {
    generateObject.mockResolvedValue({ object: { suggestions: "nope" } });
    const kvService = new KvService(new FakeKvRepo());
    const result = await getPersonalizedOnboarding(soul({ businessDescription: "a SaaS" }), {
      llmService,
      kvService,
    });
    expect(result).toBeNull();
  });
});
