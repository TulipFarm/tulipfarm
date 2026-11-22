import type { z } from 'zod';
import type { AccessDecision, Authorizer } from './authorizer.ts';
import type { ExternalSource, KnowledgeDocument, Principal, Actor } from '../documents/records.ts';
import type { originalSchema, KnowledgeCitation } from '../documents/contracts.ts';

export type KnowledgeDependency = Omit<KnowledgeCitation, 'ordinal'>;
export type KnowledgeChecks<Dependency extends { kind: string }> = {
  source: { input: { value: ExternalSource | undefined; writing: boolean }; value: ExternalSource };
  dependencies: {
    input: { original: z.infer<typeof originalSchema>; sources: Dependency[] };
    value: Dependency[];
  };
  observation: { input: { sources: Dependency[]; conversation: boolean; documentId: string }; value: void };
  protectedSource: { input: Dependency; value: void };
  file: { input: string; value: unknown };
  member: { input: undefined; value: unknown };
  conversation: { input: { revisionId: string; writing: boolean }; value: void };
  proof: { input: { document: KnowledgeDocument; source: ExternalSource }; value: void };
  tenant: { input: string; value: void };
  binding: {
    input: { document: KnowledgeDocument; source: ExternalSource; dependency: KnowledgeDependency };
    value: void;
  };
};
export interface KnowledgeAuthorization<Context, Dependency extends { kind: string }> {
  authority(context: Context, principal: Principal): Authorizer<KnowledgeChecks<Dependency>>;
  admit(context: Context, actor: Actor | string, mode: 'read' | 'write'): Promise<AccessDecision<Principal>>;
  document(value: KnowledgeDocument | undefined): Promise<AccessDecision<KnowledgeDocument>>;
  bind<Value extends Context>(
    context: Value,
    eligible: (context: Context, principal: Principal, dependency: KnowledgeDependency) => Promise<unknown>,
  ): Value;
  knowledgeDependency(dependency: Dependency): KnowledgeDependency | undefined;
}
export type AccessErrors = {
  AccessDenied: new () => Error;
  SourceAuthorizationUnavailable: new () => Error;
};
