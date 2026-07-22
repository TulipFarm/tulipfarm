import { type Static, Type } from "@sinclair/typebox";
import {
  DEFINITION_API_VERSION,
  type DefinitionMetadata,
  definitionMetadataSchema,
  definitionRegistration,
} from "./common";

const apiVersion = DEFINITION_API_VERSION;
const idPattern =
  "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9A-HJKMNP-TV-Z]{26})$";
const slugPattern = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const actionPattern = "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$";
const dateTimePattern =
  "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?Z$";
const digestPattern = "^[a-f0-9]{64}$";
const opaqueTokenPattern = "^[A-Za-z0-9_-]+$";

const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);

const BindingSchema = Type.Object(
  { path: Type.String({ pattern: "^/(?:[^~/]|~0|~1)*(?:/(?:[^~/]|~0|~1)*)*$" }) },
  { additionalProperties: false }
);

const ValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  BindingSchema,
]);

const NodeSchema = Type.Recursive((Node) =>
  Type.Union([
    Type.Object(
      {
        id: Type.Optional(Type.String({ pattern: slugPattern })),
        component: Type.Union([
          Type.Literal("Card"),
          Type.Literal("Row"),
          Type.Literal("Column"),
          Type.Literal("Grid"),
        ]),
        children: Type.Array(Node),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        id: Type.Optional(Type.String({ pattern: slugPattern })),
        component: Type.Union([
          Type.Literal("Heading"),
          Type.Literal("Text"),
          Type.Literal("Badge"),
          Type.Literal("Alert"),
        ]),
        text: ValueSchema,
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        id: Type.Optional(Type.String({ pattern: slugPattern })),
        component: Type.Literal("Button"),
        label: ValueSchema,
        actionRef: Type.String({ pattern: slugPattern }),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        id: Type.Optional(Type.String({ pattern: slugPattern })),
        component: Type.Literal("Form"),
        formId: Type.String({ pattern: idPattern }),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        id: Type.Optional(Type.String({ pattern: slugPattern })),
        component: Type.Union([
          Type.Literal("MetricCard"),
          Type.Literal("List"),
          Type.Literal("DetailView"),
          Type.Literal("DataTable"),
          Type.Literal("BarChart"),
          Type.Literal("LineChart"),
          Type.Literal("ForceGraph"),
        ]),
        data: BindingSchema,
      },
      { additionalProperties: false }
    ),
  ])
);

const AudienceSchema = Type.Object(
  {
    roleIds: Type.Array(Type.String({ pattern: idPattern }), { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false }
);

const InputValueSchema = Type.Recursive((Schema) =>
  Type.Union([
    Type.Boolean(),
    Type.Object(
      {
        type: Type.Literal("string"),
        minLength: Type.Optional(Type.Integer({ minimum: 0 })),
        maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
        pattern: Type.Optional(Type.String({ minLength: 1 })),
        enum: Type.Optional(Type.Array(Type.String(), { minItems: 1, uniqueItems: true })),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        type: Type.Union([Type.Literal("number"), Type.Literal("integer")]),
        minimum: Type.Optional(Type.Number()),
        maximum: Type.Optional(Type.Number()),
      },
      { additionalProperties: false }
    ),
    Type.Object({ type: Type.Literal("boolean") }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal("null") }, { additionalProperties: false }),
    Type.Object(
      {
        type: Type.Literal("array"),
        items: Schema,
        minItems: Type.Optional(Type.Integer({ minimum: 0 })),
        maxItems: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        type: Type.Literal("object"),
        additionalProperties: Type.Boolean(),
        properties: Type.Optional(Type.Object({}, { additionalProperties: Schema })),
        required: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
        ),
      },
      { additionalProperties: false }
    ),
  ])
);

const ObjectInputSchema = Type.Object(
  {
    type: Type.Literal("object"),
    additionalProperties: Type.Boolean(),
    properties: Type.Optional(Type.Object({}, { additionalProperties: InputValueSchema })),
    required: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
    ),
  },
  { additionalProperties: false }
);

const ActionSchema = Type.Object(
  {
    id: Type.String({ pattern: slugPattern }),
    action: Type.String({ pattern: actionPattern }),
    targetRefs: Type.Array(
      Type.Object(
        {
          type: Type.String({ pattern: slugPattern }),
          id: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false }
      ),
      { minItems: 1 }
    ),
    routineId: Type.String({ pattern: idPattern }),
    stateId: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9]*$" }),
    inputSchema: ObjectInputSchema,
    audience: AudienceSchema,
    expiresInSeconds: Type.Integer({ minimum: 1, maximum: 86400 }),
    guardrailId: Type.String({ pattern: idPattern }),
    guardrailVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);

export const A2UITemplateSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("A2UITemplate"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
        root: NodeSchema,
        actions: Type.Array(ActionSchema),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/A2UITemplate`, additionalProperties: false }
);
export const A2UI_TEMPLATE_DEFINITION = definitionRegistration("A2UITemplate", A2UITemplateSchema);

export type A2UITemplateDefinition = Static<typeof A2UITemplateSchema>;

const RuntimeTargetReferenceSchema = Type.Object(
  {
    type: Type.String({ pattern: slugPattern }),
    id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

const RuntimeContextSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("run"), runId: Type.String({ pattern: idPattern }) },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("conversation"),
      conversationId: Type.String({ pattern: idPattern }),
    },
    { additionalProperties: false }
  ),
]);

export const A2UIActionDescriptorSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("A2UIActionDescriptor"),
    action: Type.String({ pattern: actionPattern }),
    targetRefs: Type.Array(RuntimeTargetReferenceSchema, { minItems: 1 }),
    inputSchemaDigest: Type.String({ pattern: digestPattern }),
    routineId: Type.String({ pattern: idPattern }),
    stateId: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9]*$" }),
    audience: AudienceSchema,
    context: RuntimeContextSchema,
    nonce: Type.String({ minLength: 32, pattern: opaqueTokenPattern }),
    expiresAt: Type.String({ pattern: dateTimePattern }),
    guardrailRevision: Type.String({ pattern: digestPattern }),
    signature: Type.String({ minLength: 43, pattern: opaqueTokenPattern }),
  },
  { $id: `${apiVersion}/A2UIActionDescriptor`, additionalProperties: false }
);

export type A2UIActionDescriptor = Static<typeof A2UIActionDescriptorSchema>;
