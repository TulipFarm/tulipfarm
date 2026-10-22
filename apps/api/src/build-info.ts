import { readBuildInfo } from '@tulipfarm/build-info/node';

export const buildInfo = readBuildInfo('api', new URL('../version.json', import.meta.url));
