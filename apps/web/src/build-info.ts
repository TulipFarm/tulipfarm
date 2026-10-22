import { buildInfoSchema } from '@tulipfarm/build-info';

declare const __BUILD_INFO__: unknown;
export const buildInfo = Object.freeze(buildInfoSchema.parse(__BUILD_INFO__));

export function reportBuild() {
  window.dispatchEvent(new CustomEvent('tulipfarm:build', { detail: buildInfo }));
  document.documentElement.dataset.serviceVersion = buildInfo.version;
}
