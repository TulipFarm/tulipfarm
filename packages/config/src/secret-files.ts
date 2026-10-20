import { readFileSync } from 'node:fs';
import { secretSettingNames } from './settings.ts';

export class SecretFileError extends Error {
  readonly variable: string;
  constructor(variable: string, message: string) {
    super(message);
    this.name = 'SecretFileError';
    this.variable = variable;
  }
}

type Environment = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

/**
 * For each secret setting NAME, reads NAME_FILE into NAME, without a trailing newline.
 * This follows the Docker and Kubernetes secret-file convention, so any store that can
 * mount a file can deliver secrets. Errors name the variable and path, never the value.
 */
export function loadSecretFiles(
  env: Environment = process.env,
  names: readonly string[] = secretSettingNames,
  read: ReadFile = path => readFileSync(path, 'utf8'),
): string[] {
  const loaded: string[] = [];
  for (const name of names) {
    const path = env[`${name}_FILE`];
    if (path === undefined || path === '') continue;
    let value: string;
    try {
      value = read(path).replace(/[\r\n]+$/, '');
    } catch {
      throw new SecretFileError(name, `${name}_FILE could not be read: ${path}`);
    }
    const direct = env[name];
    if (direct !== undefined && direct !== '' && direct !== value) {
      throw new SecretFileError(name, `${name} and ${name}_FILE are both set with different values; set only one`);
    }
    env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
