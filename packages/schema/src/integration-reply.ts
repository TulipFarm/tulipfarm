import { type Static, Type } from "@sinclair/typebox";

export const IngressReplyResultSchema = Type.Union([
  Type.Object({ delivered: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object(
    {
      delivered: Type.Literal(false),
      outcome: Type.Union([
        Type.Literal("failed"),
        Type.Literal("retryable"),
        Type.Literal("ambiguous"),
      ]),
      code: Type.String({ minLength: 1, maxLength: 128 }),
      waitId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
]);

export type IngressReplyResult = Static<typeof IngressReplyResultSchema>;
