export type * from './slots.ts';
export {
  captureAnalytics,
  creditGate,
  creditPricing,
  creditUnitsForProviderCost,
  emitHook,
  extensionMigrations,
  ExtensionRegistrationError,
  flagProvider,
  flushExtensions,
  loadedExtensions,
  providerCostPricing,
  recordUsage,
  registerExtension,
  reportError,
  resetExtensions,
  shutdownExtensions,
  socialPlatformApps,
  unlimitedCredits,
} from './registry.ts';
export {
  ExtensionLoadError,
  loadConfiguredExtensions,
  loadExtensions,
  parseExtensionSpecifiers,
  startExtensions,
  type LoadOptions,
} from './loader.ts';
import type { ServerExtension } from './slots.ts';

/** Typed identity helper for an extension module's default export. */
export function defineExtension(extension: ServerExtension): ServerExtension {
  return extension;
}
