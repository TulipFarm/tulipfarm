import { randomUUID } from "node:crypto";
import type { PackDefinition } from "@tulipfarm/schema";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import type { UserDoc, UserRepo } from "../auth/users";
import { PackService } from "./service";

class Users implements UserRepo {
  constructor(private readonly user: UserDoc) {}
  async findById(id: string) {
    return id === this.user._id ? this.user : null;
  }
  async findByEmail(email: string) {
    return email === this.user.email ? this.user : null;
  }
  async count() {
    return 1;
  }
  async insert(_user: UserDoc) {}
}
class Tokens implements TokenRepo {
  async create(_token: TokenDoc) {}
  async findByHash() {
    return null;
  }
  async findByUserId() {
    return [];
  }
  async findAll() {
    return [];
  }
  async findById() {
    return null;
  }
  async deleteById() {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}
const skillTemplate = {
  name: "employee-onboarding-procedure",
  frontmatter: { name: "employee-onboarding-procedure", version: "1.0.0", category: "it-ops" },
  body: "# Employee onboarding readiness\n\nConfirm the hiring manager's approved role and start date.",
};
const surfaceTemplate = {
  slug: "employee-onboarding-review",
  version: "1.0",
  description: "Track onboarding readiness without provisioning accounts.",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "records"],
    properties: {
      summary: { type: "string" },
      records: {
        type: "array",
        items: {
          type: "object",
          properties: { employee: { type: "string" }, status: { enum: ["blocked", "ready"] } },
        },
      },
    },
  },
  events: [],
  examples: [
    {
      summary: "Synthetic example.",
      records: [{ employee: "Muskan Vijayvargiya", status: "ready" }],
    },
  ],
  targets: [{ channel: "web", surface: "chat" }],
  views: {
    default: {
      component: { name: "Section", version: "1.0" },
      props: { heading: "Onboarding", body: { $prop: "/summary" } },
      children: [
        {
          component: { name: "RecordTable", version: "1.0" },
          props: { columns: ["employee", "status"], records: { $prop: "/records" } },
        },
      ],
    },
  },
};
const pack: PackDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Pack",
  name: "support",
  version: 1,
  title: "Support",
  description: "Support presets",
  category: "Support",
  artifacts: [
    {
      kind: "resource",
      name: "tickets",
      description: "Tickets",
      template: {
        name: "tickets",
        schema: { type: "object", properties: { title: { type: "string" } } },
      },
    },
    {
      kind: "skill",
      name: "employee-onboarding-procedure",
      description: "Audited onboarding procedure.",
      template: skillTemplate,
    },
    {
      kind: "surface",
      name: "employee-onboarding-review",
      description: "Display-only onboarding review.",
      template: surfaceTemplate,
    },
  ],
  plan: {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Plan",
    name: "support",
    version: 1,
    steps: [
      { id: "Inspect", tool: "list_resource_types" },
      {
        id: "CreateSurface",
        needs: ["Inspect"],
        tool: "surface_component_create",
        input: surfaceTemplate,
      },
      { id: "AuditSkill", needs: ["CreateSurface"], tool: "skill_create", input: skillTemplate },
    ],
  },
};

describe("Pack HTTP preview boundary", () => {
  let app: FastifyInstance;
  let cookies: Record<string, string>;
  let allowed: boolean;
  const send = vi.fn(async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ packs: [] }),
  }));
  const authorize = vi.fn(async () => allowed);
  beforeEach(async () => {
    allowed = true;
    send.mockClear();
    authorize.mockClear();
    const user: UserDoc = {
      _id: randomUUID(),
      email: "muskan@example.com",
      name: "Muskan Vijayvargiya",
      role: "admin",
      status: "active",
      passwordHash: "",
      createdAt: new Date(),
    };
    const sessions = new MemorySessionStore();
    const session = await sessions.create(user._id);
    cookies = { [SESSION_COOKIE]: session, [CSRF_COOKIE]: "csrf-test" };
    app = await buildApp({
      sessionStore: sessions,
      userRepo: new Users(user),
      tokenRepo: new Tokens(),
      routeAuthorizer: { authorize },
      packs: new PackService({ send }),
    });
  });
  afterEach(async () => {
    await app.close();
  });
  const preview = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/v1/packs/preview",
      payload,
      cookies,
      headers: { [CSRF_HEADER]: "csrf-test" },
    });

  it("returns a full typed preview, including nested template data, without fetching", async () => {
    const response = await preview({ yaml: stringify(pack) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      pack,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(response.json().pack).toEqual(pack);
    expect(
      response.json().pack.artifacts[2].template.views.default.children[0].props.records
    ).toEqual({ $prop: "/records" });
    expect(response.json().pack.plan.steps[1].input).toEqual(surfaceTemplate);
    expect(response.json().pack.plan.steps[2].input).toEqual(skillTemplate);
    expect(send).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "platform.plan.declare", resourceType: "platform.plan" })
    );
  });
  it.each([
    {},
    { yaml: "x", url: "https://example.com/pack" },
    { yaml: stringify(pack), confirmed: true },
    { yaml: `${stringify(pack)}\nextra: true` },
  ])("rejects invalid source %j", async (payload) => {
    expect((await preview(payload)).statusCode).toBe(400);
  });
  it("requires authentication and authorization before network reads", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/packs" })).statusCode).toBe(401);
    allowed = false;
    expect((await app.inject({ method: "GET", url: "/api/v1/packs", cookies })).statusCode).toBe(
      403
    );
    expect((await preview({ url: "https://example.com/pack" })).statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
  it("serves the read-only catalog", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/packs", cookies });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ packs: [] });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("returns upstream failures explicitly", async () => {
    send.mockResolvedValueOnce({ status: 503, headers: {}, body: "unavailable" });
    expect((await preview({ url: "https://example.com/pack" })).statusCode).toBe(502);
  });
  it("rejects previews that cannot fit the full-content Chat result contract", async () => {
    const oversized = {
      ...pack,
      artifacts: [{ ...pack.artifacts[0], template: { schema: "x".repeat(40_000) } }],
    };
    const response = await preview({ yaml: stringify(oversized) });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("no partial source was returned");
  });
  it("publishes both protected read-only routes in OpenAPI", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(response.statusCode).toBe(200);
    const paths = response.json().paths;
    expect(paths["/api/v1/packs"].get.security).toEqual([
      { sessionCookie: [] },
      { bearerToken: [] },
    ]);
    expect(paths["/api/v1/packs/preview"].post.responses["502"]).toBeDefined();
  });
});
