import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

const failureSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean().optional() });

const approvalSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not-requested') }),
  z.object({ state: z.literal('requested'), requestedBy: z.string(), at: z.string() }),
  z.object({
    state: z.literal('approved'),
    approvedBy: z.string(),
    at: z.string(),
    monthlyLimitUnits: z.string().nullable(),
  }),
  z.object({ state: z.literal('rejected'), rejectedBy: z.string(), at: z.string() }),
]);

const stopsSchema = z.object({
  disabledAt: z.string().nullable(),
  editorPausedAt: z.string().nullable(),
  budgetPausedAt: z.string().nullable(),
});

const appSummarySchema = z.object({
  id: z.uuid(),
  kind: z.enum(['public', 'private']),
  slug: z.string(),
  title: z.string(),
  publicName: z.string().nullable(),
  /** The full host, `<public name>.<sites domain>`, once the app has a public name and the server serves app sites. */
  webAddress: z.string().nullable(),
  role: z.enum(['use', 'edit']).nullable(),
  approval: approvalSchema,
  liveReleaseId: z.uuid().nullable(),
  edgeStatus: z.enum(['active', 'paused', 'disabled']).nullable(),
  stops: stopsSchema,
});
export type AppSummary = z.infer<typeof appSummarySchema>;
export type AppKind = AppSummary['kind'];
export type EdgeStatus = NonNullable<AppSummary['edgeStatus']>;

const draftBase = { revision: z.number(), headCommit: z.string().nullable(), previewBuildId: z.string().nullable() };
const draftSchema = z.discriminatedUnion('state', [
  z.object({ ...draftBase, state: z.literal('empty') }),
  z.object({ ...draftBase, state: z.literal('editing'), conversationId: z.string() }),
  z.object({ ...draftBase, state: z.literal('building'), buildId: z.string() }),
  // oxlint-disable-next-line tulipfarm/product-copy -- A draft state identifier, not user-facing copy.
  z.object({ ...draftBase, state: z.literal('preview-ready'), buildId: z.string(), commit: z.string() }),
  z.object({ ...draftBase, state: z.literal('failed'), failure: failureSchema }),
  z.object({ ...draftBase, state: z.literal('saved'), commit: z.string() }),
]);
export type AppDraftState = z.infer<typeof draftSchema>['state'];

const appDetailSchema = appSummarySchema.extend({
  draft: draftSchema,
  liveRelease: z.object({ id: z.uuid(), number: z.number(), commit: z.string() }).nullable(),
  /** The domain public apps are served under, or null when this server does not serve app sites. */
  sitesDomain: z.string().nullable(),
});
export type AppDetail = z.infer<typeof appDetailSchema>;

const releaseSchema = z.object({
  id: z.uuid(),
  number: z.number(),
  commit: z.string(),
  staged: z.boolean(),
  live: z.boolean(),
  createdAt: z.string(),
});
export type AppRelease = z.infer<typeof releaseSchema>;

const granteeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }),
  z.object({ kind: z.literal('member'), membershipId: z.string() }),
  z.object({ kind: z.literal('team'), teamId: z.string(), name: z.string() }),
]);
export type AppGrantee = z.infer<typeof granteeSchema>;
const grantSchema = z.object({ grantee: granteeSchema, role: z.enum(['use', 'edit']), grantedBy: z.string() });
export type AppGrant = z.infer<typeof grantSchema>;
export type AppRole = AppGrant['role'];

const operationSchema = z.object({
  id: z.uuid(),
  status: z.enum(['admitted', 'staging', 'switched', 'superseded', 'failed']),
  failure: failureSchema.nullable(),
});
export type AppOperation = z.infer<typeof operationSchema>;

const nameAvailabilitySchema = z.object({
  name: z.string(),
  available: z.boolean(),
  reason: z.enum(['name-taken', 'name-reserved', 'name-invalid']).optional(),
});

/** The address inside the workspace, `/<workspace>/apps/<slug>`; the server applies the same rule. */
export const appSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export function granteeKey(grantee: AppGrantee) {
  if (grantee.kind === 'workspace') return 'workspace';
  return grantee.kind === 'member' ? `member:${grantee.membershipId}` : `team:${grantee.teamId}`;
}

/** Approval limits are sent in credit units. */
export const unitsPerCredit = 1_000_000_000_000n;

export function appApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${workspaceId}/apps`;
  async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return null;
    const value = await readJson(response, true);
    if (!response.ok) {
      const failure = z.object({ failure: failureSchema }).safeParse(value).data?.failure;
      const code = failure?.code ?? z.object({ error: z.string() }).safeParse(value).data?.error ?? 'apps-unavailable';
      throw new TableRequestError(response.status, code, appFailureMessage(code));
    }
    return value;
  }
  const withRequestId = (body: object = {}) => ({ requestId: crypto.randomUUID(), ...body });
  const stop = (kind: 'pause' | 'resume' | 'disable' | 'enable') => (appId: string) =>
    request(`/${appId}/${kind}`, 'POST', withRequestId());
  const operation = z.object({ operation: operationSchema });
  return {
    list: async (signal: AbortSignal) =>
      z.object({ apps: z.array(appSummarySchema) }).parse(await request('', 'GET', undefined, signal)).apps,
    read: async (appId: string, signal: AbortSignal) =>
      appDetailSchema.parse(await request(`/${appId}`, 'GET', undefined, signal)),
    create: async (input: { kind: AppKind; title: string; slug?: string }) =>
      appSummarySchema.parse(await request('', 'POST', withRequestId(input))),
    update: async (appId: string, input: { title?: string; slug?: string }) =>
      appSummarySchema.parse(await request(`/${appId}`, 'PATCH', input)),
    releases: async (appId: string, signal: AbortSignal) =>
      z
        .object({ releases: z.array(releaseSchema) })
        .parse(await request(`/${appId}/releases`, 'GET', undefined, signal)).releases,
    rollback: async (appId: string, releaseId: string) =>
      operation.parse(await request(`/${appId}/rollback`, 'POST', withRequestId({ releaseId }))).operation,
    operation: async (appId: string, operationId: string, signal: AbortSignal) =>
      operation.parse(await request(`/${appId}/operations/${operationId}`, 'GET', undefined, signal)).operation,
    grants: async (appId: string, signal: AbortSignal) =>
      z.object({ grants: z.array(grantSchema) }).parse(await request(`/${appId}/grants`, 'GET', undefined, signal))
        .grants,
    grant: async (appId: string, grantee: AppGrantee, role: AppRole) =>
      grantSchema.parse(await request(`/${appId}/grants/${encodeURIComponent(granteeKey(grantee))}`, 'PUT', { role })),
    revoke: async (appId: string, grantee: AppGrantee) =>
      request(`/${appId}/grants/${encodeURIComponent(granteeKey(grantee))}`, 'DELETE'),
    nameAvailability: async (name: string, signal: AbortSignal) =>
      nameAvailabilitySchema.parse(await request(`/names/${encodeURIComponent(name)}`, 'GET', undefined, signal)),
    rename: async (appId: string, name: string) => request(`/${appId}/name`, 'PUT', withRequestId({ name })),
    pause: stop('pause'),
    resume: stop('resume'),
    disable: stop('disable'),
    enable: stop('enable'),
    requestApproval: async (appId: string) =>
      appSummarySchema.parse(await request(`/${appId}/approval-request`, 'POST', withRequestId())),
    decideApproval: async (appId: string, decision: 'approve' | 'reject', monthlyLimitUnits: string | null) =>
      appSummarySchema.parse(
        await request(
          `/${appId}/approval`,
          'POST',
          withRequestId(decision === 'approve' ? { decision, monthlyLimitUnits } : { decision }),
        ),
      ),
  };
}
export type AppApi = ReturnType<typeof appApi>;

const unavailable = 'Apps are unavailable right now. Try again in a moment.';
const noAccess = 'This app is unavailable or your access changed.';

/** What people read for each failure code, so server wording never reaches the page. */
const failureMessages: Record<string, string> = {
  'invalid-request': 'Check the details and try again.',
  'sign-in-required': noAccess,
  'not-found': noAccess,
  forbidden: noAccess,
  'publisher-unavailable':
    'This TulipFarm server isn’t set up to publish apps yet. Ask whoever runs your TulipFarm server to set it up.',
  'builder-unavailable':
    'This TulipFarm server isn’t set up to build apps yet. Ask whoever runs your TulipFarm server to set it up.',
  'approval-required': 'A workspace admin must approve this app before it can go live.',
  'budget-exhausted': 'Credits are used up, so this app can’t go live right now.',
  'name-taken': 'Another app already uses this web address.',
  'name-reserved': 'This web address is reserved. Choose another.',
  'draft-busy': 'Someone is changing this app in chat. Try again when they finish.',
  'stale-draft': 'This app changed while you were working. Try again.',
  superseded: 'A newer change finished first, so this one wasn’t applied.',
  'limit-exceeded': 'The app is too large to build.',
  'recipe-invalid': 'The app’s build settings aren’t valid.',
  'build-failed': 'Something in the app’s code stopped the build.',
  'build-timeout': 'The build took too long and was stopped.',
};

export const appFailureMessage = (code: string) => failureMessages[code] ?? unavailable;

/** The message for a failed request, with `overrides` for codes whose meaning depends on the action. */
export function failureMessage(error: unknown, overrides: Record<string, string> = {}) {
  if (!(error instanceof TableRequestError)) return unavailable;
  return overrides[error.code] ?? error.message;
}
