import { withSessionNav } from "@tulipfarm/authz";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthorizationCheck } from "../../authz/route-gate";
import { makeAuthorizationCheck } from "../../authz/route-gate";
import { userPrincipal } from "../../identity/principal";
import { sessionCookieOptions } from "../cookie-security";
import { CSRF_COOKIE, setCsrfCookie } from "../csrf";
import {
  hashInviteToken,
  InviteDeniedError,
  type InviteStores,
  previewInvite,
  redeemInvite,
  type UserInviteRepo,
} from "../invites";
import { SESSION_COOKIE } from "../middleware";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validatePassword,
  verifyPassword,
} from "../passwords";
import { ErrorSchema, SessionUserSchema } from "../schemas";
import { DEFAULT_SESSION_TTL_SECONDS, rotateSession, type SessionStore } from "../session-store";
import {
  MAX_NAME_CHARS,
  normalizeName,
  type PasswordWriteRepo,
  type ProfileWriteRepo,
  toPublicUser,
  type UserDoc,
  type UserRepo,
} from "../users";

// Precomputed lazily and reused: verifying against a dummy hash on unknown-user
// login keeps response timing similar to the known-user path (no user enumeration).
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("tulipfarm-timing-equalizer");
  }
  return dummyHashPromise;
}

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** A denial is opaque on the wire; log which cause it was, keyed by a hash prefix, not the token. */
function logInviteDenial(req: FastifyRequest, at: string, err: InviteDeniedError, token: string) {
  const hash = hashInviteToken(token).slice(0, 12);
  req.log.warn({ at, reason: err.reason, hash }, "invite denied");
}

export interface SessionRouteDeps {
  store: SessionStore;
  repo: UserRepo;
  requireAuth: PreHandler;
  ttlSeconds?: number;
  rateLimitHook?: PreHandler;
  loginRateLimitHook?: PreHandler;
  passwordWriteRepo?: PasswordWriteRepo;
  profileWriteRepo?: ProfileWriteRepo;
  inviteRepo?: UserInviteRepo;
  /** Decides session authority. Defaults to the no-authorizer gate, which answers from the account role. */
  authorizationCheck?: AuthorizationCheck;
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const {
    store,
    repo,
    requireAuth,
    ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
    rateLimitHook,
    loginRateLimitHook,
    passwordWriteRepo,
    profileWriteRepo,
    inviteRepo,
    authorizationCheck = makeAuthorizationCheck(),
  } = deps;

  /**
   * The gate's own answer to whether this account may manage People & access — never `role`, which
   * a granted `Owner` never rewrites (#408). A gate that cannot answer yields `false`: reading your
   * own session is how the app boots, and every admin surface is gated again on its own request.
   */
  async function sessionUser(user: UserDoc) {
    return withSessionNav(toPublicUser(user), userPrincipal(user, "session"), authorizationCheck);
  }
  const loginPreHandlers = [rateLimitHook, loginRateLimitHook].filter(
    (hook): hook is PreHandler => hook !== undefined
  );
  // Invite preview and accept verify a secret with no session behind them, exactly like login —
  // so they share login's much tighter guessing budget, not the general auth one.
  const invitePreHandlers = loginPreHandlers;

  app.post(
    "/api/v1/auth/login",
    {
      preHandler: loginPreHandlers,
      schema: {
        description: "Authenticate with email and password. Sets session cookie.",
        tags: ["auth"],
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", maxLength: MAX_PASSWORD_LENGTH },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { user: SessionUserSchema },
            required: ["user"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
      const email = typeof body.email === "string" ? body.email : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!email || !password) {
        return reply.code(400).send({ error: "email and password are required" });
      }

      const user = await repo.findByEmail(email);
      // An invited account has no password hash yet, so there is nothing to verify against — but
      // it still burns the dummy verification, so "exists but has not accepted" costs the same as
      // "does not exist".
      if (!user || user.passwordHash === null) {
        await verifyPassword(await getDummyHash(), password);
        return reply.code(401).send({ error: "invalid credentials" });
      }
      if (!(await verifyPassword(user.passwordHash, password))) {
        return reply.code(401).send({ error: "invalid credentials" });
      }
      // Anything but an active identity is denied with the same message as a bad password: whether
      // an account exists and what state it is in are both unobservable to the caller.
      if (user.status !== "active") {
        return reply.code(401).send({ error: "invalid credentials" });
      }

      // Rotate: any session id the browser already carried is destroyed and replaced, so a
      // pre-planted session id is never upgraded into an authenticated one (session fixation).
      const session = await rotateSession(store, req.cookies[SESSION_COOKIE], {
        userId: user._id,
        authMethods: ["password"],
      });
      reply.setCookie(SESSION_COOKIE, session.sid, sessionCookieOptions(ttlSeconds));
      setCsrfCookie(reply, session.csrfToken, ttlSeconds);
      return reply.code(200).send({ user: await sessionUser(user) });
    }
  );

  app.post(
    "/api/v1/auth/logout",
    {
      preHandler: rateLimitHook ?? [],
      schema: {
        description: "Destroy the current session and clear the session cookie.",
        tags: ["auth"],
        response: { 204: { type: "null" } },
      },
    },
    async (req, reply) => {
      const sid = req.cookies[SESSION_COOKIE];
      if (sid) {
        await store.destroy(sid);
      }
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });
      return reply.code(204).send();
    }
  );

  app.get(
    "/api/v1/auth/session",
    {
      preHandler: rateLimitHook ? [rateLimitHook, requireAuth] : requireAuth,
      schema: {
        description: "Return the currently authenticated user.",
        tags: ["auth"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: { user: SessionUserSchema },
            required: ["user"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      return reply.send({ user: await sessionUser(req.user) });
    }
  );

  if (passwordWriteRepo) {
    app.post(
      "/api/v1/auth/change-password",
      {
        preHandler: rateLimitHook ? [rateLimitHook, requireAuth] : requireAuth,
        schema: {
          description:
            "Change the current user's password. The current password must be supplied: a " +
            "stolen session should not be able to lock the account's owner out of it.",
          tags: ["auth"],
          security: [{ sessionCookie: [] }, { bearerToken: [] }],
          body: {
            type: "object",
            required: ["currentPassword", "newPassword"],
            properties: {
              currentPassword: { type: "string", maxLength: MAX_PASSWORD_LENGTH },
              newPassword: {
                type: "string",
                minLength: MIN_PASSWORD_LENGTH,
                maxLength: MAX_PASSWORD_LENGTH,
              },
            },
          },
          response: {
            200: {
              type: "object",
              properties: { user: SessionUserSchema },
              required: ["user"],
            },
            400: ErrorSchema,
            401: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        if (!req.user) {
          return reply.code(401).send({ error: "unauthorized" });
        }
        const body = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
        const currentPassword =
          typeof body.currentPassword === "string" ? body.currentPassword : "";
        const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

        const invalid = validatePassword(newPassword);
        if (invalid) {
          return reply.code(400).send({ error: invalid.message });
        }
        // An account with no password (invited, never accepted) cannot reach this route — it
        // cannot hold a session — but the null still has to be handled before verifying.
        if (
          req.user.passwordHash === null ||
          !(await verifyPassword(req.user.passwordHash, currentPassword))
        ) {
          return reply.code(401).send({ error: "current password is incorrect" });
        }

        await passwordWriteRepo.setPassword(req.user._id, await hashPassword(newPassword));

        // Rotate: a session minted under the old password shouldn't outlive it.
        const session = await rotateSession(store, req.cookies[SESSION_COOKIE], {
          userId: req.user._id,
          authMethods: ["password"],
        });
        reply.setCookie(SESSION_COOKIE, session.sid, sessionCookieOptions(ttlSeconds));
        setCsrfCookie(reply, session.csrfToken, ttlSeconds);
        return reply.send({ user: await sessionUser(req.user) });
      }
    );
  }

  if (profileWriteRepo) {
    app.patch(
      "/api/v1/auth/profile",
      {
        preHandler: rateLimitHook ? [rateLimitHook, requireAuth] : requireAuth,
        schema: {
          description:
            "Update the current user's own profile. Self-service only — there is no target " +
            "parameter, so this route cannot rename anybody else. Sending an empty or " +
            "whitespace-only name clears it, and the account goes back to being addressed by " +
            "its email.",
          tags: ["auth"],
          security: [{ sessionCookie: [] }, { bearerToken: [] }],
          body: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: ["string", "null"], maxLength: MAX_NAME_CHARS },
            },
          },
          response: {
            200: {
              type: "object",
              properties: { user: SessionUserSchema },
              required: ["user"],
            },
            400: ErrorSchema,
            401: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        if (!req.user) {
          return reply.code(401).send({ error: "unauthorized" });
        }
        const body = (req.body ?? {}) as { name?: unknown };
        if (body.name !== null && typeof body.name !== "string") {
          return reply.code(400).send({ error: "name must be a string or null" });
        }
        const name = body.name === null ? null : normalizeName(body.name);

        await profileWriteRepo.setName(req.user._id, name);
        return reply.send({ user: await sessionUser({ ...req.user, name }) });
      }
    );
  }

  if (inviteRepo && passwordWriteRepo) {
    const inviteStores: InviteStores = {
      invites: inviteRepo,
      users: repo,
      passwords: passwordWriteRepo,
    };
    app.post(
      "/api/v1/auth/invites/preview",
      {
        preHandler: invitePreHandlers,
        schema: {
          description:
            "Resolve an invite link to the account it will set a password for, without spending " +
            "it. Unauthenticated by design — the token is the only credential the holder has. " +
            "The token travels in the body so it never reaches an access log or a referrer.",
          tags: ["auth"],
          body: {
            type: "object",
            required: ["token"],
            properties: { token: { type: "string" } },
          },
          response: {
            200: {
              type: "object",
              properties: {
                email: { type: "string", format: "email" },
                expiresAt: { type: "string", format: "date-time" },
              },
              required: ["email", "expiresAt"],
            },
            400: ErrorSchema,
            404: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        const body = (req.body ?? {}) as { token?: unknown };
        const token = typeof body.token === "string" ? body.token : "";
        if (!token) {
          return reply.code(400).send({ error: "token is required" });
        }
        try {
          const offer = await previewInvite(inviteStores, token);
          return reply.send({ email: offer.email, expiresAt: offer.expiresAt.toISOString() });
        } catch (err) {
          if (err instanceof InviteDeniedError) {
            logInviteDenial(req, "preview", err, token);
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
      }
    );

    app.post(
      "/api/v1/auth/invites/accept",
      {
        preHandler: invitePreHandlers,
        schema: {
          description:
            "Redeem an invite link: set the account's password, activate it, and sign in. The " +
            "link is single-use, so a replayed one sets nothing.",
          tags: ["auth"],
          body: {
            type: "object",
            required: ["token", "password"],
            properties: {
              token: { type: "string" },
              password: {
                type: "string",
                minLength: MIN_PASSWORD_LENGTH,
                maxLength: MAX_PASSWORD_LENGTH,
              },
            },
          },
          response: {
            200: {
              type: "object",
              properties: { user: SessionUserSchema },
              required: ["user"],
            },
            400: ErrorSchema,
            404: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        const body = (req.body ?? {}) as { token?: unknown; password?: unknown };
        const token = typeof body.token === "string" ? body.token : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!token) {
          return reply.code(400).send({ error: "token is required" });
        }
        const invalid = validatePassword(password);
        if (invalid) {
          return reply.code(400).send({ error: invalid.message });
        }

        let user: Awaited<ReturnType<typeof redeemInvite>>;
        try {
          user = await redeemInvite(inviteStores, {
            raw: token,
            passwordHash: await hashPassword(password),
          });
        } catch (err) {
          if (err instanceof InviteDeniedError) {
            logInviteDenial(req, "accept", err, token);
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }

        // Redemption signs the account in, so the person who just chose a password lands in the
        // app rather than retyping it at a login form. Rotate for the usual fixation reason.
        const session = await rotateSession(store, req.cookies[SESSION_COOKIE], {
          userId: user._id,
          authMethods: ["password"],
        });
        reply.setCookie(SESSION_COOKIE, session.sid, sessionCookieOptions(ttlSeconds));
        setCsrfCookie(reply, session.csrfToken, ttlSeconds);
        return reply.send({ user: await sessionUser(user) });
      }
    );
  }
}
