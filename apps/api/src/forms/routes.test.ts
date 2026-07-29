import {
  FormSubmissionError,
  type FormSubmissionResult,
  type GovernedForm,
} from "@tulipfarm/surface";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import type { FormsRoutesDeps } from "./routes";

const TEST_CSRF = "a".repeat(64);

class FakeUserRepo implements UserRepo {
  private readonly users: UserDoc[] = [];

  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.find((user) => user.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((user) => user._id === id) ?? null;
  }
  async count(): Promise<number> {
    return this.users.length;
  }
  async insert(user: UserDoc): Promise<void> {
    this.users.push(user);
  }
}

class FakeTokenRepo implements TokenRepo {
  async create(): Promise<void> {}
  async findByHash(): Promise<TokenDoc | null> {
    return null;
  }
  async findByUserId(): Promise<TokenDoc[]> {
    return [];
  }
  async findAll(): Promise<TokenDoc[]> {
    return [];
  }
  async findById(): Promise<TokenDoc | null> {
    return null;
  }
  async deleteById(): Promise<void> {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

const form: GovernedForm = {
  id: "expense-request",
  version: "3",
  mode: "standalone",
  schemaRef: "forms/expense-request@3",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { amount: { type: "number" } },
  },
  visibleFields: ["amount"],
  audience: ["user:member"],
  guardrailRevision: "guardrail-7",
  expiresAt: "2026-07-26T01:00:00.000Z",
  triggerId: "trigger-expense",
};

describe("POST /api/v1/forms/:formId/submissions", () => {
  let app: FastifyInstance;
  let sid: string;
  let submit: Mock<FormsRoutesDeps["submit"]>;

  beforeEach(async () => {
    const sessions = new MemorySessionStore();
    const users = new FakeUserRepo();
    const user = await createUser(users, "member@example.com", "pass", "member");
    sid = await sessions.create(user._id);
    submit = vi.fn<FormsRoutesDeps["submit"]>(async () => ({
      mode: "standalone",
      eventId: "event-1",
      runId: "run-1",
      outcome: "started",
    }));
    app = await buildApp({
      sessionStore: sessions,
      userRepo: users,
      tokenRepo: new FakeTokenRepo(),
      forms: {
        resolve: async (formId) => (formId === form.id ? form : null),
        submit,
        now: () => "2026-07-26T00:30:00.000Z",
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function post(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/forms/expense-request/submissions",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload,
    });
  }

  it("submits through the governed form service", async () => {
    const response = await post({
      formVersion: "3",
      schemaRef: "forms/expense-request@3",
      guardrailRevision: "guardrail-7",
      data: { amount: 42 },
      idempotencyKey: "submit-1",
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      mode: "standalone",
      eventId: "event-1",
      runId: "run-1",
      outcome: "started",
    } satisfies FormSubmissionResult);
    expect(submit).toHaveBeenCalledWith(
      form,
      expect.objectContaining({
        formId: "expense-request",
        principal: expect.stringMatching(/^user:/),
        submittedAt: "2026-07-26T00:30:00.000Z",
      })
    );
  });

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/forms/expense-request/submissions",
      payload: {
        formVersion: "3",
        schemaRef: "forms/expense-request@3",
        guardrailRevision: "guardrail-7",
        data: {},
        idempotencyKey: "submit-1",
      },
    });
    expect(response.statusCode).toBe(401);
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns one safe denial without echoing submitted data or a resume token", async () => {
    submit.mockRejectedValue(new FormSubmissionError("wrong_user"));
    const response = await post({
      formVersion: "3",
      schemaRef: "forms/expense-request@3",
      guardrailRevision: "guardrail-7",
      data: { amount: "protected-value" },
      resumeToken: "one-use-secret",
      idempotencyKey: "submit-1",
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('{"error":"form submission denied"}');
    expect(response.body).not.toContain("protected-value");
    expect(response.body).not.toContain("one-use-secret");
  });

  it("does not reveal an unknown form", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/forms/missing/submissions",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: {
        formVersion: "1",
        schemaRef: "missing@1",
        guardrailRevision: "g",
        data: {},
        idempotencyKey: "submit-1",
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('{"error":"form not found"}');
  });

  it("publishes the route in OpenAPI", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(response.json().paths).toHaveProperty("/api/v1/forms/{formId}/submissions");
  });
});
