import { z } from 'zod';
import { GitHubReadError, type GitHubRead } from './read-contracts.ts';

const pageInfo = 'pageInfo { hasNextPage endCursor }';
const projectOwner = 'owner { __typename ... on User { id login } ... on Organization { id login } }';
const projectIdentity = `id number ${projectOwner}`;
const project = `${projectIdentity} title shortDescription readme url closed public`;
const category = 'id name description emoji isAnswerable';
const comment = 'id body url createdAt updatedAt author { login }';
const repositoryIdentity = 'id databaseId nameWithOwner owner { id login }';
const discussion = `id number title body url createdAt updatedAt locked repository { ${repositoryIdentity} } author { login } category { ${category} } answer { ${comment} }`;
const field = `__typename ... on ProjectV2FieldCommon { id name dataType }
  ... on ProjectV2SingleSelectField { options { id name color description } }
  ... on ProjectV2MultiSelectField { multiSelectOptions { id name color description } }
  ... on ProjectV2IterationField { configuration { duration startDay iterations { id title startDate duration } completedIterations { id title startDate duration } } }`;
const item = `id type isArchived updatedAt content { __typename
  ... on DraftIssue { id title body }
  ... on Issue { id number title body url repository { ${repositoryIdentity} } }
  ... on PullRequest { id number title body url repository { ${repositoryIdentity} } } }`;
const fieldValue = (paging: string) => `__typename
  ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id name } } }
  ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id name } } }
  ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id name } } }
  ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { id name } } }
  ... on ProjectV2ItemFieldMultiSelectValue { options { id name color description } field { ... on ProjectV2FieldCommon { id name } } }
  ... on ProjectV2ItemFieldIterationValue { title iterationId startDate duration field { ... on ProjectV2FieldCommon { id name } } }
  ... on ProjectV2ItemFieldRepositoryValue { repository { id nameWithOwner url } field { ... on ProjectV2FieldCommon { id name } } }
  ... on ProjectV2ItemFieldMilestoneValue { milestone { id title } field { ... on ProjectV2FieldCommon { id name } } }
  ... on ProjectV2ItemFieldLabelValue { field { ... on ProjectV2FieldCommon { id name } } labels(${paging}) { nodes { id name } ${pageInfo} } }
  ... on ProjectV2ItemFieldUserValue { field { ... on ProjectV2FieldCommon { id name } } users(${paging}) { nodes { id login } ${pageInfo} } }
  ... on ProjectV2ItemFieldPullRequestValue { field { ... on ProjectV2FieldCommon { id name } } pullRequests(${paging}) { nodes { id number title url } ${pageInfo} } }
  ... on ProjectV2ItemFieldReviewerValue { field { ... on ProjectV2FieldCommon { id name } } reviewers(${paging}) { nodes { __typename ... on User { login } ... on Team { name slug } } ${pageInfo} } }`;
const fieldValues = `nodes { ${fieldValue('first: 10')} } ${pageInfo}`;

const ownerQueries = (declarations: string, selection: string) => ({
  user: `query($owner: String!${declarations}) { target: user(login: $owner) { ${selection} } }`,
  organization: `query($owner: String!${declarations}) { target: organization(login: $owner) { ${selection} } }`,
});
const repositoryQuery = (declarations: string, selection: string) =>
  `query($owner: String!, $repo: String!${declarations}) { target: repository(owner: $owner, name: $repo) { ${selection} } }`;
const paging = ', $perPage: Int!, $after: String';
const args = 'first: $perPage, after: $after';
const singleFieldValue = fieldValue(args);

export const githubGraphqlQueries = {
  'project.list': ownerQueries(
    `${paging}, $query: String`,
    `id login __typename viewerCanCreateProjects result: projectsV2(${args}, query: $query) { nodes { ${project} } ${pageInfo} }`,
  ),
  'project.read': ownerQueries(', $number: Int!', `result: projectV2(number: $number) { ${project} }`),
  'project.fields': ownerQueries(
    `, $number: Int!${paging}`,
    `projectV2(number: $number) { ${projectIdentity} result: fields(${args}) { nodes { ${field} } ${pageInfo} } }`,
  ),
  'project.items': ownerQueries(
    `, $number: Int!${paging}`,
    `projectV2(number: $number) { ${projectIdentity} result: items(${args}) { nodes { ${item} } ${pageInfo} } }`,
  ),
  'project.item': `query($itemId: ID!${paging}) { target: node(id: $itemId) { ... on ProjectV2Item { ${item} project { ${projectIdentity} } fieldValues(${args}) { ${fieldValues} } } } }`,
  'project.item-field': `query($itemId: ID!, $fieldName: String!${paging}) { target: node(id: $itemId) { ... on ProjectV2Item { ${item} project { ${projectIdentity} } fieldValueByName(name: $fieldName) { ${singleFieldValue} } } } }`,
  'discussion.list': repositoryQuery(
    paging,
    `result: discussions(${args}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${discussion} } ${pageInfo} }`,
  ),
  'discussion.read': repositoryQuery(', $number: Int!', `result: discussion(number: $number) { ${discussion} }`),
  'discussion.categories': repositoryQuery(
    paging,
    `result: discussionCategories(${args}) { nodes { ${category} } ${pageInfo} }`,
  ),
  'discussion.comments': repositoryQuery(
    `, $number: Int!${paging}`,
    `discussion(number: $number) { id repository { ${repositoryIdentity} } result: comments(${args}) { nodes { ${comment} replyTo { id } replies(first: 1) { totalCount } } ${pageInfo} } }`,
  ),
  'discussion.replies': `query($commentId: ID!${paging}) { target: node(id: $commentId) { ... on DiscussionComment { id discussion { id number repository { name ${repositoryIdentity} } } result: replies(${args}) { nodes { ${comment} replyTo { id } } ${pageInfo} } } } }`,
  'discussion.search': `query($query: String!${paging}) { result: search(query: $query, type: DISCUSSION, ${args}) { discussionCount nodes { ... on Discussion { ${discussion} } } ${pageInfo} } }`,
};

const object = z.record(z.string(), z.json());
const connection = z
  .object({
    nodes: z.array(object).max(30),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  })
  .passthrough();
function checkProjectOwner(operation: Extract<GitHubRead, { ownerType: unknown }>, value: unknown) {
  const owner = z
    .object({ id: z.string(), login: z.string(), __typename: z.enum(['User', 'Organization']) })
    .parse(value);
  if (
    owner.login.toLowerCase() !== operation.owner.toLowerCase() ||
    owner.__typename.toLowerCase() !== operation.ownerType
  )
    throw new GitHubReadError('read-forbidden');
}
export function parseGraphqlRead(value: unknown, operation: GitHubRead) {
  const envelope = z
    .object({ data: object.nullable().optional(), errors: z.array(z.unknown()).optional() })
    .parse(value);
  if (envelope.errors?.some(error => z.object({ type: z.literal('RATE_LIMITED') }).safeParse(error).success))
    throw new GitHubReadError('read-rate-limited');
  if (envelope.errors?.length || !envelope.data) throw new GitHubReadError('read-forbidden');
  let result: unknown;
  let sourceIdentity: unknown;
  let ownerIdentity: unknown;
  if (operation.kind === 'discussion.search') result = envelope.data.result;
  else {
    const target = object.parse(envelope.data.target);
    if (operation.kind === 'project.list') {
      ownerIdentity = z
        .object({
          id: z.string(),
          login: z.string(),
          __typename: z.enum(['User', 'Organization']),
          viewerCanCreateProjects: z.boolean(),
        })
        .parse(target);
      checkProjectOwner(operation, ownerIdentity);
    }
    if (operation.kind === 'project.item' || operation.kind === 'project.item-field') {
      const itemProject = z
        .object({
          number: z.number(),
          owner: z.object({ __typename: z.enum(['User', 'Organization']), login: z.string() }),
        })
        .parse(target.project);
      if (
        target.id !== operation.itemId ||
        itemProject.number !== operation.number ||
        itemProject.owner.login.toLowerCase() !== operation.owner.toLowerCase() ||
        itemProject.owner.__typename.toLowerCase() !== operation.ownerType
      )
        throw new GitHubReadError('read-forbidden');
      if (operation.kind === 'project.item') {
        if (connection.parse(target.fieldValues).nodes.length > operation.perPage)
          throw new GitHubReadError('read-limit');
      } else if (target.fieldValueByName !== null) {
        const value = object.parse(target.fieldValueByName);
        for (const key of ['labels', 'users', 'pullRequests', 'reviewers'])
          if (value[key] !== undefined && connection.parse(value[key]).nodes.length > operation.perPage)
            throw new GitHubReadError('read-limit');
      }
      return object.parse(target);
    }
    if (operation.kind === 'discussion.replies') {
      const parent = z
        .object({
          number: z.number(),
          repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
        })
        .parse(target.discussion);
      if (
        target.id !== operation.commentId ||
        parent.number !== operation.number ||
        parent.repository.name.toLowerCase() !== operation.repo.toLowerCase() ||
        parent.repository.owner.login.toLowerCase() !== operation.owner.toLowerCase()
      )
        throw new GitHubReadError('read-forbidden');
    }
    const nested =
      operation.kind === 'project.fields' || operation.kind === 'project.items'
        ? object.parse(target.projectV2)
        : operation.kind === 'discussion.comments'
          ? object.parse(target.discussion)
          : target;
    result = nested.result;
    if (
      operation.kind === 'project.read' ||
      operation.kind === 'project.fields' ||
      operation.kind === 'project.items'
    ) {
      const identity = z
        .object({ id: z.string(), number: z.literal(operation.number), owner: object })
        .parse(operation.kind === 'project.read' ? result : nested);
      checkProjectOwner(operation, identity.owner);
    }
    if (operation.kind === 'project.fields' || operation.kind === 'project.items')
      sourceIdentity = { id: nested.id, number: nested.number, owner: nested.owner };
    if (operation.kind === 'discussion.comments')
      sourceIdentity = { discussionId: nested.id, repository: nested.repository };
    if (operation.kind === 'discussion.replies') {
      const parent = object.parse(target.discussion);
      sourceIdentity = { discussionId: parent.id, repository: parent.repository };
    }
  }
  if (operation.kind === 'project.read' || operation.kind === 'discussion.read')
    return z.object({ id: z.string(), number: z.number(), title: z.string() }).passthrough().parse(result);
  const parsed = connection.parse(result);
  if ('perPage' in operation && parsed.nodes.length > operation.perPage) throw new GitHubReadError('read-limit');
  return sourceIdentity ? { ...parsed, sourceIdentity } : ownerIdentity ? { ...parsed, ownerIdentity } : parsed;
}
