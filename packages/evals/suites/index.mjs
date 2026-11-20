import completion from './completion/index.mjs';
import guardrails from './guardrails/index.mjs';
import tables from './tables/index.mjs';
import toolChoice from './tool-choice/index.mjs';

export const suites = [tables, completion, toolChoice, guardrails];

export const list = value =>
  (value ?? '')
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(Boolean);

/** The suites to run: the named ones, else those whose source paths a change touches, else all. */
export function selectSuites(env = process.env) {
  const named = list(env.EVALS_SUITES);
  for (const name of named)
    if (!suites.some(suite => suite.name === name)) throw new Error(`Unknown eval suite ${name}`);
  const changed = env.EVALS_CHANGED_FILES === undefined ? null : list(env.EVALS_CHANGED_FILES);
  return suites.filter(
    suite =>
      (!named.length || named.includes(suite.name)) &&
      (!changed || changed.some(file => suite.paths.some(path => file.startsWith(path)))),
  );
}
