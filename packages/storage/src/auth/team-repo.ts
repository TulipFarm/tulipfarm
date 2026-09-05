import { randomUUID } from "node:crypto";
import type {
  TeamDelegationGrantScope,
  TeamLifecycleStatus,
  TeamMemberPrincipalKind,
  TeamMembershipLevel,
} from "@tulipfarm/schema";
import { canonicalHash } from "@tulipfarm/schema";
import type { Queryable, TransactionPort } from "../ports";
import type { GrantRecord } from "./role-repo";

export const EVERYONE_TEAM_SLUG = "everyone";
export const MAX_TEAM_DEPTH = 10;

let inMemoryTeamMutationTail = Promise.resolve();

export async function withInMemoryTeamMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = inMemoryTeamMutationTail;
  let release = () => {};
  inMemoryTeamMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export interface TeamRecord {
  readonly id: string;
  readonly businessId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly parentTeamId?: string;
  readonly status: TeamLifecycleStatus;
  readonly protected: boolean;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt?: Date;
}

export interface TeamMembershipRecord {
  readonly teamId: string;
  readonly principalId: string;
  readonly principalKind: TeamMemberPrincipalKind;
  readonly level: TeamMembershipLevel;
  readonly expiresAt?: Date;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TeamRoleAssignmentRecord {
  readonly teamId: string;
  readonly roleId: string;
  readonly expiresAt?: Date;
  readonly assignedAt: Date;
}

export interface TeamGrantRecord extends GrantRecord {
  readonly id: string;
  readonly teamId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TeamDelegationPolicyRecord {
  readonly teamId: string;
  readonly allowedRoleIds: readonly string[];
  readonly allowedGrantScopes: readonly TeamDelegationGrantScope[];
  readonly revision: number;
  readonly updatedAt: Date;
}

export class TeamDelegationPolicyRevisionConflictError extends Error {
  readonly name = "TeamDelegationPolicyRevisionConflictError";
}

export type TeamLeaveRequestStatus = "pending" | "approved" | "rejected";

export interface TeamLeaveRequestRecord {
  readonly id: string;
  readonly teamId: string;
  readonly principalId: string;
  readonly status: TeamLeaveRequestStatus;
  readonly revision: number;
  readonly requestedAt: Date;
  readonly decidedAt?: Date;
  readonly decidedByPrincipalId?: string;
}

export interface TeamMovePreviewRecord {
  readonly tokenDigest: string;
  readonly businessId: string;
  readonly teamId: string;
  readonly proposedParentTeamId: string;
  readonly teamRevision: number;
  readonly parentRevision: number;
  readonly authorityRevision: number;
  readonly bindingEvidenceDigest: string;
  readonly impactDigest: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
}

export interface ConfirmTeamMoveInput {
  readonly tokenDigest: string;
  readonly businessId: string;
  readonly teamId: string;
  readonly proposedParentTeamId: string;
  readonly bindingEvidenceDigest: string;
  readonly impactDigest: string;
  readonly now: Date;
}

export interface RecoverTeamAdminInput {
  readonly businessId: string;
  readonly teamId: string;
  readonly principalId: string;
  readonly teamRevision: number;
  readonly now: Date;
}

export interface TeamLifecycleTransitionInput {
  readonly businessId: string;
  readonly teamId: string;
  readonly action: "archive" | "delete";
  readonly expectedRevision: number;
  readonly now: Date;
}

export type TeamLifecycleTransitionResult =
  | { readonly ok: true; readonly team?: TeamRecord }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "conflict" | "invalid" | "protected" | "not_empty";
      readonly message: string;
    };

export interface InMemoryTeamLifecycleReferences {
  hasAssetReference(businessId: string, teamId: string): boolean;
  hasPendingApproval(businessId: string, teamId: string, now: Date): boolean;
}

export interface TeamRepo {
  ensureEveryone(businessId: string): Promise<TeamRecord>;
  getTeam(businessId: string, teamId: string): Promise<TeamRecord | undefined>;
  getTeamBySlug(businessId: string, slug: string): Promise<TeamRecord | undefined>;
  listTeams(businessId: string): Promise<TeamRecord[]>;
  createTeam(record: TeamRecord, memberships: readonly TeamMembershipRecord[]): Promise<void>;
  putTeam(record: TeamRecord): Promise<void>;
  deleteTeam(businessId: string, teamId: string): Promise<void>;
  resolveLegacyGroupId(businessId: string, groupId: string): Promise<string | undefined>;
  putLegacyGroupMapping(businessId: string, groupId: string, teamId: string): Promise<void>;
  putMembership(record: TeamMembershipRecord): Promise<void>;
  removeMembership(teamId: string, principalId: string, expectedRevision?: number): Promise<void>;
  getMembership(teamId: string, principalId: string): Promise<TeamMembershipRecord | undefined>;
  listMemberships(teamId: string, now: Date): Promise<TeamMembershipRecord[]>;
  listAllMemberships(teamId: string): Promise<TeamMembershipRecord[]>;
  listPrincipalMemberships(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<TeamMembershipRecord[]>;
  listAllPrincipalMemberships(
    businessId: string,
    principalId: string
  ): Promise<TeamMembershipRecord[]>;
  assignRole(record: TeamRoleAssignmentRecord): Promise<void>;
  revokeRole(teamId: string, roleId: string): Promise<void>;
  listRoleAssignments(teamId: string, now: Date): Promise<TeamRoleAssignmentRecord[]>;
  listAllRoleAssignments(teamId: string): Promise<TeamRoleAssignmentRecord[]>;
  putGrant(record: TeamGrantRecord): Promise<void>;
  deleteGrant(teamId: string, grantId: string): Promise<void>;
  listGrants(teamId: string, now: Date): Promise<TeamGrantRecord[]>;
  listAllGrants(teamId: string): Promise<TeamGrantRecord[]>;
  putDelegationPolicy(record: TeamDelegationPolicyRecord): Promise<void>;
  getDelegationPolicy(teamId: string): Promise<TeamDelegationPolicyRecord | undefined>;
  putLeaveRequest(record: TeamLeaveRequestRecord): Promise<void>;
  getLeaveRequest(teamId: string, requestId: string): Promise<TeamLeaveRequestRecord | undefined>;
  listLeaveRequests(teamId: string): Promise<TeamLeaveRequestRecord[]>;
  recoverAdmin(input: RecoverTeamAdminInput): Promise<TeamMembershipRecord>;
  transitionLifecycle(input: TeamLifecycleTransitionInput): Promise<TeamLifecycleTransitionResult>;
  getAuthorityRevision(businessId: string): Promise<number>;
  getMoveBindingEvidenceDigest(businessId: string): Promise<string>;
  createMovePreview(record: TeamMovePreviewRecord): Promise<void>;
  confirmMove(input: ConfirmTeamMoveInput): Promise<TeamRecord>;
}

export const TEAM_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS teams (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    text NOT NULL CHECK (length(business_id) > 0),
    slug           text NOT NULL CHECK (
      length(slug) <= 128 AND slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    ),
    display_name   text NOT NULL CHECK (length(display_name) > 0 AND length(display_name) <= 256),
    description    text CHECK (description IS NULL OR length(description) <= 2000),
    labels         text[] NOT NULL DEFAULT '{}',
    parent_team_id uuid,
    status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    protected      boolean NOT NULL DEFAULT false,
    revision       integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at     timestamptz(3) NOT NULL DEFAULT now(),
    updated_at     timestamptz(3) NOT NULL DEFAULT now(),
    archived_at    timestamptz(3),
    CHECK (
      (status = 'active' AND archived_at IS NULL) OR
      (status = 'archived' AND archived_at IS NOT NULL)
    ),
    UNIQUE (business_id, id),
    UNIQUE (business_id, slug),
    FOREIGN KEY (business_id, parent_team_id) REFERENCES teams(business_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS teams_one_root_idx
     ON teams (business_id) WHERE parent_team_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS teams_sibling_display_name_idx
     ON teams (business_id, parent_team_id, lower(display_name))
     WHERE parent_team_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS team_slug_reservations (
    business_id text NOT NULL,
    slug        text NOT NULL,
    team_id     uuid NOT NULL,
    reserved_at timestamptz(3) NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, slug)
  )`,
  `CREATE OR REPLACE FUNCTION enforce_team_identity_and_hierarchy()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      root_slug text;
      parent_depth integer;
    BEGIN
      IF TG_OP = 'UPDATE' AND (NEW.slug <> OLD.slug OR NEW.business_id <> OLD.business_id) THEN
        RAISE EXCEPTION 'Team slug and business are immutable';
      END IF;
      IF TG_OP = 'UPDATE' AND (
        NEW.created_at <> OLD.created_at OR NEW.revision <> OLD.revision + 1
      ) THEN
        RAISE EXCEPTION 'Team updates must advance revision exactly once';
      END IF;
      IF TG_OP = 'UPDATE' AND OLD.protected AND (
        NEW.display_name <> OLD.display_name OR
        NEW.parent_team_id IS DISTINCT FROM OLD.parent_team_id OR
        NEW.status <> OLD.status OR
        NOT NEW.protected
      ) THEN
        RAISE EXCEPTION 'Protected Team identity and lifecycle are immutable';
      END IF;
      IF NEW.parent_team_id IS NULL THEN
        IF NEW.slug <> 'everyone' OR NEW.display_name <> 'Everyone' OR NOT NEW.protected
           OR NEW.status <> 'active' OR NEW.archived_at IS NOT NULL THEN
          RAISE EXCEPTION 'The only root Team is protected Everyone';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.protected THEN
        RAISE EXCEPTION 'Only Everyone may be protected';
      END IF;
      IF NEW.parent_team_id = NEW.id THEN
        RAISE EXCEPTION 'A Team cannot parent itself';
      END IF;
      WITH RECURSIVE ancestry AS (
        SELECT id, parent_team_id, slug, 1 AS depth
          FROM teams
         WHERE business_id = NEW.business_id AND id = NEW.parent_team_id
        UNION ALL
        SELECT parent.id, parent.parent_team_id, parent.slug, ancestry.depth + 1
          FROM teams parent
          JOIN ancestry ON parent.id = ancestry.parent_team_id
         WHERE parent.business_id = NEW.business_id AND ancestry.depth < 10
      )
      SELECT max(depth), (array_agg(slug ORDER BY depth DESC))[1]
        INTO parent_depth, root_slug
        FROM ancestry;
      IF parent_depth IS NULL OR root_slug <> 'everyone' THEN
        RAISE EXCEPTION 'Every Team must descend from Everyone';
      END IF;
      IF EXISTS (
        WITH RECURSIVE ancestry AS (
          SELECT id, parent_team_id, 1 AS depth FROM teams
           WHERE business_id = NEW.business_id AND id = NEW.parent_team_id
          UNION ALL
          SELECT parent.id, parent.parent_team_id, ancestry.depth + 1
            FROM teams parent JOIN ancestry ON parent.id = ancestry.parent_team_id
           WHERE parent.business_id = NEW.business_id AND ancestry.depth < 10
        )
        SELECT 1 FROM ancestry WHERE id = NEW.id
      ) THEN
        RAISE EXCEPTION 'Team hierarchy cannot contain a cycle';
      END IF;
      IF parent_depth + 1 > 10 THEN
        RAISE EXCEPTION 'Team hierarchy cannot exceed 10 levels';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `DROP TRIGGER IF EXISTS teams_identity_hierarchy_guard ON teams`,
  `CREATE TRIGGER teams_identity_hierarchy_guard
    BEFORE INSERT OR UPDATE ON teams
    FOR EACH ROW EXECUTE FUNCTION enforce_team_identity_and_hierarchy()`,
  `CREATE OR REPLACE FUNCTION prevent_protected_team_delete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.protected THEN
        RAISE EXCEPTION 'Protected Team cannot be deleted';
      END IF;
      RETURN OLD;
    END;
    $$`,
  `DROP TRIGGER IF EXISTS teams_protected_delete_guard ON teams`,
  `CREATE TRIGGER teams_protected_delete_guard
    BEFORE DELETE ON teams
    FOR EACH ROW EXECUTE FUNCTION prevent_protected_team_delete()`,
  `CREATE OR REPLACE FUNCTION reserve_team_slug()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO team_slug_reservations (business_id, slug, team_id)
        VALUES (NEW.business_id, NEW.slug, NEW.id);
        RETURN NEW;
      END IF;
      RETURN OLD;
    END;
    $$`,
  `DROP TRIGGER IF EXISTS teams_slug_reservation_insert ON teams`,
  `CREATE TRIGGER teams_slug_reservation_insert
    AFTER INSERT ON teams FOR EACH ROW EXECUTE FUNCTION reserve_team_slug()`,
  `CREATE TABLE IF NOT EXISTS team_memberships (
    team_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    principal_id  text NOT NULL,
    principal_kind text NOT NULL CHECK (principal_kind IN ('user', 'agent', 'service')),
    level          text NOT NULL CHECK (level IN ('member', 'admin')),
    expires_at     timestamptz,
    revision       integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at     timestamptz(3) NOT NULL DEFAULT now(),
    updated_at     timestamptz(3) NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, principal_id)
  )`,
  `CREATE OR REPLACE FUNCTION enforce_team_membership_principal()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      actual_kind text;
      team_business_id text;
      team_is_protected boolean;
    BEGIN
      SELECT business_id, protected INTO team_business_id, team_is_protected
        FROM teams WHERE id = NEW.team_id;
      SELECT kind INTO actual_kind FROM principals
       WHERE business_id = team_business_id AND id = NEW.principal_id;
      IF actual_kind IS NULL OR actual_kind <> NEW.principal_kind THEN
        RAISE EXCEPTION 'Team membership principal kind does not match the Principal';
      END IF;
      IF NEW.level = 'admin' AND NEW.principal_kind <> 'user' THEN
        RAISE EXCEPTION 'Only people may be Team admins';
      END IF;
      IF team_is_protected AND NEW.level <> 'member' THEN
        RAISE EXCEPTION 'Everyone memberships are always member level';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `DROP TRIGGER IF EXISTS team_memberships_principal_guard ON team_memberships`,
  `CREATE TRIGGER team_memberships_principal_guard
    BEFORE INSERT OR UPDATE ON team_memberships
    FOR EACH ROW EXECUTE FUNCTION enforce_team_membership_principal()`,
  `CREATE OR REPLACE FUNCTION protect_final_team_admin()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      team_status text;
      old_principal_active boolean;
    BEGIN
      IF OLD.level <> 'admin' OR OLD.principal_kind <> 'user'
         OR (OLD.expires_at IS NOT NULL AND OLD.expires_at <= now()) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END IF;
      IF TG_OP = 'UPDATE' AND NEW.level = 'admin' AND NEW.principal_kind = 'user'
         AND (NEW.expires_at IS NULL OR NEW.expires_at > now()) THEN
        RETURN NEW;
      END IF;
      SELECT status INTO team_status FROM teams WHERE id = OLD.team_id FOR UPDATE;
      IF team_status <> 'active' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM principals
         WHERE id = OLD.principal_id AND status = 'active'
           AND (expires_at IS NULL OR expires_at > now())
      ) INTO old_principal_active;
      IF old_principal_active AND NOT EXISTS (
        SELECT 1
          FROM team_memberships membership
          JOIN teams team ON team.id = membership.team_id
          JOIN principals principal
            ON principal.business_id = team.business_id
           AND principal.id = membership.principal_id
         WHERE membership.team_id = OLD.team_id
           AND membership.principal_id <> OLD.principal_id
           AND membership.level = 'admin'
           AND membership.principal_kind = 'user'
           AND (membership.expires_at IS NULL OR membership.expires_at > now())
           AND principal.status = 'active'
           AND (principal.expires_at IS NULL OR principal.expires_at > now())
      ) THEN
        RAISE EXCEPTION 'The final Team admin cannot be removed or demoted';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END;
    $$`,
  `DROP TRIGGER IF EXISTS team_memberships_final_admin_guard ON team_memberships`,
  `CREATE TRIGGER team_memberships_final_admin_guard
    BEFORE DELETE OR UPDATE ON team_memberships
    FOR EACH ROW EXECUTE FUNCTION protect_final_team_admin()`,
  `CREATE INDEX IF NOT EXISTS team_memberships_principal_idx
     ON team_memberships (principal_id, team_id)`,
  `CREATE OR REPLACE FUNCTION sync_everyone_team_membership()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      everyone_id uuid;
    BEGIN
      SELECT id INTO everyone_id FROM teams
       WHERE business_id = NEW.business_id AND slug = 'everyone';
      IF NEW.kind <> 'user' OR NEW.status <> 'active' THEN
        IF everyone_id IS NOT NULL THEN
          DELETE FROM team_memberships
           WHERE team_id = everyone_id AND principal_id = NEW.id;
        END IF;
        RETURN NEW;
      END IF;
      INSERT INTO teams (business_id, slug, display_name, protected)
      VALUES (NEW.business_id, 'everyone', 'Everyone', true)
      ON CONFLICT (business_id, slug) DO NOTHING;
      SELECT id INTO everyone_id FROM teams
       WHERE business_id = NEW.business_id AND slug = 'everyone';
      INSERT INTO team_memberships (team_id, principal_id, principal_kind, level)
      VALUES (everyone_id, NEW.id, 'user', 'member')
      ON CONFLICT (team_id, principal_id) DO UPDATE SET
        principal_kind = 'user',
        level = 'member',
        expires_at = NULL,
        revision = team_memberships.revision + 1,
        updated_at = now();
      RETURN NEW;
    END;
    $$`,
  `DROP TRIGGER IF EXISTS principals_everyone_membership ON principals`,
  `CREATE TRIGGER principals_everyone_membership
    AFTER INSERT OR UPDATE OF kind, status ON principals
    FOR EACH ROW EXECUTE FUNCTION sync_everyone_team_membership()`,
  `CREATE TABLE IF NOT EXISTS team_role_assignments (
    team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    role_business_id text NOT NULL,
    role_id     text NOT NULL,
    expires_at  timestamptz,
    assigned_at timestamptz(3) NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, role_id),
    FOREIGN KEY (role_business_id, role_id) REFERENCES roles(business_id, id) ON DELETE CASCADE
  )`,
  `CREATE OR REPLACE FUNCTION enforce_team_role_assignment()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      team_business_id text;
      role_targets text[];
    BEGIN
      SELECT business_id INTO team_business_id FROM teams WHERE id = NEW.team_id;
      SELECT assignable_to INTO role_targets FROM roles
       WHERE business_id = NEW.role_business_id AND id = NEW.role_id;
      IF team_business_id IS NULL OR team_business_id <> NEW.role_business_id THEN
        RAISE EXCEPTION 'Team and Role must belong to the same business';
      END IF;
      IF NOT ('team' = ANY(role_targets)) THEN
        RAISE EXCEPTION 'Role is not assignable to Teams';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `DROP TRIGGER IF EXISTS team_role_assignments_target_guard ON team_role_assignments`,
  `CREATE TRIGGER team_role_assignments_target_guard
    BEFORE INSERT OR UPDATE ON team_role_assignments
    FOR EACH ROW EXECUTE FUNCTION enforce_team_role_assignment()`,
  `CREATE TABLE IF NOT EXISTS team_grants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    action          text NOT NULL CHECK (length(action) > 0),
    resource_type   text NOT NULL CHECK (length(resource_type) > 0),
    domain          text,
    record_selector text,
    field_selector  text[],
    data_class      text,
    destination     text,
    conditions      jsonb CHECK (conditions IS NULL OR jsonb_typeof(conditions) = 'object'),
    effect          text NOT NULL CHECK (effect IN ('allow', 'deny')),
    expires_at      timestamptz,
    created_at      timestamptz(3) NOT NULL DEFAULT now(),
    updated_at      timestamptz(3) NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS team_grants_team_idx ON team_grants (team_id)`,
  `CREATE TABLE IF NOT EXISTS team_delegation_policies (
    team_id              uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    allowed_role_ids     text[] NOT NULL DEFAULT '{}',
    allowed_grant_scopes jsonb NOT NULL DEFAULT '[]',
    revision             integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at           timestamptz(3) NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(allowed_grant_scopes) = 'array')
  )`,
  `CREATE TABLE IF NOT EXISTS team_leave_requests (
    id                      uuid PRIMARY KEY,
    team_id                 uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    principal_id            text NOT NULL,
    status                  text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    revision                integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    requested_at            timestamptz(3) NOT NULL,
    decided_at              timestamptz(3),
    decided_by_principal_id text,
    CHECK (
      (status = 'pending' AND decided_at IS NULL AND decided_by_principal_id IS NULL) OR
      (status IN ('approved', 'rejected') AND decided_at IS NOT NULL
        AND decided_by_principal_id IS NOT NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS team_leave_requests_one_pending_idx
     ON team_leave_requests (team_id, principal_id) WHERE status = 'pending'`,
  `CREATE TABLE IF NOT EXISTS legacy_group_team_mappings (
    business_id text NOT NULL,
    group_id    text NOT NULL,
    team_id     uuid NOT NULL,
    migrated_at timestamptz(3) NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, group_id),
    UNIQUE (team_id),
    FOREIGN KEY (business_id, team_id) REFERENCES teams(business_id, id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS team_authority_revisions (
    business_id text PRIMARY KEY,
    revision    bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
  )`,
  `CREATE OR REPLACE FUNCTION bump_team_authority_revision()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      affected_business_id text;
      affected_team_id uuid;
    BEGIN
      IF TG_TABLE_NAME = 'teams' THEN
        IF TG_OP = 'DELETE' THEN
          affected_business_id := OLD.business_id;
        ELSE
          affected_business_id := NEW.business_id;
        END IF;
      ELSE
        IF TG_OP = 'DELETE' THEN
          affected_team_id := OLD.team_id;
        ELSE
          affected_team_id := NEW.team_id;
        END IF;
        SELECT business_id INTO affected_business_id FROM teams WHERE id = affected_team_id;
      END IF;
      IF affected_business_id IS NOT NULL THEN
        INSERT INTO team_authority_revisions (business_id, revision)
        VALUES (affected_business_id, 1)
        ON CONFLICT (business_id) DO UPDATE
          SET revision = team_authority_revisions.revision + 1;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $$`,
  `DROP TRIGGER IF EXISTS teams_authority_revision ON teams`,
  `CREATE TRIGGER teams_authority_revision
    AFTER INSERT OR UPDATE OR DELETE ON teams
    FOR EACH ROW EXECUTE FUNCTION bump_team_authority_revision()`,
  `DROP TRIGGER IF EXISTS team_memberships_authority_revision ON team_memberships`,
  `CREATE TRIGGER team_memberships_authority_revision
    AFTER INSERT OR UPDATE OR DELETE ON team_memberships
    FOR EACH ROW EXECUTE FUNCTION bump_team_authority_revision()`,
  `DROP TRIGGER IF EXISTS team_role_assignments_authority_revision ON team_role_assignments`,
  `CREATE TRIGGER team_role_assignments_authority_revision
    AFTER INSERT OR UPDATE OR DELETE ON team_role_assignments
    FOR EACH ROW EXECUTE FUNCTION bump_team_authority_revision()`,
  `DROP TRIGGER IF EXISTS team_grants_authority_revision ON team_grants`,
  `CREATE TRIGGER team_grants_authority_revision
    AFTER INSERT OR UPDATE OR DELETE ON team_grants
    FOR EACH ROW EXECUTE FUNCTION bump_team_authority_revision()`,
  `DROP TRIGGER IF EXISTS team_delegation_policies_authority_revision
     ON team_delegation_policies`,
  `CREATE TRIGGER team_delegation_policies_authority_revision
    AFTER INSERT OR UPDATE OR DELETE ON team_delegation_policies
    FOR EACH ROW EXECUTE FUNCTION bump_team_authority_revision()`,
  `CREATE TABLE IF NOT EXISTS team_move_previews (
    token_digest             text PRIMARY KEY CHECK (length(token_digest) = 64),
    business_id              text NOT NULL,
    team_id                  uuid NOT NULL,
    proposed_parent_team_id  uuid NOT NULL,
    team_revision            integer NOT NULL CHECK (team_revision >= 1),
    parent_revision          integer NOT NULL CHECK (parent_revision >= 1),
    authority_revision       bigint NOT NULL CHECK (authority_revision >= 0),
    binding_evidence_digest  text NOT NULL CHECK (length(binding_evidence_digest) = 64),
    impact_digest            text NOT NULL CHECK (length(impact_digest) = 64),
    created_at               timestamptz(3) NOT NULL,
    expires_at               timestamptz(3) NOT NULL,
    consumed_at              timestamptz(3),
    FOREIGN KEY (business_id, team_id) REFERENCES teams(business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, proposed_parent_team_id)
      REFERENCES teams(business_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS team_move_previews_expiry_idx
     ON team_move_previews (expires_at) WHERE consumed_at IS NULL`,
];

function teamKey(businessId: string, teamId: string): string {
  return JSON.stringify([businessId, teamId]);
}

function active<T extends { readonly expiresAt?: Date }>(record: T, now: Date): boolean {
  return !record.expiresAt || record.expiresAt > now;
}

function lifecycleFailure(
  reason: Exclude<TeamLifecycleTransitionResult, { readonly ok: true }>["reason"],
  message: string
): TeamLifecycleTransitionResult {
  return { ok: false, reason, message };
}

export class InMemoryTeamRepo implements TeamRepo {
  private readonly teams = new Map<string, TeamRecord>();
  private readonly reservedSlugs = new Map<string, string>();
  private readonly legacyGroups = new Map<string, string>();
  private readonly memberships = new Map<string, TeamMembershipRecord>();
  private readonly roles = new Map<string, TeamRoleAssignmentRecord>();
  private readonly grants = new Map<string, TeamGrantRecord>();
  private readonly policies = new Map<string, TeamDelegationPolicyRecord>();
  private readonly leaveRequests = new Map<string, TeamLeaveRequestRecord>();
  private readonly authorityRevisions = new Map<string, number>();
  private readonly movePreviews = new Map<string, TeamMovePreviewRecord>();

  constructor(private readonly lifecycleReferences?: InMemoryTeamLifecycleReferences) {}

  private bumpAuthorityRevision(businessId: string): void {
    this.authorityRevisions.set(businessId, (this.authorityRevisions.get(businessId) ?? 0) + 1);
  }

  private businessIdForTeam(teamId: string): string | undefined {
    return [...this.teams.values()].find((team) => team.id === teamId)?.businessId;
  }

  async ensureEveryone(businessId: string): Promise<TeamRecord> {
    const existing = await this.getTeamBySlug(businessId, EVERYONE_TEAM_SLUG);
    if (existing) return existing;
    const now = new Date();
    const team: TeamRecord = {
      id: randomUUID(),
      businessId,
      slug: EVERYONE_TEAM_SLUG,
      displayName: "Everyone",
      status: "active",
      protected: true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.putTeam(team);
    return team;
  }

  async getTeam(businessId: string, teamId: string): Promise<TeamRecord | undefined> {
    return this.teams.get(teamKey(businessId, teamId));
  }

  async getTeamBySlug(businessId: string, slug: string): Promise<TeamRecord | undefined> {
    return [...this.teams.values()].find(
      (team) => team.businessId === businessId && team.slug === slug
    );
  }

  async listTeams(businessId: string): Promise<TeamRecord[]> {
    return [...this.teams.values()]
      .filter((team) => team.businessId === businessId)
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  async createTeam(
    record: TeamRecord,
    memberships: readonly TeamMembershipRecord[]
  ): Promise<void> {
    const teams = new Map(this.teams);
    const reservedSlugs = new Map(this.reservedSlugs);
    const currentMemberships = new Map(this.memberships);
    try {
      await this.putTeam(record);
      for (const membership of memberships) await this.putMembership(membership);
    } catch (error) {
      this.teams.clear();
      this.reservedSlugs.clear();
      this.memberships.clear();
      for (const [key, value] of teams) this.teams.set(key, value);
      for (const [key, value] of reservedSlugs) this.reservedSlugs.set(key, value);
      for (const [key, value] of currentMemberships) this.memberships.set(key, value);
      throw error;
    }
  }

  async putTeam(record: TeamRecord): Promise<void> {
    const key = teamKey(record.businessId, record.id);
    const previous = this.teams.get(key);
    if (previous && previous.slug !== record.slug) throw new Error("Team slug is immutable");
    if (previous && record.revision !== previous.revision + 1) {
      throw new Error("Team updates must advance revision exactly once");
    }
    if (!previous && record.revision !== 1) throw new Error("A new Team starts at revision 1");
    const reservedBy = this.reservedSlugs.get(teamKey(record.businessId, record.slug));
    if (reservedBy && reservedBy !== record.id) throw new Error("Team slug is reserved");
    const siblings = [...this.teams.values()].filter(
      (team) =>
        team.businessId === record.businessId &&
        team.id !== record.id &&
        team.parentTeamId === record.parentTeamId
    );
    if (
      siblings.some(
        (team) => team.displayName.toLocaleLowerCase() === record.displayName.toLocaleLowerCase()
      )
    ) {
      throw new Error("Sibling Team display name must be unique");
    }
    this.validateHierarchy(record);
    this.teams.set(key, Object.freeze({ ...record }));
    this.reservedSlugs.set(teamKey(record.businessId, record.slug), record.id);
    this.bumpAuthorityRevision(record.businessId);
  }

  async deleteTeam(businessId: string, teamId: string): Promise<void> {
    const existing = await this.getTeam(businessId, teamId);
    if (!existing) return;
    if (existing.protected) throw new Error("Protected Team cannot be deleted");
    this.teams.delete(teamKey(businessId, teamId));
    this.bumpAuthorityRevision(businessId);
    for (const [key, membership] of this.memberships) {
      if (membership.teamId === teamId) this.memberships.delete(key);
    }
    for (const [key, role] of this.roles) {
      if (role.teamId === teamId) this.roles.delete(key);
    }
    for (const [key, grant] of this.grants) {
      if (grant.teamId === teamId) this.grants.delete(key);
    }
    this.policies.delete(teamId);
    for (const [key, request] of this.leaveRequests) {
      if (request.teamId === teamId) this.leaveRequests.delete(key);
    }
  }

  async transitionLifecycle(
    input: TeamLifecycleTransitionInput
  ): Promise<TeamLifecycleTransitionResult> {
    return withInMemoryTeamMutationLock(() => this.transitionLifecycleUnlocked(input));
  }

  private async transitionLifecycleUnlocked(
    input: TeamLifecycleTransitionInput
  ): Promise<TeamLifecycleTransitionResult> {
    const key = teamKey(input.businessId, input.teamId);
    const team = this.teams.get(key);
    if (!team) return lifecycleFailure("not_found", "Team was not found");
    if (team.protected) return lifecycleFailure("protected", "Everyone is protected");
    if (team.revision !== input.expectedRevision) {
      return lifecycleFailure("conflict", "Team revision conflict");
    }

    const hasChild = [...this.teams.values()].some(
      (candidate) =>
        candidate.businessId === input.businessId && candidate.parentTeamId === input.teamId
    );
    if (input.action === "archive") {
      if (team.status !== "active") return lifecycleFailure("invalid", "Team is archived");
      if (hasChild) {
        return lifecycleFailure("not_empty", "Move child Teams before archiving this Team");
      }
      const blocking = this.lifecycleAssetFailure(input, "archiving");
      if (blocking) return blocking;
      const archived: TeamRecord = {
        ...team,
        status: "archived",
        archivedAt: input.now,
        revision: team.revision + 1,
        updatedAt: input.now,
      };
      this.teams.set(key, Object.freeze(archived));
      this.bumpAuthorityRevision(input.businessId);
      return { ok: true, team: archived };
    }

    if (team.status !== "archived") {
      return lifecycleFailure("invalid", "Only an archived Team can be deleted");
    }
    if (
      hasChild ||
      [...this.memberships.values()].some((membership) => membership.teamId === input.teamId) ||
      [...this.roles.values()].some((role) => role.teamId === input.teamId) ||
      [...this.grants.values()].some((grant) => grant.teamId === input.teamId) ||
      this.policies.has(input.teamId) ||
      [...this.leaveRequests.values()].some(
        (request) => request.teamId === input.teamId && request.status === "pending"
      )
    ) {
      return lifecycleFailure("not_empty", "The archived Team still has references");
    }
    const blocking = this.lifecycleAssetFailure(input, "deleting");
    if (blocking) return blocking;
    await this.deleteTeam(input.businessId, input.teamId);
    return { ok: true };
  }

  private lifecycleAssetFailure(
    input: TeamLifecycleTransitionInput,
    action: "archiving" | "deleting"
  ): TeamLifecycleTransitionResult | undefined {
    if (this.lifecycleReferences?.hasAssetReference(input.businessId, input.teamId)) {
      return lifecycleFailure(
        "not_empty",
        `Transfer or remove asset ownership and shares before ${action} this Team`
      );
    }
    if (this.lifecycleReferences?.hasPendingApproval(input.businessId, input.teamId, input.now)) {
      return lifecycleFailure(
        "not_empty",
        `Resolve pending ownership Approvals before ${action} this Team`
      );
    }
    return undefined;
  }

  async resolveLegacyGroupId(businessId: string, groupId: string): Promise<string | undefined> {
    return this.legacyGroups.get(teamKey(businessId, groupId));
  }

  async putLegacyGroupMapping(businessId: string, groupId: string, teamId: string): Promise<void> {
    this.legacyGroups.set(teamKey(businessId, groupId), teamId);
  }

  async putMembership(record: TeamMembershipRecord): Promise<void> {
    if (record.level === "admin" && record.principalKind !== "user") {
      throw new Error("Only people may be Team admins");
    }
    const key = teamKey(record.teamId, record.principalId);
    const previous = this.memberships.get(key);
    if (previous && record.revision !== previous.revision + 1) {
      throw new Error("Team membership revision conflict");
    }
    if (!previous && record.revision !== 1) {
      throw new Error("A new Team membership starts at revision 1");
    }
    this.memberships.set(key, Object.freeze({ ...record }));
    const businessId = this.businessIdForTeam(record.teamId);
    if (businessId) this.bumpAuthorityRevision(businessId);
  }

  async removeMembership(
    teamId: string,
    principalId: string,
    expectedRevision?: number
  ): Promise<void> {
    const key = teamKey(teamId, principalId);
    const membership = this.memberships.get(key);
    if (expectedRevision !== undefined && membership?.revision !== expectedRevision) {
      throw new Error("Team membership revision conflict");
    }
    this.memberships.delete(key);
    const businessId = this.businessIdForTeam(teamId);
    if (membership && businessId) this.bumpAuthorityRevision(businessId);
  }

  async getMembership(
    teamId: string,
    principalId: string
  ): Promise<TeamMembershipRecord | undefined> {
    return this.memberships.get(teamKey(teamId, principalId));
  }

  async listMemberships(teamId: string, now: Date): Promise<TeamMembershipRecord[]> {
    const team = [...this.teams.values()].find((candidate) => candidate.id === teamId);
    if (team?.status !== "active") return [];
    return [...this.memberships.values()].filter(
      (membership) => membership.teamId === teamId && active(membership, now)
    );
  }

  async listAllMemberships(teamId: string): Promise<TeamMembershipRecord[]> {
    return [...this.memberships.values()].filter((membership) => membership.teamId === teamId);
  }

  async listPrincipalMemberships(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<TeamMembershipRecord[]> {
    const teamIds = new Set(
      [...this.teams.values()]
        .filter((team) => team.businessId === businessId)
        .map((team) => team.id)
    );
    return [...this.memberships.values()].filter(
      (membership) =>
        teamIds.has(membership.teamId) &&
        membership.principalId === principalId &&
        active(membership, now)
    );
  }

  async listAllPrincipalMemberships(
    businessId: string,
    principalId: string
  ): Promise<TeamMembershipRecord[]> {
    const businessTeamIds = new Set(
      [...this.teams.values()]
        .filter((team) => team.businessId === businessId)
        .map((team) => team.id)
    );
    return [...this.memberships.values()].filter(
      (membership) =>
        businessTeamIds.has(membership.teamId) && membership.principalId === principalId
    );
  }

  async assignRole(record: TeamRoleAssignmentRecord): Promise<void> {
    this.roles.set(teamKey(record.teamId, record.roleId), Object.freeze({ ...record }));
    const businessId = this.businessIdForTeam(record.teamId);
    if (businessId) this.bumpAuthorityRevision(businessId);
  }

  async revokeRole(teamId: string, roleId: string): Promise<void> {
    const deleted = this.roles.delete(teamKey(teamId, roleId));
    const businessId = this.businessIdForTeam(teamId);
    if (deleted && businessId) this.bumpAuthorityRevision(businessId);
  }

  async listRoleAssignments(teamId: string, now: Date): Promise<TeamRoleAssignmentRecord[]> {
    const team = [...this.teams.values()].find((candidate) => candidate.id === teamId);
    if (team?.status !== "active") return [];
    return [...this.roles.values()].filter(
      (assignment) => assignment.teamId === teamId && active(assignment, now)
    );
  }

  async listAllRoleAssignments(teamId: string): Promise<TeamRoleAssignmentRecord[]> {
    return [...this.roles.values()].filter((assignment) => assignment.teamId === teamId);
  }

  async putGrant(record: TeamGrantRecord): Promise<void> {
    this.grants.set(record.id, Object.freeze({ ...record }));
    const businessId = this.businessIdForTeam(record.teamId);
    if (businessId) this.bumpAuthorityRevision(businessId);
  }

  async deleteGrant(teamId: string, grantId: string): Promise<void> {
    const grant = this.grants.get(grantId);
    if (grant?.teamId === teamId) {
      this.grants.delete(grantId);
      const businessId = this.businessIdForTeam(teamId);
      if (businessId) this.bumpAuthorityRevision(businessId);
    }
  }

  async listGrants(teamId: string, now: Date): Promise<TeamGrantRecord[]> {
    const team = [...this.teams.values()].find((candidate) => candidate.id === teamId);
    if (team?.status !== "active") return [];
    return [...this.grants.values()].filter(
      (grant) => grant.teamId === teamId && active(grant, now)
    );
  }

  async listAllGrants(teamId: string): Promise<TeamGrantRecord[]> {
    return [...this.grants.values()].filter((grant) => grant.teamId === teamId);
  }

  async putDelegationPolicy(record: TeamDelegationPolicyRecord): Promise<void> {
    const previous = this.policies.get(record.teamId);
    if (previous && record.revision !== previous.revision + 1) {
      throw new TeamDelegationPolicyRevisionConflictError(
        "Team delegation policy revision conflict"
      );
    }
    if (!previous && record.revision !== 1) {
      throw new TeamDelegationPolicyRevisionConflictError(
        "A new Team delegation policy starts at revision 1"
      );
    }
    this.policies.set(record.teamId, Object.freeze({ ...record }));
    const businessId = this.businessIdForTeam(record.teamId);
    if (businessId) this.bumpAuthorityRevision(businessId);
  }

  async getDelegationPolicy(teamId: string): Promise<TeamDelegationPolicyRecord | undefined> {
    return this.policies.get(teamId);
  }

  async putLeaveRequest(record: TeamLeaveRequestRecord): Promise<void> {
    const previous = this.leaveRequests.get(record.id);
    if (previous && record.revision !== previous.revision + 1) {
      throw new Error("Team leave request revision conflict");
    }
    if (!previous && record.revision !== 1) {
      throw new Error("A new Team leave request starts at revision 1");
    }
    if (
      record.status === "pending" &&
      [...this.leaveRequests.values()].some(
        (request) =>
          request.id !== record.id &&
          request.teamId === record.teamId &&
          request.principalId === record.principalId &&
          request.status === "pending"
      )
    ) {
      throw new Error("A pending Team leave request already exists");
    }
    this.leaveRequests.set(record.id, Object.freeze({ ...record }));
  }

  async getLeaveRequest(
    teamId: string,
    requestId: string
  ): Promise<TeamLeaveRequestRecord | undefined> {
    const request = this.leaveRequests.get(requestId);
    return request?.teamId === teamId ? request : undefined;
  }

  async listLeaveRequests(teamId: string): Promise<TeamLeaveRequestRecord[]> {
    return [...this.leaveRequests.values()]
      .filter((request) => request.teamId === teamId)
      .sort((left, right) => left.requestedAt.getTime() - right.requestedAt.getTime());
  }

  async recoverAdmin(input: RecoverTeamAdminInput): Promise<TeamMembershipRecord> {
    const team = await this.getTeam(input.businessId, input.teamId);
    if (!team || team.revision !== input.teamRevision) {
      throw new Error("Team revision conflict");
    }
    const hasActiveAdmin = [...this.memberships.values()].some(
      (membership) =>
        membership.teamId === input.teamId &&
        membership.principalKind === "user" &&
        membership.level === "admin" &&
        (!membership.expiresAt || membership.expiresAt > input.now)
    );
    if (hasActiveAdmin) {
      throw new Error("Team admin recovery requires a Team with no active human admins");
    }
    const key = teamKey(input.teamId, input.principalId);
    const membership = this.memberships.get(key);
    if (!membership) {
      throw new Error("Team admin recovery requires an active direct human membership");
    }
    if (
      membership.principalKind !== "user" ||
      (membership.expiresAt && membership.expiresAt <= input.now)
    ) {
      throw new Error("Team admin recovery requires an active direct human membership");
    }
    const recovered = Object.freeze({
      ...membership,
      level: "admin" as const,
      expiresAt: undefined,
      revision: membership.revision + 1,
      updatedAt: input.now,
    });
    this.memberships.set(key, recovered);
    this.bumpAuthorityRevision(input.businessId);
    return recovered;
  }

  async getAuthorityRevision(businessId: string): Promise<number> {
    return this.authorityRevisions.get(businessId) ?? 0;
  }

  async getMoveBindingEvidenceDigest(_businessId: string): Promise<string> {
    return canonicalHash({});
  }

  async createMovePreview(record: TeamMovePreviewRecord): Promise<void> {
    if ((await this.getAuthorityRevision(record.businessId)) !== record.authorityRevision) {
      throw new Error("Team move preview authority revision conflict");
    }
    if (this.movePreviews.has(record.tokenDigest)) {
      throw new Error("Team move preview token conflict");
    }
    if (
      record.bindingEvidenceDigest !== (await this.getMoveBindingEvidenceDigest(record.businessId))
    ) {
      throw new Error("Team move preview evidence changed");
    }
    this.movePreviews.set(record.tokenDigest, Object.freeze({ ...record }));
  }

  async confirmMove(input: ConfirmTeamMoveInput): Promise<TeamRecord> {
    const preview = this.movePreviews.get(input.tokenDigest);
    if (
      !preview ||
      preview.businessId !== input.businessId ||
      preview.teamId !== input.teamId ||
      preview.proposedParentTeamId !== input.proposedParentTeamId
    ) {
      throw new Error("Team move preview is invalid");
    }
    if (preview.consumedAt) throw new Error("Team move preview was already used");
    if (preview.expiresAt <= input.now) throw new Error("Team move preview has expired");
    if (preview.bindingEvidenceDigest !== input.bindingEvidenceDigest) {
      throw new Error("Team move preview is stale");
    }
    if (preview.impactDigest !== input.impactDigest) {
      throw new Error("Team move preview is stale");
    }
    if (
      input.bindingEvidenceDigest !== (await this.getMoveBindingEvidenceDigest(input.businessId))
    ) {
      throw new Error("Team move preview is stale");
    }
    if ((await this.getAuthorityRevision(input.businessId)) !== preview.authorityRevision) {
      throw new Error("Team move preview is stale");
    }
    const team = await this.getTeam(input.businessId, input.teamId);
    const parent = await this.getTeam(input.businessId, input.proposedParentTeamId);
    if (
      !team ||
      !parent ||
      team.revision !== preview.teamRevision ||
      parent.revision !== preview.parentRevision
    ) {
      throw new Error("Team move preview is stale");
    }
    const updated: TeamRecord = {
      ...team,
      parentTeamId: parent.id,
      revision: team.revision + 1,
      updatedAt: input.now,
    };
    this.validateHierarchy(updated);
    this.validateDescendantDepth(updated);
    this.teams.set(teamKey(updated.businessId, updated.id), Object.freeze({ ...updated }));
    this.bumpAuthorityRevision(updated.businessId);
    this.movePreviews.set(
      preview.tokenDigest,
      Object.freeze({ ...preview, consumedAt: input.now })
    );
    return updated;
  }

  private validateHierarchy(record: TeamRecord): void {
    if (!record.parentTeamId) {
      if (
        record.slug !== EVERYONE_TEAM_SLUG ||
        record.displayName !== "Everyone" ||
        !record.protected ||
        record.status !== "active"
      ) {
        throw new Error("The only root Team is protected Everyone");
      }
      if (
        [...this.teams.values()].some(
          (team) =>
            team.businessId === record.businessId && !team.parentTeamId && team.id !== record.id
        )
      ) {
        throw new Error("A business may have only one root Team");
      }
      return;
    }
    if (record.protected) throw new Error("Only Everyone may be protected");
    let parentId: string | undefined = record.parentTeamId;
    let depth = 1;
    while (parentId) {
      if (parentId === record.id) throw new Error("Team hierarchy cannot contain a cycle");
      const parent = this.teams.get(teamKey(record.businessId, parentId));
      if (!parent) throw new Error("Every Team must descend from Everyone");
      depth += 1;
      if (depth > MAX_TEAM_DEPTH) throw new Error("Team hierarchy cannot exceed 10 levels");
      if (!parent.parentTeamId && parent.slug !== EVERYONE_TEAM_SLUG) {
        throw new Error("Every Team must descend from Everyone");
      }
      parentId = parent.parentTeamId;
    }
  }

  private validateDescendantDepth(record: TeamRecord): void {
    const byParent = new Map<string, TeamRecord[]>();
    for (const team of this.teams.values()) {
      if (!team.parentTeamId || team.id === record.id) continue;
      const children = byParent.get(team.parentTeamId) ?? [];
      children.push(team);
      byParent.set(team.parentTeamId, children);
    }
    let ancestorDepth = 1;
    let parentId = record.parentTeamId;
    while (parentId) {
      ancestorDepth += 1;
      parentId = this.teams.get(teamKey(record.businessId, parentId))?.parentTeamId;
    }
    const visit = (teamId: string, depth: number, path: ReadonlySet<string>): void => {
      if (depth > MAX_TEAM_DEPTH) throw new Error("Team hierarchy cannot exceed 10 levels");
      for (const child of byParent.get(teamId) ?? []) {
        if (path.has(child.id)) throw new Error("Team hierarchy cannot contain a cycle");
        visit(child.id, depth + 1, new Set([...path, child.id]));
      }
    };
    visit(record.id, ancestorDepth, new Set([record.id]));
  }
}

interface TeamRow {
  id: string;
  business_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  labels: string[];
  parent_team_id: string | null;
  status: TeamLifecycleStatus;
  protected: boolean;
  revision: number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

interface TeamLifecycleReferenceRow {
  has_children: boolean;
  has_memberships: boolean;
  has_roles: boolean;
  has_grants: boolean;
  has_policy: boolean;
  has_pending_leave: boolean;
}

interface MembershipRow {
  team_id: string;
  principal_id: string;
  principal_kind: TeamMemberPrincipalKind;
  level: TeamMembershipLevel;
  expires_at: Date | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface RoleAssignmentRow {
  team_id: string;
  role_id: string;
  expires_at: Date | null;
  assigned_at: Date;
}

interface GrantRow {
  id: string;
  team_id: string;
  action: string;
  resource_type: string;
  domain: string | null;
  record_selector: string | null;
  field_selector: string[] | null;
  data_class: string | null;
  destination: string | null;
  conditions: unknown;
  effect: "allow" | "deny";
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface PolicyRow {
  team_id: string;
  allowed_role_ids: string[];
  allowed_grant_scopes: unknown;
  revision: number;
  updated_at: Date;
}

interface LeaveRequestRow {
  id: string;
  team_id: string;
  principal_id: string;
  status: TeamLeaveRequestStatus;
  revision: number;
  requested_at: Date;
  decided_at: Date | null;
  decided_by_principal_id: string | null;
}

interface MovePreviewRow {
  token_digest: string;
  business_id: string;
  team_id: string;
  proposed_parent_team_id: string;
  team_revision: number;
  parent_revision: number;
  authority_revision: string | number;
  binding_evidence_digest: string;
  impact_digest: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

function fromTeamRow(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    slug: row.slug,
    displayName: row.display_name,
    ...(row.description === null ? {} : { description: row.description }),
    labels: row.labels,
    ...(row.parent_team_id === null ? {} : { parentTeamId: row.parent_team_id }),
    status: row.status,
    protected: row.protected,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
  };
}

function fromMembershipRow(row: MembershipRow): TeamMembershipRecord {
  return {
    teamId: row.team_id,
    principalId: row.principal_id,
    principalKind: row.principal_kind,
    level: row.level,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function leaveRequestFromRow(row: LeaveRequestRow): TeamLeaveRequestRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    principalId: row.principal_id,
    status: row.status,
    revision: row.revision,
    requestedAt: row.requested_at,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    ...(row.decided_by_principal_id === null
      ? {}
      : { decidedByPrincipalId: row.decided_by_principal_id }),
  };
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Object.values(parsed).every((item) => typeof item === "string")
  ) {
    throw new Error("Team grant conditions must be a string-valued object");
  }
  return parsed as Readonly<Record<string, string>>;
}

function grantScopes(value: unknown): readonly TeamDelegationGrantScope[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) throw new Error("Team delegation scopes must be an array");
  return parsed as readonly TeamDelegationGrantScope[];
}

const TEAM_COLUMNS =
  "id, business_id, slug, display_name, description, labels, parent_team_id, status, protected, revision, created_at, updated_at, archived_at";

async function lockMoveBindingEvidence(transaction: Queryable): Promise<void> {
  await transaction.query(
    `LOCK TABLE roles, role_parent_roles, role_grants,
                asset_ownership, asset_owners, asset_team_shares IN SHARE MODE`
  );
}

async function moveBindingEvidenceDigest(
  transaction: Queryable,
  businessId: string
): Promise<string> {
  const [roles, parents, grants, ownership, owners, shares] = await Promise.all([
    transaction.query(
      `SELECT id, assignable_to, expires_at
         FROM roles
        WHERE business_id = $1
        ORDER BY id`,
      [businessId]
    ),
    transaction.query(
      `SELECT role_id, parent_role_id, parent_index
         FROM role_parent_roles
        WHERE business_id = $1
        ORDER BY role_id, parent_index`,
      [businessId]
    ),
    transaction.query(
      `SELECT role_id, grant_index, action, resource_type, domain, record_selector,
              field_selector, data_class, destination, conditions, effect, expires_at
         FROM role_grants
        WHERE business_id = $1
        ORDER BY role_id, grant_index`,
      [businessId]
    ),
    transaction.query(
      `SELECT asset_type, asset_id, revision
         FROM asset_ownership
        WHERE business_id = $1
        ORDER BY asset_type, asset_id`,
      [businessId]
    ),
    transaction.query(
      `SELECT asset_type, asset_id, owner_kind, team_id::text, principal_id, principal_kind
         FROM asset_owners
        WHERE business_id = $1
        ORDER BY asset_type, asset_id, owner_kind, team_id, principal_id`,
      [businessId]
    ),
    transaction.query(
      `SELECT asset_type, asset_id, team_id::text, access, revision
         FROM asset_team_shares
        WHERE business_id = $1
        ORDER BY asset_type, asset_id, team_id`,
      [businessId]
    ),
  ]);
  return canonicalHash({
    roles: roles.rows,
    parents: parents.rows,
    grants: grants.rows,
    ownership: ownership.rows,
    owners: owners.rows,
    shares: shares.rows,
  });
}

export class PgTeamRepo implements TeamRepo {
  constructor(private readonly transactions: TransactionPort) {}

  async ensureEveryone(businessId: string): Promise<TeamRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO teams (business_id, slug, display_name, protected)
         VALUES ($1, 'everyone', 'Everyone', true)
         ON CONFLICT (business_id, slug) DO NOTHING`,
        [businessId]
      );
      const result = await transaction.query<TeamRow>(
        `SELECT ${TEAM_COLUMNS} FROM teams WHERE business_id = $1 AND slug = 'everyone'`,
        [businessId]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Everyone Team could not be created");
      return fromTeamRow(row);
    });
  }

  async getTeam(businessId: string, teamId: string): Promise<TeamRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<TeamRow>(
        `SELECT ${TEAM_COLUMNS} FROM teams WHERE business_id = $1 AND id = $2`,
        [businessId, teamId]
      );
      return result.rows[0] ? fromTeamRow(result.rows[0]) : undefined;
    });
  }

  async getTeamBySlug(businessId: string, slug: string): Promise<TeamRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<TeamRow>(
        `SELECT ${TEAM_COLUMNS} FROM teams WHERE business_id = $1 AND slug = $2`,
        [businessId, slug]
      );
      return result.rows[0] ? fromTeamRow(result.rows[0]) : undefined;
    });
  }

  async listTeams(businessId: string): Promise<TeamRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<TeamRow>(
        `SELECT ${TEAM_COLUMNS} FROM teams WHERE business_id = $1 ORDER BY slug`,
        [businessId]
      );
      return result.rows.map(fromTeamRow);
    });
  }

  async createTeam(
    record: TeamRecord,
    memberships: readonly TeamMembershipRecord[]
  ): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO teams (
           id, business_id, slug, display_name, description, labels, parent_team_id, status,
           protected, revision, created_at, updated_at, archived_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          record.id,
          record.businessId,
          record.slug,
          record.displayName,
          record.description ?? null,
          record.labels ?? [],
          record.parentTeamId ?? null,
          record.status,
          record.protected,
          record.revision,
          record.createdAt,
          record.updatedAt,
          record.archivedAt ?? null,
        ]
      );
      for (const membership of memberships) {
        await transaction.query(
          `INSERT INTO team_memberships (
             team_id, principal_id, principal_kind, level, expires_at, revision, created_at,
             updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            membership.teamId,
            membership.principalId,
            membership.principalKind,
            membership.level,
            membership.expiresAt ?? null,
            membership.revision,
            membership.createdAt,
            membership.updatedAt,
          ]
        );
      }
    });
  }

  async putTeam(record: TeamRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ id: string }>(
        `INSERT INTO teams (
           id, business_id, slug, display_name, description, labels, parent_team_id, status,
           protected, revision, created_at, updated_at, archived_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           labels = EXCLUDED.labels,
           parent_team_id = EXCLUDED.parent_team_id,
           status = EXCLUDED.status,
           protected = EXCLUDED.protected,
           revision = EXCLUDED.revision,
           updated_at = EXCLUDED.updated_at,
           archived_at = EXCLUDED.archived_at
         WHERE teams.revision = EXCLUDED.revision - 1
         RETURNING id`,
        [
          record.id,
          record.businessId,
          record.slug,
          record.displayName,
          record.description ?? null,
          record.labels ?? [],
          record.parentTeamId ?? null,
          record.status,
          record.protected,
          record.revision,
          record.createdAt,
          record.updatedAt,
          record.archivedAt ?? null,
        ]
      );
      if (result.rows.length === 0) throw new Error("Team revision conflict");
    });
  }

  async deleteTeam(businessId: string, teamId: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query("DELETE FROM teams WHERE business_id = $1 AND id = $2", [
        businessId,
        teamId,
      ]);
    });
  }

  async transitionLifecycle(
    input: TeamLifecycleTransitionInput
  ): Promise<TeamLifecycleTransitionResult> {
    return this.transactions.withTransaction(async (transaction) => {
      const locked = await transaction.query<TeamRow>(
        `SELECT ${TEAM_COLUMNS}
           FROM teams
          WHERE business_id = $1 AND id = $2
          FOR UPDATE`,
        [input.businessId, input.teamId]
      );
      const row = locked.rows[0];
      if (!row) return lifecycleFailure("not_found", "Team was not found");
      const team = fromTeamRow(row);
      if (team.protected) return lifecycleFailure("protected", "Everyone is protected");
      if (team.revision !== input.expectedRevision) {
        return lifecycleFailure("conflict", "Team revision conflict");
      }

      const references = await transaction.query<TeamLifecycleReferenceRow>(
        `SELECT
           EXISTS (
             SELECT 1 FROM teams
              WHERE business_id = $1 AND parent_team_id = $2
           ) AS has_children,
           EXISTS (SELECT 1 FROM team_memberships WHERE team_id = $2) AS has_memberships,
           EXISTS (SELECT 1 FROM team_role_assignments WHERE team_id = $2) AS has_roles,
           EXISTS (SELECT 1 FROM team_grants WHERE team_id = $2) AS has_grants,
           EXISTS (SELECT 1 FROM team_delegation_policies WHERE team_id = $2) AS has_policy,
           EXISTS (
             SELECT 1 FROM team_leave_requests
              WHERE team_id = $2 AND status = 'pending'
           ) AS has_pending_leave`,
        [input.businessId, input.teamId]
      );
      const refs = references.rows[0];
      if (!refs) throw new Error("Team lifecycle reference query returned no row");

      if (input.action === "archive") {
        if (team.status !== "active") return lifecycleFailure("invalid", "Team is archived");
        if (refs.has_children) {
          return lifecycleFailure("not_empty", "Move child Teams before archiving this Team");
        }
      } else {
        if (team.status !== "archived") {
          return lifecycleFailure("invalid", "Only an archived Team can be deleted");
        }
        if (
          refs.has_children ||
          refs.has_memberships ||
          refs.has_roles ||
          refs.has_grants ||
          refs.has_policy ||
          refs.has_pending_leave
        ) {
          return lifecycleFailure("not_empty", "The archived Team still has references");
        }
      }

      const action = input.action === "archive" ? "archiving" : "deleting";
      const assetFailure = await this.lifecycleAssetFailure(transaction, input, action);
      if (assetFailure) return assetFailure;

      if (input.action === "delete") {
        await transaction.query("DELETE FROM teams WHERE business_id = $1 AND id = $2", [
          input.businessId,
          input.teamId,
        ]);
        return { ok: true };
      }

      const archived = await transaction.query<TeamRow>(
        `UPDATE teams
            SET status = 'archived',
                archived_at = $3,
                updated_at = $3,
                revision = revision + 1
          WHERE business_id = $1 AND id = $2 AND status = 'active' AND revision = $4
          RETURNING ${TEAM_COLUMNS}`,
        [input.businessId, input.teamId, input.now, input.expectedRevision]
      );
      const archivedRow = archived.rows[0];
      if (!archivedRow) return lifecycleFailure("conflict", "Team revision conflict");
      return { ok: true, team: fromTeamRow(archivedRow) };
    });
  }

  private async lifecycleAssetFailure(
    transaction: Queryable,
    input: TeamLifecycleTransitionInput,
    action: "archiving" | "deleting"
  ): Promise<TeamLifecycleTransitionResult | undefined> {
    const references = await transaction.query<{ has_reference: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1
             FROM asset_owners
            WHERE business_id = $1 AND owner_kind = 'team' AND team_id = $2
         )
         OR EXISTS (
           SELECT 1
             FROM asset_team_shares
            WHERE business_id = $1 AND team_id = $2
         )
       ) AS has_reference`,
      [input.businessId, input.teamId]
    );
    if (references.rows[0]?.has_reference) {
      return lifecycleFailure(
        "not_empty",
        `Transfer or remove asset ownership and shares before ${action} this Team`
      );
    }

    const approvals = await transaction.query<{ has_pending_approval: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM asset_ownership_operations operation
           JOIN asset_ownership_approvals approval
             ON approval.business_id = operation.business_id
            AND approval.approval_id = operation.approval_id
          WHERE operation.business_id = $1
            AND operation.status = 'pending'
            AND approval.consumed_at IS NULL
            AND approval.revoked_at IS NULL
            AND approval.expires_at > $3
            AND NOT EXISTS (
              SELECT 1
                FROM asset_ownership_approval_decisions decision
               WHERE decision.approval_id = approval.approval_id
                 AND decision.outcome = 'denied'
            )
            AND (
              operation.team_id = $2
              OR EXISTS (
                SELECT 1
                  FROM asset_owners owner
                 WHERE owner.business_id = operation.business_id
                   AND owner.asset_type = operation.asset_type
                   AND owner.asset_id = operation.asset_id
                   AND owner.owner_kind = 'team'
                   AND owner.team_id = $2
              )
            )
       ) AS has_pending_approval`,
      [input.businessId, input.teamId, input.now]
    );
    if (approvals.rows[0]?.has_pending_approval) {
      return lifecycleFailure(
        "not_empty",
        `Resolve pending ownership Approvals before ${action} this Team`
      );
    }
    return undefined;
  }

  async resolveLegacyGroupId(businessId: string, groupId: string): Promise<string | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ team_id: string }>(
        `SELECT team_id FROM legacy_group_team_mappings
          WHERE business_id = $1 AND group_id = $2`,
        [businessId, groupId]
      );
      return result.rows[0]?.team_id;
    });
  }

  async putLegacyGroupMapping(businessId: string, groupId: string, teamId: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO legacy_group_team_mappings (business_id, group_id, team_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (business_id, group_id) DO UPDATE SET team_id = EXCLUDED.team_id`,
        [businessId, groupId, teamId]
      );
    });
  }

  async putMembership(record: TeamMembershipRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ team_id: string }>(
        `INSERT INTO team_memberships (
           team_id, principal_id, principal_kind, level, expires_at, revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (team_id, principal_id) DO UPDATE SET
           principal_kind = EXCLUDED.principal_kind,
           level = EXCLUDED.level,
           expires_at = EXCLUDED.expires_at,
           revision = EXCLUDED.revision,
           updated_at = EXCLUDED.updated_at
         WHERE team_memberships.revision = EXCLUDED.revision - 1
         RETURNING team_id`,
        [
          record.teamId,
          record.principalId,
          record.principalKind,
          record.level,
          record.expiresAt ?? null,
          record.revision,
          record.createdAt,
          record.updatedAt,
        ]
      );
      if (result.rows.length === 0) throw new Error("Team membership revision conflict");
    });
  }

  async removeMembership(
    teamId: string,
    principalId: string,
    expectedRevision?: number
  ): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ team_id: string }>(
        `DELETE FROM team_memberships
          WHERE team_id = $1 AND principal_id = $2
            AND ($3::integer IS NULL OR revision = $3)
        RETURNING team_id`,
        [teamId, principalId, expectedRevision ?? null]
      );
      if (expectedRevision !== undefined && result.rows.length === 0) {
        throw new Error("Team membership revision conflict");
      }
    });
  }

  async getMembership(
    teamId: string,
    principalId: string
  ): Promise<TeamMembershipRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<MembershipRow>(
        `SELECT membership.team_id, membership.principal_id, membership.principal_kind,
                membership.level, membership.expires_at, membership.revision,
                membership.created_at, membership.updated_at
           FROM team_memberships membership
          WHERE membership.team_id = $1 AND membership.principal_id = $2`,
        [teamId, principalId]
      );
      return result.rows[0] ? fromMembershipRow(result.rows[0]) : undefined;
    });
  }

  async recoverAdmin(input: RecoverTeamAdminInput): Promise<TeamMembershipRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const teamResult = await transaction.query<TeamRow>(
        `SELECT ${TEAM_COLUMNS}
           FROM teams
          WHERE business_id = $1 AND id = $2
          FOR UPDATE`,
        [input.businessId, input.teamId]
      );
      const team = teamResult.rows[0];
      if (!team || team.revision !== input.teamRevision) {
        throw new Error("Team revision conflict");
      }
      if (team.status !== "active" || team.protected) {
        throw new Error("Team admin recovery requires an active mutable Team");
      }

      const activeAdmins = await transaction.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM team_memberships membership
             JOIN principals principal
               ON principal.business_id = $1
              AND principal.id = membership.principal_id
            WHERE membership.team_id = $2
              AND membership.principal_kind = 'user'
              AND membership.level = 'admin'
              AND (membership.expires_at IS NULL OR membership.expires_at > $3)
              AND principal.kind = 'user'
              AND principal.status = 'active'
              AND (principal.expires_at IS NULL OR principal.expires_at > $3)
         ) AS present`,
        [input.businessId, input.teamId, input.now]
      );
      if (activeAdmins.rows[0]?.present) {
        throw new Error("Team admin recovery requires a Team with no active human admins");
      }

      const target = await transaction.query<MembershipRow>(
        `SELECT membership.team_id, membership.principal_id, membership.principal_kind,
                membership.level, membership.expires_at, membership.revision,
                membership.created_at, membership.updated_at
           FROM team_memberships membership
           JOIN principals principal
             ON principal.business_id = $1
            AND principal.id = membership.principal_id
          WHERE membership.team_id = $2
            AND membership.principal_id = $3
            AND membership.principal_kind = 'user'
            AND (membership.expires_at IS NULL OR membership.expires_at > $4)
            AND principal.kind = 'user'
            AND principal.status = 'active'
            AND (principal.expires_at IS NULL OR principal.expires_at > $4)
          FOR UPDATE OF membership`,
        [input.businessId, input.teamId, input.principalId, input.now]
      );
      const membership = target.rows[0];
      if (!membership) {
        throw new Error("Team admin recovery requires an active direct human membership");
      }

      const recovered = await transaction.query<MembershipRow>(
        `UPDATE team_memberships
            SET level = 'admin', expires_at = NULL, revision = revision + 1, updated_at = $4
          WHERE team_id = $1 AND principal_id = $2 AND revision = $3
          RETURNING team_id, principal_id, principal_kind, level, expires_at, revision,
                    created_at, updated_at`,
        [input.teamId, input.principalId, membership.revision, input.now]
      );
      const row = recovered.rows[0];
      if (!row) throw new Error("Team membership revision conflict");
      return fromMembershipRow(row);
    });
  }

  async listMemberships(teamId: string, now: Date): Promise<TeamMembershipRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<MembershipRow>(
        `SELECT membership.team_id, membership.principal_id, membership.principal_kind,
                membership.level, membership.expires_at, membership.revision,
                membership.created_at, membership.updated_at
           FROM team_memberships membership
           JOIN teams team ON team.id = membership.team_id
          WHERE membership.team_id = $1 AND team.status = 'active'
            AND (membership.expires_at IS NULL OR membership.expires_at > $2)
          ORDER BY principal_id`,
        [teamId, now]
      );
      return result.rows.map(fromMembershipRow);
    });
  }

  async listAllMemberships(teamId: string): Promise<TeamMembershipRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<MembershipRow>(
        `SELECT team_id, principal_id, principal_kind, level, expires_at, revision, created_at,
                updated_at
           FROM team_memberships
          WHERE team_id = $1
          ORDER BY principal_id`,
        [teamId]
      );
      return result.rows.map(fromMembershipRow);
    });
  }

  async listPrincipalMemberships(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<TeamMembershipRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<MembershipRow>(
        `SELECT membership.team_id, membership.principal_id, membership.principal_kind,
                membership.level, membership.expires_at, membership.revision,
                membership.created_at, membership.updated_at
           FROM team_memberships membership
           JOIN teams team ON team.id = membership.team_id
          WHERE team.business_id = $1 AND membership.principal_id = $2
             AND team.status = 'active'
             AND (membership.expires_at IS NULL OR membership.expires_at > $3)
          ORDER BY team.slug`,
        [businessId, principalId, now]
      );
      return result.rows.map(fromMembershipRow);
    });
  }

  async listAllPrincipalMemberships(
    businessId: string,
    principalId: string
  ): Promise<TeamMembershipRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<MembershipRow>(
        `SELECT membership.team_id, membership.principal_id, membership.principal_kind,
                membership.level, membership.expires_at, membership.revision,
                membership.created_at, membership.updated_at
           FROM team_memberships membership
           JOIN teams team ON team.id = membership.team_id
          WHERE team.business_id = $1 AND membership.principal_id = $2
          ORDER BY team.slug`,
        [businessId, principalId]
      );
      return result.rows.map(fromMembershipRow);
    });
  }

  async assignRole(record: TeamRoleAssignmentRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ team_id: string }>(
        `INSERT INTO team_role_assignments
           (team_id, role_business_id, role_id, expires_at, assigned_at)
         SELECT $1, business_id, $2, $3, $4 FROM teams WHERE id = $1
         ON CONFLICT (team_id, role_id) DO UPDATE SET
           expires_at = EXCLUDED.expires_at,
           assigned_at = EXCLUDED.assigned_at
         RETURNING team_id`,
        [record.teamId, record.roleId, record.expiresAt ?? null, record.assignedAt]
      );
      if (result.rows.length === 0) throw new Error("Team does not exist");
    });
  }

  async revokeRole(teamId: string, roleId: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        "DELETE FROM team_role_assignments WHERE team_id = $1 AND role_id = $2",
        [teamId, roleId]
      );
    });
  }

  async listRoleAssignments(teamId: string, now: Date): Promise<TeamRoleAssignmentRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RoleAssignmentRow>(
        `SELECT team_id, role_id, expires_at, assigned_at
           FROM team_role_assignments assignment
           JOIN teams team ON team.id = assignment.team_id
          WHERE assignment.team_id = $1 AND team.status = 'active'
            AND (assignment.expires_at IS NULL OR assignment.expires_at > $2)
          ORDER BY role_id`,
        [teamId, now]
      );
      return result.rows.map((row) => ({
        teamId: row.team_id,
        roleId: row.role_id,
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        assignedAt: row.assigned_at,
      }));
    });
  }

  async listAllRoleAssignments(teamId: string): Promise<TeamRoleAssignmentRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RoleAssignmentRow>(
        `SELECT team_id, role_id, expires_at, assigned_at
           FROM team_role_assignments
          WHERE team_id = $1
          ORDER BY role_id`,
        [teamId]
      );
      return result.rows.map((row) => ({
        teamId: row.team_id,
        roleId: row.role_id,
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        assignedAt: row.assigned_at,
      }));
    });
  }

  async putGrant(record: TeamGrantRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO team_grants (
           id, team_id, action, resource_type, domain, record_selector, field_selector,
           data_class, destination, conditions, effect, expires_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           action = EXCLUDED.action,
           resource_type = EXCLUDED.resource_type,
           domain = EXCLUDED.domain,
           record_selector = EXCLUDED.record_selector,
           field_selector = EXCLUDED.field_selector,
           data_class = EXCLUDED.data_class,
           destination = EXCLUDED.destination,
           conditions = EXCLUDED.conditions,
           effect = EXCLUDED.effect,
           expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at`,
        [
          record.id,
          record.teamId,
          record.action,
          record.resourceType,
          record.domain ?? null,
          record.recordSelector ?? null,
          record.fieldSelector ? [...record.fieldSelector] : null,
          record.dataClass ?? null,
          record.destination ?? null,
          record.conditions ? JSON.stringify(record.conditions) : null,
          record.effect,
          record.expiresAt ?? null,
          record.createdAt,
          record.updatedAt,
        ]
      );
    });
  }

  async deleteGrant(teamId: string, grantId: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query("DELETE FROM team_grants WHERE team_id = $1 AND id = $2", [
        teamId,
        grantId,
      ]);
    });
  }

  async listGrants(teamId: string, now: Date): Promise<TeamGrantRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<GrantRow>(
        `SELECT grant_row.id, grant_row.team_id, grant_row.action, grant_row.resource_type,
                grant_row.domain, grant_row.record_selector, grant_row.field_selector,
                grant_row.data_class, grant_row.destination, grant_row.conditions,
                grant_row.effect, grant_row.expires_at, grant_row.created_at, grant_row.updated_at
           FROM team_grants grant_row
           JOIN teams team ON team.id = grant_row.team_id
          WHERE grant_row.team_id = $1 AND team.status = 'active'
            AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $2)
          ORDER BY grant_row.created_at, grant_row.id`,
        [teamId, now]
      );
      return result.rows.map((row) => ({
        id: row.id,
        teamId: row.team_id,
        action: row.action,
        resourceType: row.resource_type,
        ...(row.domain === null ? {} : { domain: row.domain }),
        ...(row.record_selector === null ? {} : { recordSelector: row.record_selector }),
        ...(row.field_selector === null ? {} : { fieldSelector: row.field_selector }),
        ...(row.data_class === null ? {} : { dataClass: row.data_class }),
        ...(row.destination === null ? {} : { destination: row.destination }),
        ...(row.conditions === null ? {} : { conditions: stringRecord(row.conditions) }),
        effect: row.effect,
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    });
  }

  async listAllGrants(teamId: string): Promise<TeamGrantRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<GrantRow>(
        `SELECT id, team_id, action, resource_type, domain, record_selector, field_selector,
                data_class, destination, conditions, effect, expires_at, created_at, updated_at
           FROM team_grants
          WHERE team_id = $1
          ORDER BY created_at, id`,
        [teamId]
      );
      return result.rows.map((row) => ({
        id: row.id,
        teamId: row.team_id,
        action: row.action,
        resourceType: row.resource_type,
        ...(row.domain === null ? {} : { domain: row.domain }),
        ...(row.record_selector === null ? {} : { recordSelector: row.record_selector }),
        ...(row.field_selector === null ? {} : { fieldSelector: row.field_selector }),
        ...(row.data_class === null ? {} : { dataClass: row.data_class }),
        ...(row.destination === null ? {} : { destination: row.destination }),
        ...(row.conditions === null ? {} : { conditions: stringRecord(row.conditions) }),
        effect: row.effect,
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    });
  }

  async putDelegationPolicy(record: TeamDelegationPolicyRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const values = [
        record.teamId,
        [...record.allowedRoleIds],
        JSON.stringify(record.allowedGrantScopes),
        record.revision,
        record.updatedAt,
      ];
      const result =
        record.revision === 1
          ? await transaction.query<{ team_id: string }>(
              `INSERT INTO team_delegation_policies (
                 team_id, allowed_role_ids, allowed_grant_scopes, revision, updated_at
               ) VALUES ($1, $2, $3::jsonb, $4, $5)
               ON CONFLICT (team_id) DO NOTHING
               RETURNING team_id`,
              values
            )
          : await transaction.query<{ team_id: string }>(
              `UPDATE team_delegation_policies
                  SET allowed_role_ids = $2,
                      allowed_grant_scopes = $3::jsonb,
                      revision = $4,
                      updated_at = $5
                WHERE team_id = $1 AND revision = $4 - 1
              RETURNING team_id`,
              values
            );
      if (!result.rows[0]) {
        throw new TeamDelegationPolicyRevisionConflictError(
          "Team delegation policy revision conflict"
        );
      }
    });
  }

  async getDelegationPolicy(teamId: string): Promise<TeamDelegationPolicyRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<PolicyRow>(
        `SELECT team_id, allowed_role_ids, allowed_grant_scopes, revision, updated_at
           FROM team_delegation_policies WHERE team_id = $1`,
        [teamId]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        teamId: row.team_id,
        allowedRoleIds: row.allowed_role_ids,
        allowedGrantScopes: grantScopes(row.allowed_grant_scopes),
        revision: row.revision,
        updatedAt: row.updated_at,
      };
    });
  }

  async putLeaveRequest(record: TeamLeaveRequestRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ id: string }>(
        `INSERT INTO team_leave_requests (
           id, team_id, principal_id, status, revision, requested_at, decided_at,
           decided_by_principal_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           revision = EXCLUDED.revision,
           decided_at = EXCLUDED.decided_at,
           decided_by_principal_id = EXCLUDED.decided_by_principal_id
         WHERE team_leave_requests.revision = EXCLUDED.revision - 1
         RETURNING id`,
        [
          record.id,
          record.teamId,
          record.principalId,
          record.status,
          record.revision,
          record.requestedAt,
          record.decidedAt ?? null,
          record.decidedByPrincipalId ?? null,
        ]
      );
      if (result.rows.length === 0) throw new Error("Team leave request revision conflict");
    });
  }

  async getLeaveRequest(
    teamId: string,
    requestId: string
  ): Promise<TeamLeaveRequestRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<LeaveRequestRow>(
        `SELECT id, team_id, principal_id, status, revision, requested_at, decided_at,
                decided_by_principal_id
           FROM team_leave_requests
          WHERE team_id = $1 AND id = $2`,
        [teamId, requestId]
      );
      const row = result.rows[0];
      return row ? leaveRequestFromRow(row) : undefined;
    });
  }

  async listLeaveRequests(teamId: string): Promise<TeamLeaveRequestRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<LeaveRequestRow>(
        `SELECT id, team_id, principal_id, status, revision, requested_at, decided_at,
                decided_by_principal_id
           FROM team_leave_requests
          WHERE team_id = $1
          ORDER BY requested_at, id`,
        [teamId]
      );
      return result.rows.map(leaveRequestFromRow);
    });
  }

  async getAuthorityRevision(businessId: string): Promise<number> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ revision: string | number }>(
        "SELECT revision FROM team_authority_revisions WHERE business_id = $1",
        [businessId]
      );
      return Number(result.rows[0]?.revision ?? 0);
    });
  }

  async getMoveBindingEvidenceDigest(businessId: string): Promise<string> {
    return this.transactions.withTransaction((transaction) =>
      moveBindingEvidenceDigest(transaction, businessId)
    );
  }

  async createMovePreview(record: TeamMovePreviewRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await lockMoveBindingEvidence(transaction);
      const revision = await transaction.query<{ revision: string | number }>(
        "SELECT revision FROM team_authority_revisions WHERE business_id = $1 FOR UPDATE",
        [record.businessId]
      );
      if (Number(revision.rows[0]?.revision ?? 0) !== record.authorityRevision) {
        throw new Error("Team move preview authority revision conflict");
      }
      if (
        (await moveBindingEvidenceDigest(transaction, record.businessId)) !==
        record.bindingEvidenceDigest
      ) {
        throw new Error("Team move preview evidence changed");
      }
      await transaction.query(
        `INSERT INTO team_move_previews (
           token_digest, business_id, team_id, proposed_parent_team_id, team_revision,
           parent_revision, authority_revision, binding_evidence_digest, impact_digest,
           created_at, expires_at, consumed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)`,
        [
          record.tokenDigest,
          record.businessId,
          record.teamId,
          record.proposedParentTeamId,
          record.teamRevision,
          record.parentRevision,
          record.authorityRevision,
          record.bindingEvidenceDigest,
          record.impactDigest,
          record.createdAt,
          record.expiresAt,
        ]
      );
    });
  }

  async confirmMove(input: ConfirmTeamMoveInput): Promise<TeamRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      await lockMoveBindingEvidence(transaction);
      const previewResult = await transaction.query<MovePreviewRow>(
        `SELECT token_digest, business_id, team_id::text, proposed_parent_team_id::text,
                team_revision, parent_revision, authority_revision, binding_evidence_digest,
                impact_digest, created_at, expires_at, consumed_at
           FROM team_move_previews
          WHERE token_digest = $1
          FOR UPDATE`,
        [input.tokenDigest]
      );
      const preview = previewResult.rows[0];
      if (
        !preview ||
        preview.business_id !== input.businessId ||
        preview.team_id !== input.teamId ||
        preview.proposed_parent_team_id !== input.proposedParentTeamId
      ) {
        throw new Error("Team move preview is invalid");
      }
      if (preview.consumed_at) throw new Error("Team move preview was already used");
      if (preview.expires_at <= input.now) throw new Error("Team move preview has expired");
      if (preview.binding_evidence_digest !== input.bindingEvidenceDigest) {
        throw new Error("Team move preview is stale");
      }
      if (preview.impact_digest !== input.impactDigest) {
        throw new Error("Team move preview is stale");
      }
      if (
        (await moveBindingEvidenceDigest(transaction, input.businessId)) !==
        input.bindingEvidenceDigest
      ) {
        throw new Error("Team move preview is stale");
      }

      const authorityResult = await transaction.query<{ revision: string | number }>(
        "SELECT revision FROM team_authority_revisions WHERE business_id = $1 FOR UPDATE",
        [input.businessId]
      );
      if (Number(authorityResult.rows[0]?.revision ?? 0) !== Number(preview.authority_revision)) {
        throw new Error("Team move preview is stale");
      }

      const records = await transaction.query<TeamRow>(
        `SELECT ${TEAM_COLUMNS}
           FROM teams
          WHERE business_id = $1 AND id IN ($2, $3)
          ORDER BY id
          FOR UPDATE`,
        [input.businessId, input.teamId, input.proposedParentTeamId]
      );
      const teamRow = records.rows.find((row) => row.id === input.teamId);
      const parentRow = records.rows.find((row) => row.id === input.proposedParentTeamId);
      if (
        !teamRow ||
        !parentRow ||
        teamRow.status !== "active" ||
        parentRow.status !== "active" ||
        teamRow.protected ||
        teamRow.revision !== preview.team_revision ||
        parentRow.revision !== preview.parent_revision
      ) {
        throw new Error("Team move preview is stale");
      }

      const bounds = await transaction.query<{
        parent_depth: number;
        descendant_depth: number;
        cycle: boolean;
      }>(
        `WITH RECURSIVE
           ancestry AS (
             SELECT id, parent_team_id, 1 AS depth
               FROM teams
              WHERE business_id = $1 AND id = $3
             UNION ALL
             SELECT parent.id, parent.parent_team_id, ancestry.depth + 1
               FROM teams parent
               JOIN ancestry ON parent.id = ancestry.parent_team_id
              WHERE parent.business_id = $1 AND ancestry.depth < $4
           ),
           descendants AS (
             SELECT id, 0 AS depth
               FROM teams
              WHERE business_id = $1 AND id = $2
             UNION ALL
             SELECT child.id, descendants.depth + 1
               FROM teams child
               JOIN descendants ON child.parent_team_id = descendants.id
              WHERE child.business_id = $1 AND descendants.depth < $4
           )
         SELECT
           COALESCE((SELECT max(depth) FROM ancestry), 0)::integer AS parent_depth,
           COALESCE((SELECT max(depth) FROM descendants), 0)::integer AS descendant_depth,
           EXISTS (SELECT 1 FROM descendants WHERE id = $3) AS cycle`,
        [input.businessId, input.teamId, input.proposedParentTeamId, MAX_TEAM_DEPTH]
      );
      const bound = bounds.rows[0];
      if (!bound || bound.cycle) throw new Error("Team hierarchy cannot contain a cycle");
      if (bound.parent_depth + 1 + bound.descendant_depth > MAX_TEAM_DEPTH) {
        throw new Error("Team hierarchy cannot exceed 10 levels");
      }

      const moved = await transaction.query<TeamRow>(
        `UPDATE teams
            SET parent_team_id = $3, revision = revision + 1, updated_at = $4
          WHERE business_id = $1 AND id = $2 AND revision = $5
          RETURNING ${TEAM_COLUMNS}`,
        [
          input.businessId,
          input.teamId,
          input.proposedParentTeamId,
          input.now,
          preview.team_revision,
        ]
      );
      const movedRow = moved.rows[0];
      if (!movedRow) throw new Error("Team move preview is stale");
      await transaction.query(
        `UPDATE team_move_previews
            SET consumed_at = $2
          WHERE token_digest = $1 AND consumed_at IS NULL`,
        [input.tokenDigest, input.now]
      );
      return fromTeamRow(movedRow);
    });
  }
}
