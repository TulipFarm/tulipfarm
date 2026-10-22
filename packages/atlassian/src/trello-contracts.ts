import { z } from 'zod';

const trelloId = z.string().regex(/^[a-f0-9]{24}$/);
const cardChanges = z
  .strictObject({
    name: z.string().trim().min(1).max(1024).optional(),
    desc: z.string().max(65536).optional(),
    closed: z.boolean().optional(),
    due: z.iso.datetime().nullable().optional(),
    dueComplete: z.boolean().optional(),
  })
  .refine(value => Object.keys(value).length > 0);
export const trelloOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('card.search'),
    query: z.string().trim().min(1).max(512),
    page: z.number().int().min(0).max(100).default(0),
  }),
  z.strictObject({ kind: z.literal('card.read'), cardId: trelloId }),
  z.strictObject({
    kind: z.literal('card.create'),
    listId: trelloId,
    name: z.string().trim().min(1).max(1024),
    desc: z.string().max(65536).default(''),
  }),
  z.strictObject({ kind: z.literal('card.update'), cardId: trelloId, changes: cardChanges }),
  z.strictObject({ kind: z.literal('card.delete'), cardId: trelloId }),
]);
export type TrelloOperation = z.infer<typeof trelloOperationSchema>;
