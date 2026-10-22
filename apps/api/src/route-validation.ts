import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export function routeValidation(options: {
  target?: 'draft-7' | 'openapi-3.0';
  missing: string;
  invalid: (error: z.ZodError) => Error;
}) {
  const validators = new WeakMap<object, z.ZodType>();
  const lookup = (schema: unknown) =>
    typeof schema === 'object' && schema !== null ? validators.get(schema) : undefined;
  return {
    json(schema: z.ZodType) {
      const document = z.toJSONSchema(schema, { target: options.target ?? 'draft-7', io: 'input' });
      validators.set(document, schema);
      return document;
    },
    install(routes: FastifyInstance, serialize = false) {
      routes.setValidatorCompiler(({ schema }) => {
        const validator = lookup(schema);
        if (!validator) throw new Error(options.missing);
        return value => {
          const result = validator.safeParse(value);
          return result.success ? { value: result.data } : { error: options.invalid(result.error) };
        };
      });
      if (serialize)
        routes.setSerializerCompiler(({ schema }) => {
          const validator = lookup(schema);
          return value => JSON.stringify(validator ? validator.parse(value) : value);
        });
    },
  };
}
