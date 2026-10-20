import { z } from 'zod';
import type { SourceDependency } from '@tulipfarm/access';
import type { GitHubRead } from './read-contracts.ts';

const project = z.object({
  id: z.string(),
  number: z.number(),
  owner: z.object({ id: z.string(), login: z.string(), __typename: z.enum(['User', 'Organization']) }),
});
const repository = z.object({
  id: z.string(),
  databaseId: z.number(),
  nameWithOwner: z.string(),
  owner: z.object({ id: z.string(), login: z.string() }),
});
const content = z
  .discriminatedUnion('__typename', [
    z.object({ __typename: z.literal('DraftIssue'), id: z.string() }),
    z.object({ __typename: z.enum(['Issue', 'PullRequest']), id: z.string(), repository }),
    z.object({ __typename: z.literal('RedactedProjectV2Item') }),
  ])
  .nullable();
export function projectSourceIdentity(operation: GitHubRead, data: unknown) {
  if (
    !['project.read', 'project.fields', 'project.items', 'project.item', 'project.item-field'].includes(operation.kind)
  )
    return undefined;
  const result = z
    .object({
      sourceIdentity: project.optional(),
      project: project.optional(),
      nodes: z.array(z.object({ content: content.optional() }).passthrough()).optional(),
      content: content.optional(),
    })
    .passthrough()
    .parse(data);
  const identity = project.parse(operation.kind === 'project.read' ? data : (result.sourceIdentity ?? result.project));
  const contents = [
    ...(result.nodes ?? []).flatMap(item => (item.content ? [item.content] : [])),
    ...(result.content ? [result.content] : []),
  ];
  const repositories = contents.flatMap(item => ('repository' in item ? [item.repository] : []));
  return {
    projectId: identity.id,
    projectNumber: identity.number,
    ownerNodeId: identity.owner.id,
    owner: identity.owner.login,
    ownerType: identity.owner.__typename === 'User' ? ('user' as const) : ('organization' as const),
    repositories,
  };
}
type Source = Extract<SourceDependency, { kind: 'github-personal' }>;
export function projectListIdentity(operation: GitHubRead, data: unknown) {
  if (operation.kind !== 'project.list') return undefined;
  const list = z.object({ ownerIdentity: project.shape.owner, nodes: z.array(project).max(30) }).parse(data);
  return {
    ownerNodeId: list.ownerIdentity.id,
    projects: list.nodes.map(node => ({
      projectId: node.id,
      projectNumber: node.number,
      ownerNodeId: node.owner.id,
      owner: node.owner.login,
      ownerType: node.owner.__typename === 'User' ? ('user' as const) : ('organization' as const),
      repositories: [],
    })),
  };
}
export function projectSourceOperation(source: Source) {
  const identity = source.proof?.projectIdentity;
  return identity
    ? {
        kind: 'project.read' as const,
        owner: identity.owner,
        ownerType: identity.ownerType,
        number: identity.projectNumber,
      }
    : null;
}
