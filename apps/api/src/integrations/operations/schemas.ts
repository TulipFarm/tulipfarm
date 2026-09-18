import { Type } from "@sinclair/typebox";

const Timestamp = Type.Union([Type.String(), Type.Null()]);
export const KnowledgeSubscriptionSchema = Type.Object({
  businessId: Type.String(),
  integrationSlug: Type.String(),
  integrationId: Type.String(),
  integrationMajorVersion: Type.Integer(),
  connectionId: Type.String(),
  sourceKindId: Type.String(),
  scopes: Type.Array(Type.String()),
  classification: Type.Array(Type.String()),
  aclMaximumAgeSeconds: Type.Integer(),
  liveMaximumAgeSeconds: Type.Integer(),
  enabled: Type.Boolean(),
  revision: Type.Integer(),
  lastAttemptAt: Timestamp,
  lastSuccessAt: Timestamp,
  lastErrorCodes: Type.Array(Type.String()),
});

export const IntegrationOperationsSchema = Type.Object({
  sourceKinds: Type.Array(
    Type.Object({
      id: Type.String(),
      label: Type.String(),
      description: Type.Optional(Type.String()),
    })
  ),
  liveAuthorization: Type.Boolean(),
  ingress: Timestamp,
  observedAt: Type.String(),
  connections: Type.Array(
    Type.Object({
      connectionId: Type.String(),
      label: Type.String(),
      authorization: Type.String(),
      disconnectPending: Type.Boolean(),
      subscriptions: Type.Array(KnowledgeSubscriptionSchema),
      operations: Type.Object({
        webhook: Type.Union([
          Type.Null(),
          Type.Object({
            state: Type.String(),
            desiredState: Type.String(),
            attempts: Type.Integer(),
            nextAttemptAt: Type.String(),
            hasError: Type.Boolean(),
            updatedAt: Type.String(),
          }),
        ]),
        delivery: Type.Object({
          pending: Type.Integer(),
          retrying: Type.Integer(),
          deadLetter: Type.Integer(),
          dispatched: Type.Integer(),
          nextAttemptAt: Timestamp,
          hasError: Type.Boolean(),
        }),
        polling: Type.Union([
          Type.Null(),
          Type.Object({
            nextPollAt: Type.String(),
            leaseExpiresAt: Timestamp,
          }),
        ]),
        sync: Type.Array(
          Type.Object({
            sourceKindId: Type.String(),
            scope: Type.String(),
            inProgress: Type.Boolean(),
            pendingDeletions: Type.Integer(),
            requiresFullRebuild: Type.Boolean(),
            updatedAt: Type.String(),
          })
        ),
      }),
    })
  ),
});

export const SaveKnowledgeSubscriptionSchema = Type.Object(
  {
    sourceKindId: Type.String({ minLength: 1, maxLength: 128 }),
    scopes: Type.Array(Type.String({ minLength: 1, maxLength: 1024, pattern: "\\S" }), {
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    }),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false }
);
