// The usage route validates its search with this module, so keep it free of UI imports.
import { z } from 'zod';

const optional = z.string().max(4000).optional().catch(undefined);

/** The explorer's view lives in the URL so a link reopens the same breakdown. Values are checked where they are read. */
export const usageSearchSchema = z.object({
  view: optional,
  group: optional,
  cols: optional,
  measure: optional,
  sort: optional,
  chart: optional,
  filter: optional,
  range: optional,
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  q: optional,
});
export type UsageSearch = z.infer<typeof usageSearchSchema>;
