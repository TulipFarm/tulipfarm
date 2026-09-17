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
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidCalendarDate(value: string): boolean {
  const match = value.match(ISO_DATE);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

function isValidIsoDateTime(str: string): boolean {
  const match = str.match(ISO_DATE_TIME);
  if (!match) return false;
  const [, yStr, mStr, dStr, hStr, minStr, sStr] = match;
  const h = Number(hStr);
  const min = Number(minStr);
  const s = Number(sStr);
  return isValidCalendarDate(`${yStr}-${mStr}-${dStr}`) && h <= 23 && min <= 59 && s <= 59;
}

ajv.addFormat("date-time", {
  type: "string",
  validate: isValidIsoDateTime,
});

ajv.addFormat("date", {
  type: "string",
  validate: isValidCalendarDate,
});

const EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

ajv.addFormat("email", {
  type: "string",
  validate: EMAIL,
});
