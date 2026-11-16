import { z } from 'zod';

export const recordIdSchema = z
  .uuid()
  .toLowerCase()
  .brand<'RecordId'>()
  .meta({ description: 'Stable UUID identifying one row; input is normalized to lowercase.' });
