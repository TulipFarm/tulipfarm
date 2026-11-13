import { z } from 'zod';
import {
  appIdSchema,
  appSlugSchema,
  buildIdSchema,
  edgeStatus,
  operationIdSchema,
  releaseIdSchema,
  versionIdSchema,
  type AppApproval,
  type AppDefinitionIssue,
  type AppDraftState,
  type AppFailure,
  type AppFailureCode,
} from '@tulipfarm/apps';
import {
  appFilePathSchema,
  type AppBuild,
  type AppDraft,
  type AppGrant,
  type AppGrantee,
  type AppRecord,
  type AppRelease,
  type AppRole,
  type AppVersion,
} from '@tulipfarm/apps/store';

const requestId = z.uuid();
const title = z.string().trim().min(1).max(120);

export const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
export const appParams = z.strictObject({ workspaceId: z.uuid(), appId: appIdSchema });
export const grantParams = z.strictObject({ workspaceId: z.uuid(), appId: appIdSchema, grantee: z.string().max(80) });
export const buildParams = z.strictObject({ workspaceId: z.uuid(), appId: appIdSchema, buildId: buildIdSchema });
export const operationParams = z.strictObject({
  workspaceId: z.uuid(),
  appId: appIdSchema,
  operationId: operationIdSchema,
});
export const nameParams = z.strictObject({ workspaceId: z.uuid(), name: z.string().max(80) });

export const requestBody = z.strictObject({ requestId });
export const createBody = z.strictObject({
  requestId,
  kind: z.enum(['public', 'private']),
  title,
  slug: appSlugSchema.optional(),
});
export const updateBody = z
  .strictObject({ title: title.optional(), slug: appSlugSchema.optional() })
  .refine(body => body.title !== undefined || body.slug !== undefined, { error: 'Change the title or the slug' });
export const grantBody = z.strictObject({ role: z.enum(['use', 'edit']) });
export const filesQuery = z.strictObject({ path: appFilePathSchema.optional() });
/** From a private app's version list. When given, a publish or restore that another one overtook fails. */
const generation = z.int().min(0).optional();
export const publicPublishBody = z.strictObject({ requestId, buildId: buildIdSchema });
export const privatePublishBody = z.strictObject({ requestId, revision: z.int().min(0), generation });
export const publishBody = z.union([publicPublishBody, privatePublishBody]);
export const publicRollbackBody = z.strictObject({ requestId, releaseId: releaseIdSchema });
export const privateRollbackBody = z.strictObject({ requestId, releaseId: versionIdSchema, generation });
export const rollbackBody = z.union([publicRollbackBody, privateRollbackBody]);
export const nameBody = z.strictObject({ requestId, name: z.string().max(80) });
export const approvalBody = z.strictObject({
  requestId,
  decision: z.enum(['approve', 'reject']),
  /** Credit units as a decimal string, because the limit can exceed a safe JSON number. */
  monthlyLimitUnits: z
    .string()
    .regex(/^\d{1,40}$/)
    .nullable()
    .optional(),
});

/** `workspace`, `member:<membership id>` or `team:<team id>`, the same keys the grants table uses. */
export function parseGrantee(key: string): AppGrantee | null {
  if (key === 'workspace') return { kind: 'workspace' };
  const [kind, id] = key.split(':');
  if (!id || !z.uuid().safeParse(id).success) return null;
  if (kind === 'member') return { kind: 'member', membershipId: id.toLowerCase() as never };
  if (kind === 'team') return { kind: 'team', teamId: id.toLowerCase() };
  return null;
}

/** A failure the route answers with instead of throwing a server error. */
export class AppRouteFailure extends Error {
  readonly failure: Pick<AppFailure, 'code' | 'message'>;
  /** What to fix in a private app's pages before it can publish. */
  readonly issues: AppDefinitionIssue[];
  constructor(failure: Pick<AppFailure, 'code' | 'message'>, issues: AppDefinitionIssue[] = []) {
    super(failure.message);
    this.failure = failure;
    this.issues = issues;
  }
}

export const failure = (code: AppFailureCode, message: string) => new AppRouteFailure({ code, message });

export const failureStatus: Record<AppFailureCode, number> = {
  'not-found': 404,
  forbidden: 403,
  'approval-required': 409,
  'name-taken': 409,
  'name-reserved': 409,
  'draft-busy': 409,
  'stale-draft': 409,
  superseded: 409,
  'budget-exhausted': 409,
  'limit-exceeded': 422,
  'recipe-invalid': 422,
  'definition-invalid': 422,
  'build-failed': 422,
  'build-timeout': 422,
  'builder-unavailable': 503,
  'publisher-unavailable': 503,
};

const approvalView = (approval: AppApproval) =>
  approval.state === 'approved'
    ? {
        ...approval,
        monthlyLimitUnits: approval.monthlyLimitUnits === null ? null : approval.monthlyLimitUnits.toString(),
      }
    : approval;

/** `sitesDomain` is the domain public apps are served under, or null when this server cannot publish them. */
export function appSummaryView(app: AppRecord, role: AppRole | null, sitesDomain: string | null) {
  return {
    id: app.id,
    kind: app.kind,
    slug: app.slug,
    title: app.title,
    publicName: app.publicName,
    webAddress: app.publicName && sitesDomain ? `${app.publicName}.${sitesDomain}` : null,
    role,
    approval: approvalView(app.approval),
    liveReleaseId: app.liveReleaseId,
    edgeStatus: app.kind === 'public' ? edgeStatus(app.stops) : null,
    stops: app.stops,
  };
}

/** What the editor sees, derived from the lease, the saved head, the newest build of that head and the live release. */
export function draftState(draft: AppDraft, headBuild: AppBuild | null, liveRelease: AppRelease | null): AppDraftState {
  if (draft.lease && !draft.lease.expired)
    return { state: 'editing', leaseId: draft.lease.id, conversationId: draft.lease.conversationId };
  if (draft.headCommit === null)
    return draft.failure ? { state: 'failed', failure: draft.failure } : { state: 'empty' };
  if (headBuild) {
    switch (headBuild.status.status) {
      case 'queued':
      case 'running':
        return { state: 'building', buildId: headBuild.id };
      case 'succeeded':
        if (liveRelease?.buildId === headBuild.id)
          return { state: 'live', buildId: headBuild.id, commit: headBuild.commit };
        // oxlint-disable-next-line tulipfarm/product-copy -- A draft state identifier, not user-facing copy.
        return { state: 'preview-ready', buildId: headBuild.id, commit: headBuild.commit };
      case 'failed':
        return { state: 'failed', failure: headBuild.status.failure };
    }
  }
  if (draft.failure) return { state: 'failed', failure: draft.failure };
  return { state: 'saved', commit: draft.headCommit };
}

export function appDetailView(
  summary: ReturnType<typeof appSummaryView>,
  draft: AppDraft,
  headBuild: AppBuild | null,
  liveRelease: AppRelease | null,
) {
  return {
    ...summary,
    draft: {
      revision: draft.revision,
      headCommit: draft.headCommit,
      previewBuildId: draft.previewBuildId,
      ...draftState(draft, headBuild, liveRelease),
    },
    liveRelease,
  };
}

/** `teamNames` holds the name of every team the grants name; team grants cascade with their team. */
export const grantView = (grant: AppGrant, teamNames: ReadonlyMap<string, string>) => ({
  grantee:
    grant.grantee.kind === 'team' ? { ...grant.grantee, name: teamNames.get(grant.grantee.teamId)! } : grant.grantee,
  role: grant.role,
  grantedBy: grant.grantedBy,
});

export const buildView = (build: AppBuild) => ({
  id: build.id,
  commit: build.commit,
  recipe: build.recipe,
  builder: build.builder,
  ...build.status,
});

/** A private app's version in the release list's shape. A version is ready the moment it is published. */
export const versionView = (version: AppVersion) => ({
  id: version.id,
  number: version.number,
  digest: version.digest,
  publishedBy: version.publishedBy,
  staged: true,
  live: version.live,
  createdAt: version.publishedAt,
});
