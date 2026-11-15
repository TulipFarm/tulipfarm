export type * from './slots.ts';
export {
  appBuilder,
  appHost,
  AppHostConflictError,
  AppHostUnavailableError,
  appPublisher,
  captureAnalytics,
  configuredExecutionBackend,
  creditGate,
  creditPricing,
  creditUnitsForProviderCost,
  emitHook,
  executionBackend,
  extensionMigrations,
  ExtensionRegistrationError,
  flagProvider,
  flushExtensions,
  identifyAnalyticsGroup,
  identifyAnalyticsPerson,
  loadedExtensions,
  mcpHost,
  providerCostPricing,
  recordUsage,
  registerExtension,
  reportError,
  resetExtensions,
  shutdownExtensions,
  socialPlatformApps,
  unavailableAppHost,
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
