import Ajv2020 from "ajv/dist/2020";
import draft06MetaSchema from "ajv/dist/refs/json-schema-draft-06.json";
import draft07MetaSchema from "ajv/dist/refs/json-schema-draft-07.json";

// strict:false: silently ignore x-* and other unknown keywords
export const ajv = new Ajv2020({ allErrors: true, strict: false });

// Ajv2020 only bundles the 2019-09 + 2020-12 meta-schemas. External MCP servers (e.g. GitHub's)
// commonly emit tool inputSchemas that declare `$schema: draft-07` (or draft-06); registering the
// older meta-schemas lets ajv.compile() resolve those refs instead of throwing
// `no schema with key or ref "http://json-schema.org/draft-07/schema#"`.
ajv.addMetaSchema(draft06MetaSchema);
ajv.addMetaSchema(draft07MetaSchema);
