import type { Queryable } from "@tulipfarm/storage";

/** A person who can read a Page, and how they got there. */
export interface NamedReader {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  /** The subject that grants them access, when it is not themselves. */
  readonly via: { kind: string; id: string } | null;
}

interface PrincipalRef {
  readonly kind: string;
  readonly id: string;
}

/**
 * Expands the subjects a Page is restricted to into the people who can actually read it.
 *
 * A list of named subjects is not a list of readers: a Team of six reads as one row, and an author
 * deciding whether a document is safe to write needs the six.
 *
 * This is a caller-initiated disclosure about a Page the caller already reads. It is deliberately
 * *not* used by the readership preview in `page-move.ts`, where the caller never asked to enumerate
 * anyone and naming a Team's members would disclose more than the question did.
 */
export class ReaderDirectory {
  constructor(private readonly q: Queryable) {}

  async expand(businessId: string, subjects: readonly PrincipalRef[]): Promise<NamedReader[]> {
    const users = subjects.filter((s) => s.kind === "user");
    const groups = subjects.filter((s) => s.kind === "group");
    const roles = subjects.filter((s) => s.kind === "role");

    const found = new Map<string, NamedReader>();
    const add = (id: string, label: string, via: PrincipalRef | null) => {
      // First route in wins: being named directly is a more useful explanation than a Team.
      if (!found.has(id)) found.set(id, { kind: "user", id, label, via });
    };

    for (const [id, label] of await this.names(users.map((u) => u.id))) add(id, label, null);

    for (const g of groups) {
      const { rows } = await this.q.query(
        `SELECT m.principal_id FROM principal_group_members m
          WHERE m.business_id = $1 AND m.group_id = $2
            AND (m.expires_at IS NULL OR m.expires_at > now())`,
        [businessId, g.id]
      );
      const ids = rows.map((r) => (r as { principal_id: string }).principal_id);
      for (const [id, label] of await this.names(ids)) add(id, label, g);
    }

    for (const r of roles) {
      const { rows } = await this.q.query(
        `SELECT principal_id FROM role_assignments WHERE business_id = $1 AND role_id = $2`,
        [businessId, r.id]
      );
      const ids = rows.map((x) => (x as { principal_id: string }).principal_id);
      for (const [id, label] of await this.names(ids)) add(id, label, r);
    }

    return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  private async names(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const { rows } = await this.q.query(
      `SELECT id, name, email FROM users WHERE id = ANY($1::uuid[])`,
      [unique]
    );
    const out = new Map<string, string>();
    for (const r of rows) {
      const row = r as { id: string; name: string | null; email: string };
      out.set(row.id, row.name?.trim() || row.email);
    }
    return out;
  }
}
