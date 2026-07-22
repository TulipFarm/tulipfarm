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
const dateTimePattern =
  "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?Z$";
const digestPattern = "^[a-f0-9]{64}$";
const opaqueTokenPattern = "^[A-Za-z0-9_-]+$";

const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);

const AudienceSchema = Type.Object(
  {
    roleIds: Type.Array(Type.String({ pattern: idPattern }), { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false }
);

const FormFieldSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" }),
    label: Type.String({ minLength: 1 }),
    input: Type.Union([
      Type.Literal("text"),
      Type.Literal("email"),
      Type.Literal("number"),
      Type.Literal("textarea"),
      Type.Literal("select"),
      Type.Literal("radio"),
      Type.Literal("checkbox"),
      Type.Literal("switch"),
      Type.Literal("date"),
    ]),
    required: Type.Optional(Type.Boolean()),
    options: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
    ),
  },
  { additionalProperties: false }
);

export const FormSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("Form"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
        title: Type.String({ minLength: 1 }),
        submission: Type.Object(
          {
            triggerId: Type.String({ pattern: idPattern }),
            inputName: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" }),
          },
          { additionalProperties: false }
        ),
        audience: AudienceSchema,
        fields: Type.Array(FormFieldSchema, { minItems: 1 }),
        expiresInSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 604800 })),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/Form`, additionalProperties: false }
);
export const FORM_DEFINITION = definitionRegistration("Form", FormSchema);

export type FormDefinition = Static<typeof FormSchema>;

export const FormActionDescriptorSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("FormActionDescriptor"),
    formId: Type.String({ pattern: idPattern }),
    runId: Type.String({ pattern: idPattern }),
    runWaitId: Type.String({ pattern: idPattern }),
    schemaDigest: Type.String({ pattern: digestPattern }),
    audience: Type.Object(
      {
        kind: Type.Union([Type.Literal("user"), Type.Literal("role")]),
        id: Type.String({ pattern: idPattern }),
      },
      { additionalProperties: false }
    ),
    resumeToken: Type.String({ minLength: 32, pattern: opaqueTokenPattern }),
    nonce: Type.String({ minLength: 32, pattern: opaqueTokenPattern }),
    expiresAt: Type.String({ pattern: dateTimePattern }),
  },
  { $id: `${apiVersion}/FormActionDescriptor`, additionalProperties: false }
);

export type FormActionDescriptor = Static<typeof FormActionDescriptorSchema>;
