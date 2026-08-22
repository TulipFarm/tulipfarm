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

// ISO 8601 date-time format support
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidIsoDateTime(str: string): boolean {
  const match = str.match(ISO_DATE_TIME);
  if (!match) return false;
  const [, yStr, mStr, dStr, hStr, minStr, sStr] = match;
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const h = Number(hStr);
  const min = Number(minStr);
  const s = Number(sStr);
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59 || s > 59) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

ajv.addFormat("date-time", {
  type: "string",
  validate: isValidIsoDateTime,
});
