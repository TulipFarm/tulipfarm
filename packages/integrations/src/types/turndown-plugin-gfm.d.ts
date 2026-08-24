/**
 * Hand-written because the package ships no types and DefinitelyTyped has no entry for it.
 *
 * Only the plugins actually used are declared; `Plugin` mirrors turndown's own signature.
 */
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export type GfmPlugin = (service: TurndownService) => void;

  export const gfm: GfmPlugin;
  export const tables: GfmPlugin;
  export const strikethrough: GfmPlugin;
  export const taskListItems: GfmPlugin;
}
