import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { Queryable } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization } from "../authz/route-gate";
import { SubjectDirectoryResponseSchema } from "./schemas";

/** A subject a Page or Space can be restricted to, as the picker shows it. */
export interface DirectorySubject {
  readonly kind: "user" | "group" | "role";
  readonly id: string;
  readonly label: string;
}

export interface SubjectDirectoryListing {
  readonly users: readonly DirectorySubject[];
  readonly teams: readonly DirectorySubject[];
  readonly roles: readonly DirectorySubject[];
}

/**
 * The people, Teams and Roles a member may name when restricting something they authored.
 *
 * Every other directory in this API is admin-only, which left a member able to restrict their own
 * Page but unable to look up who to share it with. Within one Business the staff list is not itself
 * a secret; what *is* a secret is everything hanging off a person — their role, their Team
 * memberships, their grants — so this returns an identifier and a label and nothing else.
 *
 * Disabled Users are omitted: naming one grants nothing, and offering them invites an author to
 * believe a document reached someone it did not.
 */
export class SubjectDirectory {
  constructor(private readonly q: Queryable) {}

  async list(businessId: string = DEPLOYMENT_BUSINESS_ID): Promise<SubjectDirectoryListing> {
    const [users, teams, roles] = await Promise.all([
      this.q.query(
        // `users` is deployment-wide, not per-Business: it carries no business_id to filter on.
        `SELECT id, name, email FROM users
          WHERE status = 'active'
          ORDER BY COALESCE(NULLIF(btrim(name), ''), email)`,
        []
      ),
      this.q.query(`SELECT id FROM principal_groups WHERE business_id = $1 ORDER BY id`, [
        businessId,
      ]),
      this.q.query(`SELECT id FROM roles WHERE business_id = $1 ORDER BY id`, [businessId]),
    ]);

    return {
      users: users.rows.map((r) => {
        const row = r as { id: string; name: string | null; email: string };
        return { kind: "user" as const, id: row.id, label: row.name?.trim() || row.email };
      }),
      teams: teams.rows.map((r) => {
        const id = (r as { id: string }).id;
        return { kind: "group" as const, id, label: id };
      }),
      roles: roles.rows.map((r) => {
        const id = (r as { id: string }).id;
        return { kind: "role" as const, id, label: id };
      }),
    };
  }
}

export function registerSubjectRoutes(
  app: FastifyInstance,
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
  requireAuthorization: RequireAuthorization,
  directory: SubjectDirectory
): void {
  app.get(
    "/api/v1/knowledge/subjects",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "knowledge_subject.list",
          resourceType: "knowledge_subject",
          fallback: "authenticated",
        }),
      ],
      schema: {
        description:
          "List the Users, Teams, and Roles a member may name when restricting a Page or Space. " +
          "Returns an identifier and a label only.",
        tags: ["knowledge"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: SubjectDirectoryResponseSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req) => directory.list(req.principal?.businessId ?? DEPLOYMENT_BUSINESS_ID)
  );
}
