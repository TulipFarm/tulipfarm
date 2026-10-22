export { createFeatureClient, type FeatureClient, type FeatureChange } from './client';
export { SessionQueryProvider, WorkspaceQueryProvider, useFeatureScope } from './provider';
export { useFeatureRead, useFeatureChanges, useCatalogRestoration } from './use-feature-read';
export { useLoadedWindow } from './loaded-window';
export { featureReadOptions, type FeatureReadOptions } from './options';
export { featureKey, scopeKey, type FeatureScope, type WorkspaceScope, type SessionIdentity } from './scope';
export { freshness } from './policy';
export { createCatalogPersistence, parseCatalogSnapshot, catalogMaxAge } from './catalog-persistence';
export type { QueryKey } from '@tanstack/react-query';
