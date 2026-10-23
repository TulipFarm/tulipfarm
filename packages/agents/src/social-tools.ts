import { z } from 'zod';
import type { HumanActor, SourceDependency } from '@tulipfarm/access';
import { agentToolInputSchemas, agentToolResultSchemas, reviseBodySchema } from '@tulipfarm/social/contracts';
import type { Channel, Origin, Post, PreparedPost } from '@tulipfarm/social/contracts';

/**
 * Social publishing tools (TECH, Agents, Workflows and chat). Their provider names are FORMAT's `social_*` names.
 * No tool publishes, approves, rejects or sets review choices: a person decides on the review card (PRODUCT 36).
 * The runtime supplies `commandId` and `origin`; a model never can.
 */
export const socialCallSchema = z.discriminatedUnion('tool', [
  agentToolInputSchemas.social_list_channels.extend({ tool: z.literal('social.list.channels') }),
  agentToolInputSchemas.social_prepare_post.extend({ tool: z.literal('social.prepare.post') }),
  z.strictObject({ tool: z.literal('social.read.post'), postId: z.uuid() }),
  reviseBodySchema.extend({ tool: z.literal('social.revise.post'), postId: z.uuid() }),
]);
export type SocialCall = z.infer<typeof socialCallSchema>;
export const socialToolNames = socialCallSchema.options.map(option => option.shape.tool.value);

/** Who the tool acts as: the chat's member, or a saved agent for its sponsor. Grants are the principal's own. */
export type SocialToolPrincipal = HumanActor | { kind: 'agent'; agentId: string; sponsor: HumanActor };

/** The social services the tools call; the composition binds them to the workspace runtime. */
export type SocialTools = {
  listChannels(
    workspaceId: string,
    principal: SocialToolPrincipal,
    filter: { platform?: Channel['platform'] },
  ): Promise<Channel[]>;
  prepare(
    workspaceId: string,
    principal: SocialToolPrincipal,
    input: { commandId: string; origin: Origin; variants: unknown },
    sources: { dependencies: readonly SourceDependency[] },
  ): Promise<PreparedPost>;
  get(workspaceId: string, principal: SocialToolPrincipal, postId: string): Promise<Post>;
  revise(
    workspaceId: string,
    principal: SocialToolPrincipal,
    postId: string,
    input: { expectedRevision: number; variants: unknown },
    sources: { dependencies: readonly SourceDependency[] },
  ): Promise<PreparedPost>;
};

/**
 * Where the call came from. A chat's post depends on the conversation and its current sources; a task's on the
 * task's retained sources (TECH, Source closure). A private task's result keeps the post from being approved.
 */
export type SocialToolOrigin =
  | { kind: 'conversation'; conversationId: string; messageId: string; sources: readonly SourceDependency[] }
  | { kind: 'task'; taskId: string; generation: number; sources: readonly SourceDependency[] };

export const socialDescriptions: Record<SocialCall['tool'], string> = {
  'social.list.channels':
    'List the social channels you may prepare posts for, with each channel’s version and grants. Optionally filter by platform. Use a channel’s id and version when preparing a post. This publishes nothing.',
  'social.prepare.post':
    'Prepare one social post for human review, with one variant per channel (at most 10), each with platform content, optional target and publishAt (null publishes on approval). Returns the post id and each variant’s validation errors. It never publishes: a person reviews every variant, sets any required review choices and approves on the review card in chat.',
  'social.read.post':
    'Read a social post you prepared or may publish: its revisions, decision, and each variant’s state, blocked reason and receipts. Use it to report status; it changes nothing.',
  'social.revise.post':
    'Write a new revision of a social post, replacing content for variants that have not been attempted. Supply expectedRevision from social.read.post. The new revision needs a fresh human approval on the review card.',
};

const preparedResult = (prepared: PreparedPost) =>
  agentToolResultSchemas.social_prepare_post.parse({
    postId: prepared.post.id,
    // The review card approves the post's current revision, so the post id is the approval to watch.
    approvalId: prepared.post.id,
    variants: prepared.variants,
  });

function postOrigin(origin: SocialToolOrigin): Origin {
  return origin.kind === 'conversation'
    ? { kind: 'conversation', conversationId: origin.conversationId, messageId: origin.messageId }
    : { kind: 'task', taskId: origin.taskId, generation: origin.generation };
}

/** The source closure stored on the revision: the origin itself and the sources it currently depends on. */
export function socialPostSources(origin: SocialToolOrigin): { dependencies: SourceDependency[] } {
  const own: SourceDependency =
    origin.kind === 'conversation'
      ? { kind: 'private-conversation', conversationId: origin.conversationId }
      : { kind: 'private-task', taskId: origin.taskId };
  const seen = new Set<string>();
  const dependencies: SourceDependency[] = [];
  for (const source of [own, ...origin.sources]) {
    const key = JSON.stringify(source);
    if (seen.has(key)) continue;
    seen.add(key);
    dependencies.push(source);
  }
  return { dependencies };
}

export async function invokeSocialTool(
  service: SocialTools | undefined,
  context: { workspaceId: string; principal: SocialToolPrincipal; callId: string; origin?: SocialToolOrigin },
  call: SocialCall,
) {
  if (!service)
    return {
      error: 'social-unavailable',
      instruction: 'Social publishing is not available in this workspace. Do not retry through another tool.',
    };
  const { workspaceId, principal, callId } = context;
  switch (call.tool) {
    case 'social.list.channels':
      return agentToolResultSchemas.social_list_channels.parse({
        channels: await service.listChannels(workspaceId, principal, call.platform ? { platform: call.platform } : {}),
      });
    case 'social.prepare.post': {
      if (!context.origin) return { error: 'social-origin-required' };
      return preparedResult(
        await service.prepare(
          workspaceId,
          principal,
          { commandId: callId, origin: postOrigin(context.origin), variants: call.variants },
          socialPostSources(context.origin),
        ),
      );
    }
    case 'social.read.post':
      return service.get(workspaceId, principal, call.postId);
    case 'social.revise.post': {
      if (!context.origin) return { error: 'social-origin-required' };
      return preparedResult(
        await service.revise(
          workspaceId,
          principal,
          call.postId,
          { expectedRevision: call.expectedRevision, variants: call.variants },
          socialPostSources(context.origin),
        ),
      );
    }
  }
}
