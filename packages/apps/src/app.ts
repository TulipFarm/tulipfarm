import type { AppServerSize } from '@tulipfarm/extensions';
import { z } from 'zod';
import type { AppBuildId, AppGeneration, AppReleaseId, GitCommit, MembershipId } from './ids.ts';

/** Fixed at creation. A private app never gets a public name, approval or hosted release. */
export type AppKind = 'public' | 'private';

export type AppApproval =
  | { readonly state: 'not-requested' }
  | { readonly state: 'requested'; readonly requestedBy: MembershipId; readonly at: string }
  | {
      readonly state: 'approved';
      readonly approvedBy: MembershipId;
      readonly at: string;
      readonly monthlyLimitUnits: bigint | null;
    }
  | { readonly state: 'rejected'; readonly rejectedBy: MembershipId; readonly at: string };

export type EdgeStatus = 'active' | 'paused' | 'disabled';

export type PauseReason = 'editor' | 'budget';

/** The stop controls on an app. Publish never writes them, so a publish cannot undo a stop. */
export type AppStops = {
  readonly disabledAt: string | null;
  readonly editorPausedAt: string | null;
  readonly budgetPausedAt: string | null;
};

/** Disabled wins over any pause, and any pause wins over active. */
export function edgeStatus(stops: AppStops): EdgeStatus {
  if (stops.disabledAt !== null) return 'disabled';
  if (stops.editorPausedAt !== null || stops.budgetPausedAt !== null) return 'paused';
  return 'active';
}

/** What the editor sees. Derived from the draft, its lease, its latest build and the live release; never stored. */
export type AppDraftState =
  | { readonly state: 'empty' }
  | { readonly state: 'editing'; readonly leaseId: string; readonly conversationId: string }
  | { readonly state: 'building'; readonly buildId: AppBuildId }
  // eslint-disable-next-line tulipfarm/product-copy -- A stored state identifier, not user-facing copy.
  | { readonly state: 'preview-ready'; readonly buildId: AppBuildId; readonly commit: GitCommit }
  /** The draft's newest build is the live release, so there is nothing new to publish. */
  | { readonly state: 'live'; readonly buildId: AppBuildId; readonly commit: GitCommit }
  | { readonly state: 'failed'; readonly failure: AppFailure }
  | { readonly state: 'saved'; readonly commit: GitCommit };

export type AppBuildStatus =
  | { readonly status: 'queued' }
  | { readonly status: 'running'; readonly startedAt: string }
  | { readonly status: 'succeeded'; readonly manifestDigest: string; readonly files: number; readonly bytes: number }
  | { readonly status: 'failed'; readonly failure: AppFailure };

export type AppOperationKind = 'publish' | 'rollback' | 'resize' | 'pause' | 'resume' | 'disable' | 'enable' | 'rename';

export type AppOperationStatus =
  | { readonly status: 'admitted'; readonly generation: AppGeneration }
  | { readonly status: 'staging'; readonly generation: AppGeneration }
  | { readonly status: 'switched'; readonly generation: AppGeneration; readonly releaseId: AppReleaseId }
  | { readonly status: 'superseded'; readonly generation: AppGeneration; readonly by: AppGeneration }
  | { readonly status: 'failed'; readonly generation: AppGeneration; readonly failure: AppFailure };

export type AppFailureCode =
  | 'draft-busy'
  | 'stale-draft'
  | 'limit-exceeded'
  | 'recipe-invalid'
  | 'definition-invalid'
  | 'builder-unavailable'
  | 'build-failed'
  | 'build-timeout'
  | 'publisher-unavailable'
  | 'approval-required'
  | 'name-taken'
  | 'name-reserved'
  | 'budget-exhausted'
  | 'superseded'
  | 'not-found'
  | 'forbidden';

export type AppFailure = { readonly code: AppFailureCode; readonly message: string; readonly retryable: boolean };

export type { AppServerSize };

/** Every server app runs at this size unless a workspace admin raises it. */
export const defaultServerSize: AppServerSize = Object.freeze({ vcpu: 1, memMiB: 1024 });

/** A size a caller asks for. Whether the workspace allows it is checked when the resize is admitted. */
export const appServerSizeSchema = z.strictObject({ vcpu: z.int32().positive(), memMiB: z.int32().positive() });

/**
 * Where a server app's runtime is. `starting` brings up the first host and `replacing` brings up a host beside the
 * live one; both name it as the candidate. Idle apps stop and start cold, so there is no paused state.
 */
export type AppRuntimeState = 'none' | 'starting' | 'serving' | 'replacing' | 'failed';

export const appLimits = Object.freeze({
  fileBytes: 512 * 1024,
  files: 2_000,
  treeBytes: 20 * 1024 * 1024,
  artifactBytes: 50 * 1024 * 1024,
  artifactFiles: 5_000,
  buildSeconds: 600,
  retainedReleases: 20,
  retainedVersions: 50,
});
