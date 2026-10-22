import { escapeIdentifier } from 'pg';
import { z } from 'zod';

export const workspaceIdSchema = z
  .uuid()
  .transform(id => id.toLowerCase())
  .brand<'WorkspaceId'>();
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export function workspaceNames(id: string) {
  const workspaceId = workspaceIdSchema.parse(id);
  const schema = `ws_${workspaceId.replaceAll('-', '')}`;
  return {
    workspaceId,
    schema,
    runtime: `${schema}_runtime`,
    migration: `${schema}_migration`,
    confirmation: `${schema}_confirmation`,
    customOwner: `${schema}_owner`,
  };
}

/** Inverts workspaceNames(id).schema. */
export function workspaceIdFromSchema(schema: string) {
  const hex = /^ws_([0-9a-f]{32})$/.exec(schema)?.[1];
  if (!hex) throw new Error('Not a workspace schema');
  return workspaceIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

export function qualified(schema: string, relation: string) {
  return `${escapeIdentifier(schema)}.${escapeIdentifier(relation)}`;
}

export const commonTables = {
  migrations: 'tf_common_migrations',
  provisioning: 'tf_provisioning',
  memberships: 'tf_memberships',
  personalMemory: 'tf_personal_memory',
  budState: 'tf_bud_state',
  budNudges: 'tf_bud_nudges',
  budPreferences: 'tf_bud_preferences',
  authorizationLock: 'tf_authorization_lock',
  teams: 'tf_teams',
  memberTeams: 'tf_member_teams',
  grants: 'tf_grants',
  githubEventSources: 'tf_github_event_sources',
  githubEventSourceGrants: 'tf_github_event_source_grants',
  workflowAutomationDrafts: 'tf_workflow_automation_drafts',
  workflowAutomationDecisions: 'tf_workflow_automation_decisions',
  workflowAutomationGrants: 'tf_workflow_automation_grants',
  workflowAutomationEvents: 'tf_workflow_automation_events',
  workflowAutomationReservations: 'tf_workflow_automation_reservations',
  soulHead: 'tf_soul_head',
  authoringCommands: 'tf_authoring_commands',
  soulRevisions: 'tf_soul_revisions',
  tableCatalog: 'tf_table_catalog',
  systemTables: 'tf_system_tables',
  workspaceMemberAccounts: 'tf_workspace_member_accounts',
  workspaceMemberImages: 'tf_workspace_member_images',
  migrationJobs: 'tf_migration_jobs',
  confirmations: 'tf_confirmations',
  migrationLedger: 'tf_migration_ledger',
  outbox: 'tf_outbox',
  auditEvents: 'tf_audit_events',
  recommendationSnapshots: 'tf_recommendation_snapshots',
  recommendationRefresh: 'tf_recommendation_refresh',
  recommendationEvents: 'tf_recommendation_events',
  recommendationExpiries: 'tf_recommendation_expiries',
  recommendationResults: 'tf_recommendation_results',
  recommendationDependencies: 'tf_recommendation_dependencies',
} as const;

export function tableTableName(value: string) {
  return z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,47}$/)
    .refine(name => !name.startsWith('tf_') && !name.startsWith('pg_'), 'Reserved table prefix')
    .parse(value);
}
