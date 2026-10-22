// Import first in a process entrypoint: modules may read configuration as they load.
import { loadSecretFiles } from './secret-files.ts';

loadSecretFiles();
