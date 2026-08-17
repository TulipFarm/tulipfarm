import { isPinnedModelName, PINNED_MODELS, pinnedBinding } from "./model.ts";
import type { ModelBinding } from "./runner.ts";
import { scriptedBinding } from "./scripted.ts";

const MODEL_NAMES = Object.keys(PINNED_MODELS).join(", ");

/**
 * Turn a `--model` argument into the bindings a Sweep will measure.
 *
 * No argument at all means the free scripted tier, which is what keeps the whole framework
 * runnable by a contributor with no vendor seat.
 */
export function resolveBindings(spec: string | undefined): ModelBinding[] {
  if (spec === undefined) return [scriptedBinding()];

  const names = spec
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) throw new Error(`--model needs at least one name from: ${MODEL_NAMES}`);

  // Two columns for one model would look like a control while measuring nothing extra — and it
  // would spend the quota twice to say so.
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate !== undefined) throw new Error(`--model lists "${duplicate}" twice`);

  return names.map((name) => {
    if (!isPinnedModelName(name)) {
      throw new Error(`unknown model "${name}" — pinned models are: ${MODEL_NAMES}`);
    }
    return pinnedBinding(PINNED_MODELS[name]);
  });
}
