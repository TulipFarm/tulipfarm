import type { ReactNode } from 'react';
import { z } from 'zod';
import { notFound, redirect, type ParsedLocation } from '@tanstack/react-router';
import { hashKey } from '@tanstack/react-query';
import {
  forgetSession,
  lastSession,
  rememberWorkspaceId,
  workspaceDestination,
  workspaceIdHint,
  forgetWorkspace,
  forgetWorkspaceId,
} from '@/lib/last-workspace';
import { loadSession } from '@/lib/auth';
import { requireProfile } from '@/lib/profile-guard';
import { getWorkspace, listWorkspaces, WorkspaceRequestError } from '@/lib/workspaces';
import { loadOwnMembership, GovernanceRequestError } from '@/lib/governance';
import { readWorkspaceList, sessionRuntime, WorkspaceListQueryBridge } from '@/features/workspaces/queries';
import { reconcileMembership } from '@/features/governance/queries';
import { ownMembershipSchema, type OwnMembership } from '@tulipfarm/workspaces/governance-contracts';
import { workspaceListSchema, workspaceSchema } from '@tulipfarm/workspaces/contracts';
import type { createWorkspaceAccess } from '@/lib/workspace-access';
import {
  SessionQueryProvider,
  type FeatureScope,
  type QueryKey,
  type SessionIdentity,
  type WorkspaceScope,
} from '@/lib/query';
import { startEarlyReads } from '@/lib/query/early-reads';
import { persistedReads } from '@/lib/query/persisted-reads';
import { holdWrites } from '@/lib/http';
import { UserVisitProvider } from '@/lib/user-visit';
import { retryAdmission, temporaryAdmissionError } from '@/lib/admission-retry';

type WorkspaceAccess = ReturnType<typeof createWorkspaceAccess>;

/** Query, visit and workspace-list state for a signed-in session. */
export function SessionScope({
  identity,
  onAuthorityLost,
  initialWorkspaces,
  onWorkspaceListChanged,
  children,
}: {
  identity: SessionIdentity;
  onAuthorityLost: (scope: FeatureScope) => void;
  initialWorkspaces: WorkspaceRead[] | undefined;
  onWorkspaceListChanged: () => void;
  children: ReactNode;
}) {
  return (
    <SessionQueryProvider identity={identity} onAuthorityLost={onAuthorityLost}>
      <UserVisitProvider identity={identity}>
        <WorkspaceListQueryBridge initialWorkspaces={initialWorkspaces} onChanged={onWorkspaceListChanged} />
        {children}
      </UserVisitProvider>
    </SessionQueryProvider>
  );
}

/** Checks a background workspace is still accessible, denying it or re-running admission if not. */
export async function recheckWorkspaceAccess(
  slug: string,
  admitted: Pick<WorkspaceContext, 'membership' | 'membershipId'> & { userId: string; sessionId: string },
  deny: (status: number) => void,
  invalidate: () => void,
) {
  try {
    const workspace = await getWorkspace(slug);
    if (workspace.status === 'ready') {
      const membership = await loadOwnMembership(workspace.id, AbortSignal.timeout(15_000));
      if (membership.membershipId !== admitted.membershipId) {
        deny(403);
        invalidate();
      } else if (
        reconcileMembership(
          { userId: admitted.userId, sessionId: admitted.sessionId },
          workspace.id,
          admitted.membership,
          membership,
        )
      )
        invalidate();
    }
  } catch (error) {
    if (
      (error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) &&
      [401, 403, 404].includes(error.status)
    )
      deny(error.status);
  }
}

type PageReadModule = typeof import('@/features/chat/early-reads');
let pageReadModule: Promise<PageReadModule> | null = null;
function loadPageReads() {
  pageReadModule ??= import('@/features/chat/early-reads').then(
    module => {
      persistedReads.configure(module.persistedPageReads);
      return module;
    },
    error => {
      pageReadModule = null;
      throw error;
    },
  );
  return pageReadModule;
}
function cachedRead(identity: SessionIdentity, workspaceId: string, key: QueryKey) {
  const scope = ['user', identity.userId, 'workspace', workspaceId];
  const hash = hashKey(key);
  return !!sessionRuntime(identity)
    ?.client.getQueryCache()
    .findAll({ queryKey: scope })
    .some(query => query.state.data !== undefined && hashKey(query.queryKey.slice(scope.length + 2)) === hash);
}
/**
 * Starts the reads the destination page makes first, once the workspace id is known, so they
 * overlap membership admission instead of waiting for the frame to mount. Reads the cache already
 * holds are skipped, and the page only uses a response after admission binds it to the membership.
 * Reads still waiting for their code when admission settles never start, so they cannot race the
 * page's own reads.
 */
function startPageReads(
  identity: SessionIdentity,
  workspaceId: string,
  slug: string,
  location: { pathname: string; search: Record<string, unknown> },
) {
  let settled = false;
  let reads: ReturnType<typeof startEarlyReads> | null = null;
  void loadPageReads().then(
    module => {
      if (settled) return;
      const pending = module
        .workspacePageReads(workspaceId, slug, location.pathname, location.search)
        .filter(read => !cachedRead(identity, workspaceId, read.key));
      if (pending.length) reads = startEarlyReads(identity, workspaceId, pending);
    },
    () => {},
  );
  return {
    workspaceId,
    admit(membershipId: string) {
      settled = true;
      reads?.admit(membershipId);
    },
    discard() {
      settled = true;
      reads?.discard();
    },
  };
}
type AuthSession = NonNullable<Awaited<ReturnType<typeof loadSession>>>;
type WorkspaceRead = Awaited<ReturnType<typeof getWorkspace>>;
export type WorkspaceContext = {
  user: AuthSession['user'];
  sessionId: string;
  accessRevision: number;
  membershipId: string | null;
  membership: OwnMembership | null;
  workspace: WorkspaceRead;
  workspaces: WorkspaceRead[];
  workspaceStale: boolean;
  /** Shown from disk while the session and membership are still being checked. Writes wait for the check. */
  workspaceProvisional: boolean;
};
const onIntegrationsPage = (slug: string, pathname: string) =>
  pathname === `/${slug}/integrations` || pathname.startsWith(`/${slug}/integrations/`);
/** Workspace reads for a remembered session, started before the session check confirms it. */
function startAdmissionReads(
  identity: SessionIdentity,
  slug: string,
  location: { pathname: string; search: Record<string, unknown> },
  cause: string,
) {
  const controller = new AbortController();
  const hintedId = workspaceIdHint(identity.userId, slug);
  const reads = {
    identity,
    hintedId,
    // Not cancelled with the load: a newer check must not discard this read's answer that access was removed.
    workspace: getWorkspace(slug),
    list: cause === 'stay' ? listWorkspaces(controller.signal) : readWorkspaceList(identity),
    membership: hintedId ? loadOwnMembership(hintedId, controller.signal) : null,
    pageReads: hintedId ? startPageReads(identity, hintedId, slug, location) : null,
  };
  for (const read of [reads.workspace, reads.list, reads.membership]) void read?.catch(() => {});
  return {
    ...reads,
    discard() {
      controller.abort();
      reads.pageReads?.discard();
    },
  };
}
// Disk reads that take longer than this fall back to waiting for the network.
const provisionalWait = 300;
const admissionSnapshotSchema = z.object({
  user: z.looseObject({ id: z.string().min(1), name: z.string().trim().min(1), email: z.string() }),
  workspace: workspaceSchema,
  workspaces: workspaceListSchema,
  membership: ownMembershipSchema,
});
/**
 * The workspace admission this session last confirmed for the slug, and the reads persisted with it,
 * if they are young enough to show before the session and membership checks return.
 */
async function provisionalAdmission(identity: SessionIdentity, slug: string, pathname: string) {
  // An integration's own page changes its connection, so it always waits for the checks. The
  // directory only lists statuses and links, and its writes already wait like any other page's.
  if (pathname.startsWith(`/${slug}/integrations/`)) return null;
  const read = async () => {
    const [, snapshot] = await Promise.all([
      loadPageReads(),
      persistedReads.restoreAdmission(identity.userId, slug, admissionSnapshotSchema),
    ]);
    if (
      !snapshot ||
      snapshot.sessionId !== identity.sessionId ||
      snapshot.read.user.id !== identity.userId ||
      snapshot.read.workspace.status !== 'ready' ||
      snapshot.read.workspace.slug !== slug
    )
      return null;
    const scope: WorkspaceScope = {
      kind: 'workspace',
      userId: identity.userId,
      workspaceId: snapshot.read.workspace.id,
      membershipId: snapshot.read.membership.membershipId,
    };
    return {
      identity,
      scope,
      reads: await persistedReads.restore(scope),
      read: { ...snapshot.read, user: snapshot.read.user as AuthSession['user'] },
    };
  };
  return Promise.race([
    read().catch(() => null),
    new Promise<null>(resolve => setTimeout(resolve, provisionalWait, null)),
  ]);
}
type VerifiedAdmission = { context: WorkspaceContext | null; slug: string; pathname: string; revision: number };
const verifiedAdmissions = new WeakMap<WorkspaceAccess, VerifiedAdmission>();
/** A settled provisional check, once, if nothing has admitted or denied the workspace since. */
function takeVerifiedAdmission(access: WorkspaceAccess, slug: string, pathname: string) {
  const verified = verifiedAdmissions.get(access);
  if (!verified || verified.slug !== slug) return null;
  verifiedAdmissions.delete(access);
  const snapshot = access.getSnapshot();
  if (verified.pathname !== pathname || snapshot.revision !== verified.revision) return null;
  return verified.context && snapshot.kind === 'admitted' && snapshot.revision === verified.context.accessRevision
    ? verified
    : { ...verified, context: null };
}
/** Where a signed-in person with no workspace in the URL goes: their last workspace, or creating one. */
export async function defaultWorkspaceDestination(destination: string, session: AuthSession) {
  let workspaces;
  try {
    workspaces = await readWorkspaceList({ userId: session.user.id, sessionId: session.session.id });
  } catch (error) {
    if (error instanceof WorkspaceRequestError && error.status === 401)
      throw redirect({ to: '/login', search: { redirect: destination }, replace: true });
    throw error;
  }
  return workspaceDestination(session.user.id, workspaces);
}

/** Admits the signed-in person to the workspace route: the beforeLoad of `/$workspaceSlug`. */
export async function admitWorkspace({
  params,
  location,
  cause,
  context,
  abortController,
  shownAdmission,
  invalidate,
}: {
  params: { workspaceSlug: string };
  location: ParsedLocation;
  cause: 'preload' | 'enter' | 'stay';
  context: { workspaceAccess: WorkspaceAccess };
  abortController: AbortController;
  /** The admission the workspace route is showing now. */
  shownAdmission: () => Partial<WorkspaceContext> | undefined;
  invalidate: () => void;
}): Promise<WorkspaceContext> {
  void loadPageReads().catch(() => {});
  const snapshot = context.workspaceAccess.getSnapshot();
  // A provisional render's check has settled: use its admission, or, when it did not confirm one,
  // admit again exactly as a fresh load would.
  const verified =
    cause === 'preload'
      ? null
      : takeVerifiedAdmission(context.workspaceAccess, params.workspaceSlug, location.pathname);
  if (verified?.context) return verified.context;
  const loadCause = verified ? 'enter' : cause;
  const previousWorkspace =
    snapshot.kind === 'admitted' && snapshot.read.workspace.slug === params.workspaceSlug
      ? snapshot.read.workspace
      : null;
  const navigating = snapshot.kind === 'admitted' && snapshot.read.pathname !== location.pathname;
  // A page shown at once hands these reads to its background check, which outlives this load, so a
  // newer load must not cancel them. Otherwise they end with this load.
  const earlyAbort = new AbortController();
  const earlyReads =
    navigating && previousWorkspace && snapshot.kind === 'admitted'
      ? {
          userId: snapshot.authority.userId,
          sessionId: snapshot.authority.sessionId,
          workspace: getWorkspace(params.workspaceSlug),
          membership:
            previousWorkspace.status === 'ready' ? loadOwnMembership(previousWorkspace.id, earlyAbort.signal) : null,
          list: cause === 'stay' ? listWorkspaces(earlyAbort.signal) : null,
        }
      : null;
  if (earlyReads) {
    const deny = context.workspaceAccess.observe({
      userId: earlyReads.userId,
      sessionId: earlyReads.sessionId,
      slug: params.workspaceSlug,
    });
    for (const read of [earlyReads.workspace, earlyReads.membership, earlyReads.list])
      void read?.catch(error => {
        if (
          (error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) &&
          [401, 403, 404].includes(error.status)
        )
          deny(error.status);
      });
  }
  // The API checks the session cookie on every read, so a fresh load starts the workspace reads for
  // the session this browser last confirmed while the session check runs. They are only used if
  // the check returns that same session.
  const last = earlyReads ? null : lastSession();
  const speculative = last ? startAdmissionReads(last, params.workspaceSlug, location, loadCause) : null;
  if (speculative) {
    const deny = context.workspaceAccess.observe({ ...speculative.identity, slug: params.workspaceSlug });
    void speculative.workspace.catch(error => {
      if (
        (error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) &&
        [401, 403, 404].includes(error.status)
      )
        deny(error.status);
    });
  }

  // A retry starts its reads again: the early and speculative reads have already failed.
  const admit = async (session: AuthSession, signal: AbortSignal, reuse = true): Promise<WorkspaceContext> => {
    signal.throwIfAborted();
    const access = context.workspaceAccess.begin({
      userId: session.user.id,
      sessionId: session.session.id,
      slug: params.workspaceSlug,
    });
    const denied = (error: unknown) => {
      if (
        (error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) &&
        [401, 403, 404].includes(error.status)
      )
        access.deny(error.status);
      throw error;
    };
    const identity = { userId: session.user.id, sessionId: session.session.id };
    let pageReads: ReturnType<typeof startPageReads> | null = null;
    const reads =
      reuse && earlyReads?.userId === session.user.id && earlyReads.sessionId === session.session.id
        ? earlyReads
        : null;
    const started =
      reuse && speculative?.identity.userId === session.user.id && speculative.identity.sessionId === session.session.id
        ? speculative
        : null;
    if (!started) speculative?.discard();
    // On a fresh load, the id this slug had last time lets membership and page reads start
    // alongside the workspace read. Neither is used unless the workspace read returns that id.
    const hintedId = reads ? null : started ? started.hintedId : workspaceIdHint(session.user.id, params.workspaceSlug);
    try {
      const hintedMembership = started ? started.membership : hintedId ? loadOwnMembership(hintedId, signal) : null;
      void hintedMembership?.catch(() => {});
      if (started) pageReads = started.pageReads;
      else if (hintedId) pageReads = startPageReads(identity, hintedId, params.workspaceSlug, location);
      const workspaceRequest = (reads?.workspace ?? started?.workspace ?? getWorkspace(params.workspaceSlug)).catch(
        denied,
      );
      const membershipRequest = workspaceRequest.then(workspace => {
        if (workspace.status !== 'ready') return null;
        if (!reads && pageReads?.workspaceId !== workspace.id) {
          pageReads?.discard();
          pageReads = startPageReads(identity, workspace.id, params.workspaceSlug, location);
        }
        return (
          reads?.membership && previousWorkspace?.id === workspace.id
            ? reads.membership
            : hintedMembership && hintedId === workspace.id
              ? hintedMembership
              : loadOwnMembership(workspace.id, signal)
        ).catch(denied);
      });
      void membershipRequest.catch(() => {});
      const [workspaceRead, listRead] = await Promise.allSettled([
        workspaceRequest,
        (
          reads?.list ??
          started?.list ??
          (loadCause === 'stay'
            ? listWorkspaces(signal)
            : readWorkspaceList({ userId: session.user.id, sessionId: session.session.id }))
        ).catch(denied),
      ]);
      for (const read of [workspaceRead, listRead]) {
        if (
          read.status === 'rejected' &&
          read.reason instanceof WorkspaceRequestError &&
          [401, 403, 404].includes(read.reason.status)
        )
          throw read.reason;
      }
      if (workspaceRead.status === 'rejected') throw workspaceRead.reason;
      if (listRead.status === 'rejected') throw listRead.reason;
      const workspace = workspaceRead.value;
      const workspaces = listRead.value;
      const membership = await membershipRequest;
      if (!signal.aborted) access.admit({ pathname: location.pathname, workspace, workspaces, membership });
      if (membership && !signal.aborted && pageReads?.workspaceId === workspace.id)
        pageReads.admit(membership.membershipId);
      else pageReads?.discard();
      if (workspace.status === 'ready') rememberWorkspaceId(session.user.id, params.workspaceSlug, workspace.id);
      if (workspace.status === 'ready' && membership && !signal.aborted)
        void persistedReads.saveAdmission(
          identity,
          params.workspaceSlug,
          workspace.id,
          new Date(session.session.expiresAt).getTime(),
          { user: session.user, workspace, workspaces, membership },
        );
      return {
        user: session.user,
        sessionId: session.session.id,
        accessRevision: access.revision,
        membershipId: membership?.membershipId ?? null,
        membership,
        workspace,
        workspaces,
        workspaceStale: false,
        workspaceProvisional: false,
      };
    } catch (error) {
      pageReads?.discard();
      if (
        (error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) &&
        [403, 404].includes(error.status)
      ) {
        forgetWorkspace(session.user.id);
        forgetWorkspaceId(session.user.id, params.workspaceSlug);
        void persistedReads.forgetAdmission(session.user.id, params.workspaceSlug);
        if (hintedId) void persistedReads.clear(session.user.id, hintedId);
        if (loadCause === 'stay') throw redirect({ to: '/', replace: true });
        throw notFound();
      }
      if ((error instanceof WorkspaceRequestError || error instanceof GovernanceRequestError) && error.status === 401) {
        void forgetSession();
        throw redirect({ to: '/login', search: { redirect: location.href }, replace: true });
      }
      const temporary = temporaryAdmissionError(error);
      const previous = access.retained(location.pathname);
      if (temporary && !signal.aborted && loadCause === 'stay' && previous) {
        // Integration controls change workspace connections, so those pages confirm the
        // membership again before showing them. Elsewhere the last admitted read is enough.
        const membership = onIntegrationsPage(params.workspaceSlug, location.pathname)
          ? await loadOwnMembership(previous.workspace.id, signal).catch(denied)
          : previous.membership;
        return {
          user: session.user,
          sessionId: session.session.id,
          accessRevision: access.revision,
          membershipId: membership?.membershipId ?? null,
          membership,
          workspace: previous.workspace,
          workspaces: previous.workspaces,
          workspaceStale: true,
          workspaceProvisional: false,
        };
      }
      throw error;
    }
  };
  const profile = (signal: AbortSignal) =>
    requireProfile(location.href).catch(error => {
      // A busy or unreachable API has not changed the session, so the admitted view stays while admission retries.
      if (!signal.aborted && !temporaryAdmissionError(error)) context.workspaceAccess.clear();
      throw error;
    });

  // Moving between pages of an admitted workspace shows the next page at once with the last
  // admission. The full check runs behind it, writes wait for it, and any change re-runs this load.
  // That holds while the shown admission is still provisional or stale, except on an integration's
  // own page, which changes its connection and so waits for a confirmed check.
  const shown = earlyReads && !verified && loadCause === 'stay' ? shownAdmission() : undefined;
  const unconfirmed = shown?.workspaceProvisional !== false || shown.workspaceStale !== false;
  if (
    earlyReads &&
    shown?.workspace?.slug === params.workspaceSlug &&
    shown.workspace.id === previousWorkspace?.id &&
    shown.user?.id === earlyReads.userId &&
    shown.sessionId === earlyReads.sessionId &&
    typeof shown.workspaceProvisional === 'boolean' &&
    typeof shown.workspaceStale === 'boolean' &&
    !(unconfirmed && location.pathname.startsWith(`/${params.workspaceSlug}/integrations/`))
  ) {
    const shownContext = shown as WorkspaceContext;
    const check = earlyAbort;
    const verification = retryAdmission(
      fresh => profile(check.signal).then(session => admit(session, check.signal, fresh)),
      check.signal,
    );
    const fingerprint = (result: WorkspaceContext) =>
      JSON.stringify([
        result.user,
        result.sessionId,
        result.accessRevision,
        result.membership,
        result.workspace,
        result.workspaces,
      ]);
    holdWrites(
      verification.then(result => {
        if (result.workspace.id !== shownContext.workspace.id || result.membershipId !== shownContext.membershipId)
          throw new Error('Workspace access changed');
      }),
    );
    void verification
      .then(
        // A provisional or stale admission is replaced once confirmed, even when nothing else changed.
        result => (fingerprint(result) === fingerprint(shownContext) && !unconfirmed ? undefined : { context: result }),
        () => ({ context: null }),
      )
      .then(outcome => {
        if (!outcome) return;
        verifiedAdmissions.set(context.workspaceAccess, {
          ...outcome,
          slug: params.workspaceSlug,
          pathname: location.pathname,
          revision: context.workspaceAccess.getSnapshot().revision,
        });
        invalidate();
      });
    return shownContext;
  }
  const endEarlyReads = () => earlyAbort.abort(abortController.signal.reason);
  if (abortController.signal.aborted) endEarlyReads();
  else abortController.signal.addEventListener('abort', endEarlyReads, { once: true });

  const provisional =
    last && !verified && !earlyReads && cause !== 'stay' && snapshot.kind !== 'admitted'
      ? await provisionalAdmission(last, params.workspaceSlug, location.pathname)
      : null;
  if (provisional && !abortController.signal.aborted) {
    const { identity, scope, read } = provisional;
    persistedReads.beginProvisional(identity, scope, provisional.reads);
    const access = context.workspaceAccess.begin({ ...identity, slug: params.workspaceSlug });
    access.admit({ pathname: location.pathname, ...read });
    if (speculative?.pageReads?.workspaceId === scope.workspaceId) speculative.pageReads.admit(scope.membershipId);
    // The check runs on after this load returns, so leaving the page does not cancel it.
    const check = new AbortController();
    const verification = retryAdmission(
      fresh => profile(check.signal).then(session => admit(session, check.signal, fresh)),
      check.signal,
    );
    const same = (result: WorkspaceContext) =>
      result.user.id === identity.userId &&
      result.sessionId === identity.sessionId &&
      result.workspace.id === scope.workspaceId &&
      result.membershipId === scope.membershipId;
    holdWrites(
      verification.then(result => {
        if (!same(result)) throw new Error('Workspace access changed');
      }),
    );
    void verification
      .then(
        result => {
          persistedReads.endProvisional();
          if (same(result)) sessionRuntime(identity)?.persistScope(scope);
          else void persistedReads.clear(scope.userId, scope.workspaceId);
          return { context: result };
        },
        () => {
          persistedReads.endProvisional();
          return { context: null };
        },
      )
      .then(outcome => {
        verifiedAdmissions.set(context.workspaceAccess, {
          ...outcome,
          slug: params.workspaceSlug,
          pathname: location.pathname,
          revision: context.workspaceAccess.getSnapshot().revision,
        });
        invalidate();
      });
    return {
      user: read.user,
      sessionId: identity.sessionId,
      accessRevision: access.revision,
      membershipId: scope.membershipId,
      membership: read.membership,
      workspace: read.workspace,
      workspaces: read.workspaces,
      workspaceStale: false,
      workspaceProvisional: true,
    };
  }
  const discard = () => speculative?.discard();
  abortController.signal.addEventListener('abort', discard, { once: true });
  try {
    return await retryAdmission(async fresh => {
      const session = await profile(abortController.signal).catch(error => {
        discard();
        throw error;
      });
      return await admit(session, abortController.signal, fresh);
    }, abortController.signal);
  } finally {
    abortController.signal.removeEventListener('abort', discard);
  }
}
