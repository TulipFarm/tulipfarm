import { z } from 'zod';

/** Concrete model IDs, vendors and catalog revisions. */
export const modelIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
/** Model family IDs; workspace tables enforce the same pattern in CHECK constraints. */
export const modelFamilyIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/);
