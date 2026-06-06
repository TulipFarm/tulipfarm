import Ajv2020 from "ajv/dist/2020";

// strict:false: silently ignore x-* and other unknown keywords
export const ajv = new Ajv2020({ allErrors: true, strict: false });
