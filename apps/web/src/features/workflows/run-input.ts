import { stepValueEntries, type Definition } from '@tulipfarm/workflows/contracts';

export function runInputPaths(steps: Definition['steps']) {
  return steps.flatMap(step =>
    stepValueEntries(step).flatMap(({ value }) => (value.kind === 'input' ? [value.path] : [])),
  );
}

export function runInputFields(definition: Definition) {
  const paths = runInputPaths(definition.steps);
  return paths.length && paths.every(path => path.length === 1 && path[0])
    ? [...new Set(paths.map(path => path[0]!))]
    : null;
}

export function runInputExample(definition: Definition): Record<string, unknown> {
  const example = (paths: string[][]): Record<string, unknown> => {
    const keys = [...new Set(paths.flatMap(path => (path.length ? [path[0]!] : [])))];
    return Object.fromEntries(
      keys.map(key => {
        const children = paths.filter(path => path[0] === key && path.length > 1).map(path => path.slice(1));
        return [key, children.length ? example(children) : ''];
      }),
    );
  };
  return example(runInputPaths(definition.steps));
}
