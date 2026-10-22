import { z } from 'zod';
import { libraryItemSchema } from '@tulipfarm/files/contracts';

const defaults = {
  parentId: null,
  mediaType: null,
  size: null,
  trashed: false,
  role: 'manager',
  deletion: null,
  stranded: false,
  modifiedAt: null,
  parentName: null,
};

export function libraryItem(fields) {
  const item = { ...defaults, ...fields };
  const parsed = libraryItemSchema.safeParse(item);
  if (!parsed.success)
    throw new Error(
      `Library item fixture "${item.name}" does not match libraryItemSchema. Add a default for any new field in apps/web/test/files-library.fixture.mjs.\n${z.prettifyError(parsed.error)}`,
    );
  return item;
}
